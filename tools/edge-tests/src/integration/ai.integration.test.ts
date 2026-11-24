/**
 * Asystent AI (v1.x) — Edge Function `ai` w prawdziwym Edge Runtime z fałszywym Gemini (`/gemini/v1beta/…`,
 * adres z `AI_TEST_GEMINI_BASE` w `.env.test`): podpięcie konta (klucz do Vault, oświadczenie o rozliczeniu),
 * „Sprawdź” (lista modeli, domyślny Flash-Lite, klucz tylko w nagłówku), wybór modelu z listy, zły klucz
 * (400 `INVALID_ARGUMENT` → stan `error`), przejściowa awaria (stan bez zmian), konto w `pull_changes` bez klucza,
 * cudze konto niedostępne, „Odłącz”.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeServices } from './fake-services.ts';
import { adminClient, createUser, fn, sql, type TestUser } from './helpers.ts';

const fake = new FakeServices();
const db = adminClient();
let user: TestUser;
let other: TestUser;
let accountId: string;

const call = async (path: string, who: TestUser | null, body: unknown) => {
  const res = await fn(`ai/${path}`, { ...(who && { jwt: who.jwt }), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const row = async () => (await db.from('ai_accounts').select('*').eq('id', accountId).single()).data as Record<string, unknown>;

beforeAll(async () => {
  await fake.start();
  user = await createUser('ai');
  other = await createUser('ai-inny');
});
afterAll(() => fake.stop());

describe('Edge Function ai — konto', () => {
  it('bez logowania 401, bez oświadczenia o rozliczeniu 400', async () => {
    expect((await call('accounts/create', null, { provider: 'gemini', key: fake.gemini.key, billingConfirmed: true })).status).toBe(401);
    const res = await call('accounts/create', user, { provider: 'gemini', key: fake.gemini.key, billingConfirmed: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('rozliczeniem');
  });

  it('podpięcie: klucz w Vault, w wierszu tylko końcówka; drugie konto tego dostawcy → 409', async () => {
    const res = await call('accounts/create', user, { provider: 'gemini', key: fake.gemini.key, billingConfirmed: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    accountId = res.body.accountId as string;
    const r = await row();
    expect(r).toMatchObject({ user_id: user.id, provider: 'gemini', status: 'unverified', model: null, key_hint: `…${fake.gemini.key.slice(-4)}` });
    expect(r.secret_id).toBeTruthy();
    expect(r.billing_confirmed_at).toBeTruthy();
    expect(sql(`select decrypted_secret = '${fake.gemini.key}' from vault.decrypted_secrets where name = 'ai_account:${accountId}'`)).toBe('t');
    expect(fake.gemini.requests).toHaveLength(0);

    expect((await call('accounts/create', user, { provider: 'gemini', key: fake.gemini.key, billingConfirmed: true })).status).toBe(409);
  });

  it('„Sprawdź”: modele tekstowe, domyślny Flash-Lite, konto aktywne; klucz tylko w nagłówku', async () => {
    const res = await call('accounts/test', user, { accountId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      models: [
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
        { id: 'gemini-3.5-flash-lite-preview', label: 'Gemini 3.5 Flash-Lite Preview' },
      ],
      model: 'gemini-3.5-flash-lite',
    });
    expect(await row()).toMatchObject({ status: 'active', model: 'gemini-3.5-flash-lite', last_error: null });
    expect((await row()).verified_at).toBeTruthy();
    expect(fake.gemini.requests).toEqual([{ method: 'GET', path: '/models', search: '?pageSize=200', key: fake.gemini.key }]);
  });

  it('konto w pull_changes bez klucza i bez secret_id; klient nie czyta secret_id', async () => {
    const { data, error } = await user.client.rpc('pull_changes', { p_since: {} });
    expect(error).toBeNull();
    const rows = data.tables.ai_accounts as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: accountId, provider: 'gemini', model: 'gemini-3.5-flash-lite', status: 'active', scope_id: user.id });
    expect(rows[0]).not.toHaveProperty('secret_id');
    expect(JSON.stringify(data)).not.toContain(fake.gemini.key);
    expect((await user.client.from('ai_accounts').select('secret_id')).error?.code).toBe('42501');
    expect((await user.client.from('ai_accounts').update({ model: 'gemini-3.8-flash' }).eq('id', accountId)).error?.code).toBe('42501');
  });

  it('wybór modelu tylko z listy', async () => {
    expect((await call('accounts/update', user, { accountId, model: 'gemini-3.8-flash' })).status).toBe(200);
    expect((await row()).model).toBe('gemini-3.8-flash');
    const res = await call('accounts/update', user, { accountId, model: 'gemini-9-zmyslony' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Sprawdź');
    // Ponowne „Sprawdź” zostawia wybrany model, bo nadal jest na liście.
    expect((await call('accounts/test', user, { accountId })).body.model).toBe('gemini-3.8-flash');
  });

  it('cudze konto: 404 dla testu, zmiany i odłączenia', async () => {
    for (const path of ['accounts/test', 'accounts/delete']) expect((await call(path, other, { accountId })).status).toBe(404);
    expect((await call('accounts/update', other, { accountId, model: 'gemini-3.5-flash-lite' })).status).toBe(404);
  });

  it('przejściowa awaria (503) nie psuje działającego konta', async () => {
    fake.gemini.status = 503;
    try {
      const res = await call('accounts/test', user, { accountId });
      expect(res.body).toMatchObject({ ok: false, badKey: false });
      expect(await row()).toMatchObject({ status: 'active', model: 'gemini-3.8-flash' });
      expect((await row()).last_error).toBeTruthy();
    } finally {
      fake.gemini.status = null;
    }
  });

  it('nowy klucz bez oświadczenia → 400; zły klucz → „Nieprawidłowy klucz”, stan error', async () => {
    const bad = `AQ.${'z'.repeat(50)}`;
    expect((await call('accounts/update', user, { accountId, key: bad })).status).toBe(400);
    expect((await call('accounts/update', user, { accountId, key: bad, billingConfirmed: true })).status).toBe(200);
    expect(await row()).toMatchObject({ status: 'unverified', key_hint: '…zzzz', verified_at: null });
    const res = await call('accounts/test', user, { accountId });
    expect(res.body).toEqual({ ok: false, error: 'Nieprawidłowy klucz Gemini — skopiuj go jeszcze raz w całości z AI Studio.', badKey: true });
    expect(await row()).toMatchObject({ status: 'error', last_error: 'Nieprawidłowy klucz Gemini — skopiuj go jeszcze raz w całości z AI Studio.' });
    expect(fake.gemini.requests.at(-1)?.key).toBe(bad);

    // Poprawny klucz z powrotem → działa.
    expect((await call('accounts/update', user, { accountId, key: fake.gemini.key, billingConfirmed: true })).status).toBe(200);
    expect((await call('accounts/test', user, { accountId })).body.ok).toBe(true);
    expect(fake.gemini.requests.every((r) => !r.search.includes('key='))).toBe(true);
  });

  it('„Odłącz”: klucz znika z Vault, wiersz z deleted_at wraca do klienta jako usunięcie', async () => {
    const before = (await user.client.rpc('pull_changes', { p_since: {} })).data.scopes[user.id].version as number;
    expect((await call('accounts/delete', user, { accountId })).status).toBe(200);
    const r = await row();
    expect(r.deleted_at).toBeTruthy();
    expect(r.secret_id).toBeNull();
    expect(sql(`select count(*) from vault.secrets where name = 'ai_account:${accountId}'`)).toBe('0');
    const { data } = await user.client.rpc('pull_changes', { p_since: { [user.id]: before } });
    expect(data.tables.ai_accounts).toEqual([expect.objectContaining({ id: accountId, deleted_at: expect.any(String) })]);
    expect((await call('accounts/test', user, { accountId })).status).toBe(404);
    // Po odłączeniu można podpiąć konto od nowa.
    expect((await call('accounts/create', user, { provider: 'gemini', key: fake.gemini.key, billingConfirmed: true })).status).toBe(200);
  });
});
