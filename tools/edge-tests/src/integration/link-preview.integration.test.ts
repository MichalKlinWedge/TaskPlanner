/**
 * Etap 10 — `link-preview` w prawdziwym Edge Runtime: tytuł strony z fałszywych usług
 * (`host.docker.internal` zwolniony przez `LINK_PREVIEW_TEST_HOSTS` z `.env.test`) i ochrona przed
 * SSRF — adresy prywatne, link-local (metadane chmury), `localhost`, przekierowania do nich i nazwy,
 * których DNS wskazuje adres prywatny, nigdy nie są pobierane.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeServices } from './fake-services.ts';
import { createUser, fn, measure, type TestUser } from './helpers.ts';

const fake = new FakeServices();
let user: TestUser;

const latin = (text: string) => Buffer.from(text, 'latin1');

beforeAll(async () => {
  await fake.start();
  user = await createUser('podglad');
  fake.pages.set('kot', {
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Zapas</title>
      <meta property="og:title" content="Kot domowy &#8211; Wikipedia"><meta name="description" content="Gatunek ssaka">
      <link rel="icon" href="/fav.png"></head><body>…</body></html>`,
  });
  // „Zażółć gęślą jaźń” w windows-1250.
  fake.pages.set('cp1250', {
    headers: { 'content-type': 'text/html; charset=windows-1250' },
    body: Buffer.concat([latin('<title>Za'), Buffer.from([0xbf, 0xf3, 0xb3, 0xe6]), latin(' g'), Buffer.from([0xea, 0x9c, 0x6c, 0xb9]), latin(' ja'), Buffer.from([0x9f, 0xf1]), latin('</title>')]),
  });
  fake.pages.set('przekierowanie', { status: 302, headers: { location: '/pages/kot' } });
  fake.pages.set('do-metadanych', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  fake.pages.set('do-localhost', { status: 301, headers: { location: 'http://localhost/' } });
  fake.pages.set('do-ipv6', { status: 307, headers: { location: 'http://[::1]/' } });
  fake.pages.set('do-nazwy-prywatnej', { status: 302, headers: { location: 'http://127.0.0.1.nip.io/' } });
  fake.pages.set('petla', { status: 302, headers: { location: '/pages/petla' } });
  fake.pages.set('wolna', { delayMs: 8_000, body: '<title>Za późno</title>' });
  fake.pages.set('duza', { body: `<title>Duża strona</title>${'x'.repeat(3 * 1024 * 1024)}` });
  fake.pages.set('pdf', { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' });
});
afterAll(() => fake.stop());

type Body = { ok?: boolean; preview?: Record<string, string>; error?: string };

async function preview(url: string, jwt: string | null = user.jwt): Promise<{ status: number; body: Body }> {
  const res = await fn('link-preview', { jwt: jwt ?? undefined, body: JSON.stringify({ url }) });
  return { status: res.status, body: (await res.json()) as Body };
}

describe('link-preview', () => {
  it('wymaga zalogowania', async () => {
    expect((await preview(fake.pageUrl('kot'), null)).status).toBe(401);
    expect((await preview(fake.pageUrl('kot'), 'zly-token')).status).toBe(401);
  });

  it('tytuł, opis i ikona strony; przekierowanie w obrębie hosta; windows-1250; inne typy', async () => {
    const started = Date.now();
    const kot = await preview(fake.pageUrl('kot'));
    measure('link-preview: strona → podgląd', Date.now() - started);
    expect(kot).toEqual({
      status: 200,
      body: { ok: true, preview: { title: 'Kot domowy – Wikipedia', description: 'Gatunek ssaka', siteName: 'host.docker.internal', icon: 'http://host.docker.internal:54590/fav.png' } },
    });
    expect((await preview(fake.pageUrl('przekierowanie'))).body.preview?.title).toBe('Kot domowy – Wikipedia');
    expect((await preview(fake.pageUrl('cp1250'))).body.preview?.title).toBe('Zażółć gęślą jaźń');
    expect((await preview(fake.pageUrl('pdf'))).body).toEqual({ ok: true, preview: { siteName: 'host.docker.internal' } });
  });

  it('adresy prywatne, lokalne i metadane chmury — odrzucone bez pobrania', async () => {
    for (const url of [
      'http://127.0.0.1:54521/rest/v1/',
      'http://localhost/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://10.0.0.1/',
      'http://host.docker.internal/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'file:///etc/passwd',
      'https://user:haslo@example.com/',
    ]) {
      const { status, body } = await preview(url);
      expect({ url, status, ok: body.ok }).toEqual({ url, status: 200, ok: false });
    }
  });

  it('przekierowanie do adresu prywatnego albo nazwy z prywatnym DNS — odrzucone', async () => {
    for (const name of ['do-metadanych', 'do-localhost', 'do-ipv6']) {
      const { body } = await preview(fake.pageUrl(name));
      expect({ name, ...body }).toMatchObject({ name, ok: false, error: expect.stringMatching(/prywatny|lokalny/) });
    }
    // `127.0.0.1.nip.io` → 127.0.0.1 w publicznym DNS (bez dostępu do DNS: nieznany host — też odmowa).
    expect((await preview(fake.pageUrl('do-nazwy-prywatnej'))).body).toMatchObject({ ok: false, error: expect.stringMatching(/prywatny|Nieznany host/) });
    expect((await preview(fake.pageUrl('petla'))).body).toMatchObject({ ok: false, error: 'Za dużo przekierowań' });
  });

  it('limit czasu i rozmiaru', async () => {
    const started = Date.now();
    const slow = await preview(fake.pageUrl('wolna'));
    expect(slow.body.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(7_500);
    expect((await preview(fake.pageUrl('duza'))).body).toMatchObject({ ok: true, preview: { title: 'Duża strona' } });
  });
});
