/**
 * Pluginy, etap I1 (M21) — Edge Function `plugins` w prawdziwym Edge Runtime z fałszywym odbiorcą webhooków
 * (`/hooks/<nazwa>`; `host.docker.internal` zwolniony przez `PLUGIN_TEST_HOSTS` z `.env.test`):
 * połączenia (sekret w Vault, tylko https, SSRF), „Wyślij próbne”, „Wyślij do…” zapisane przez `push_changes`
 * → wyzwalacz → `pg_net` → `plugins/flush` → dokładnie jedna podpisana wysyłka, ponowienia bez duplikatów,
 * wyłączenie połączenia po 401, „Ponów”, usunięcie połączenia.
 */
import { createHmac } from 'node:crypto';

import { requestDeliveryId, uuidv7 } from '@taskplanner/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeServices, type HookRequest } from './fake-services.ts';
import { adminClient, createUser, createWorkspace, fn, measure, sql, waitFor, type TestUser } from './helpers.ts';

const fake = new FakeServices();
const db = adminClient();
const SECRET = 'sekret-podpisu-testowy-0123456789';
let user: TestUser;
let ws: Awaited<ReturnType<typeof createWorkspace>>;
let task: string;

let counter = 0;
const hlc = () => `${String(Date.now()).padStart(15, '0')}:${String(++counter % 100000).padStart(5, '0')}:i1dev`;
type Op = { table: string; id: string; set: Record<string, unknown> };
async function push(who: TestUser, ops: Op[]) {
  return pushRaw(who, ops.map((o) => ({ op: uuidv7(), hlc: hlc(), ...o })));
}
async function pushRaw(who: TestUser, ops: (Op & { op: string; hlc: string })[]) {
  const { data, error } = await who.client.rpc('push_changes', { p_ops: ops });
  if (error) throw new Error(`push_changes: ${error.message}`);
  return data as { applied: number; rejected: { code: string; message: string }[] };
}

async function connect(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fn('plugins/connections/create', {
    jwt: user.jwt,
    body: JSON.stringify({ plugin: 'webhook', label: `Hook ${name}`, config: { url: fake.hookUrl(name) }, secrets: { signingSecret: SECRET }, ...extra }),
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.connectionId as string;
}

async function rule(connectionId: string, patch: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  const result = await push(user, [{
    table: 'plugin_rules',
    id,
    set: { name: 'Do odbiorcy', connection_id: connectionId, enabled: true, trigger: { kind: 'manual' }, action: { message: 'Zgłoszenie: {{title}} ({{priority}}) {{url}}' }, options: {}, sort_key: 'n', ...patch },
  }]);
  expect(result.rejected).toEqual([]);
  return id;
}

/** „Wyślij do…” jak klient: wiersz `plugin_requests` przez `push_changes` (zwraca też operację do powtórki). */
async function sendOp(ruleId: string) {
  const op = { op: uuidv7(), hlc: hlc(), table: 'plugin_requests', id: uuidv7(), set: { rule_id: ruleId, task_id: task, requested_at: new Date().toISOString() } };
  const result = await pushRaw(user, [op]);
  expect(result.rejected).toEqual([]);
  return op;
}
const send = async (ruleId: string) => (await sendOp(ruleId)).id;

const delivery = async (id: string) => (await db.from('plugin_deliveries').select('*').eq('id', id).maybeSingle()).data as Record<string, unknown> | null;
const flush = () => fn('plugins/flush', { cron: true, body: '{}' });
const header = (h: HookRequest, name: string) => String(h.headers[name] ?? '');

beforeAll(async () => {
  await fake.start();
  user = await createUser('pluginy');
  ws = await createWorkspace(user, 'Praca');
  task = uuidv7();
  const result = await push(user, [{ table: 'tasks', id: task, set: { list_id: ws.inbox, title: 'Drukarka nie drukuje', priority: 2, due_date: '2026-11-24' } }]);
  expect(result.rejected).toEqual([]);
});
afterAll(() => fake.stop());

describe('połączenia', () => {
  it('nowe połączenie: sekret w Vault, klient widzi je bez sekretu (także w pull_changes)', async () => {
    const id = await connect('polaczenie');
    const { data: row } = await db.from('plugin_connections').select('*').eq('id', id).single();
    expect(row).toMatchObject({ user_id: user.id, plugin: 'webhook', label: 'Hook polaczenie', status: 'active', config: { url: fake.hookUrl('polaczenie') } });
    expect(row.secret_id).toBeTruthy();
    expect(JSON.stringify(row.config)).not.toContain(SECRET);
    const { data: own } = await user.client.from('plugin_connections').select('id, label, config, status');
    expect(own).toEqual([{ id, label: 'Hook polaczenie', config: { url: fake.hookUrl('polaczenie') }, status: 'active' }]);
    const { data: pulled } = await user.client.rpc('pull_changes', { p_since: {} });
    expect(pulled.tables.plugin_connections.map((c: { id: string }) => c.id)).toContain(id);
    expect(JSON.stringify(pulled.tables.plugin_connections)).not.toContain(SECRET);
  });

  it('tylko https i adresy publiczne; bez logowania — odmowa', async () => {
    const create = (url: string, jwt: string | undefined = user.jwt) =>
      fn('plugins/connections/create', { jwt, body: JSON.stringify({ plugin: 'webhook', label: 'Zły', config: { url }, secrets: { signingSecret: SECRET } }) });
    for (const url of ['http://example.com/hook', 'https://10.0.0.5/hook', 'https://localhost/hook', 'https://169.254.169.254/latest']) {
      const res = await create(url);
      expect(res.status, url).toBe(400);
      expect((await res.json()).error, url).toMatch(/^Adres niedozwolony/);
    }
    expect((await fn('plugins/connections/create', { jwt: user.jwt, body: JSON.stringify({ plugin: 'webhook', label: 'x', config: { url: 'https://example.com' }, secrets: { signingSecret: 'krótki' } }) })).status).toBe(400);
    expect((await create('https://example.com/hook', '')).status).toBe(401);
    expect((await fn('plugins/cron/tick', { body: '{}' })).status).toBe(401);
  });

  it('„Wyślij próbne”: podpisany JSON dociera do odbiorcy', async () => {
    const id = await connect('probne');
    const res = await fn('plugins/test', { jwt: user.jwt, body: JSON.stringify({ connectionId: id }) });
    expect(await res.json()).toEqual({ ok: true, httpStatus: 200 });
    const [hook] = fake.hooksFor('probne');
    expect(hook).toBeDefined();
    expect(header(hook!, 'x-taskplanner-event')).toBe('test');
    const mac = createHmac('sha256', SECRET).update(`${header(hook!, 'x-taskplanner-timestamp')}.${hook!.body}`).digest('hex');
    expect(header(hook!, 'x-taskplanner-signature')).toBe(`sha256=${mac}`);
    expect(JSON.parse(hook!.body)).toMatchObject({ test: true, task: { title: 'Przykładowe zadanie z Task Plannera' } });
  });
});

describe('„Wyślij do…”', () => {
  it('prośba z push_changes → dokładnie jedna podpisana wysyłka; powtórki nic nie podwajają', async () => {
    const conn = await connect('reczne');
    const ruleId = await rule(conn);
    const started = Date.now();
    const op = await sendOp(ruleId);
    const requestId = op.id;
    const [hook] = await waitFor(async () => (fake.hooksFor('reczne').length ? fake.hooksFor('reczne') : null), 20_000, 'wysyłka do odbiorcy');
    measure('plugins: „Wyślij do…” → odbiorca', Date.now() - started);
    const id = requestDeliveryId(ruleId, requestId);
    expect(header(hook!, 'idempotency-key')).toBe(id);
    expect(header(hook!, 'x-taskplanner-event')).toBe('task.sent');
    const mac = createHmac('sha256', SECRET).update(`${header(hook!, 'x-taskplanner-timestamp')}.${hook!.body}`).digest('hex');
    expect(header(hook!, 'x-taskplanner-signature')).toBe(`sha256=${mac}`);
    const body = JSON.parse(hook!.body);
    expect(body).toMatchObject({
      id,
      event: 'task.sent',
      events: ['task.sent'],
      rule: { id: ruleId, name: 'Do odbiorcy' },
      task: { id: task, title: 'Drukarka nie drukuje', priority: 2, dueDate: '2026-11-24', list: { id: ws.inbox, name: 'Inbox' }, workspace: { id: ws.id, name: 'Praca' }, url: `https://app.taskplanner.test/?task=${task}` },
      message: `Zgłoszenie: Drukarka nie drukuje (Wysoki) https://app.taskplanner.test/?task=${task}`,
    });
    await waitFor(async () => (await delivery(id))?.status === 'sent', 5_000, 'stan wysłane');
    expect(await delivery(id)).toMatchObject({ user_id: user.id, rule_id: ruleId, connection_id: conn, task_id: task, source: 'manual', attempts: 1, http_status: 200 });

    // Ta sama operacja jeszcze raz (powtórka z outboxu klienta) i ręczne flush — nadal jedna wysyłka.
    expect((await pushRaw(user, [op])).rejected).toEqual([]);
    await flush();
    await new Promise((r) => setTimeout(r, 1500));
    expect(fake.hooksFor('reczne')).toHaveLength(1);
  });

  it('odbiorca niedostępny: ponowienia z tym samym Idempotency-Key, potem wysłane — bez duplikatów', async () => {
    const conn = await connect('awaria');
    const ruleId = await rule(conn);
    fake.hookReplies.set('awaria', { status: 503 });
    const id = requestDeliveryId(ruleId, await send(ruleId));
    const first = await waitFor(async () => {
      const d = await delivery(id);
      return d?.status === 'pending' && d.attempts === 1 ? d : null;
    }, 20_000, 'pierwsza nieudana próba');
    expect(first.error).toBe('Odbiorca odpowiedział 503: {"ok":false}');
    const wait = Date.parse(String(first.next_attempt_at)) - Date.now();
    expect(wait).toBeGreaterThan(40_000);
    expect(wait).toBeLessThan(65_000);

    // „Minęła” minuta: odbiorca dalej nie działa — druga próba, odstęp 5 min.
    await db.from('plugin_deliveries').update({ next_attempt_at: new Date().toISOString() }).eq('id', id);
    await flush();
    const second = await waitFor(async () => {
      const d = await delivery(id);
      return d?.attempts === 2 && d.status === 'pending' ? d : null;
    }, 10_000, 'druga próba');
    expect(Date.parse(String(second.next_attempt_at)) - Date.now()).toBeGreaterThan(240_000);

    // Odbiorca wraca; kolejny przebieg (cron) wysyła zaległą wysyłkę.
    fake.hookReplies.set('awaria', { status: 200 });
    await db.from('plugin_deliveries').update({ next_attempt_at: new Date().toISOString() }).eq('id', id);
    expect((await fn('plugins/cron/tick', { cron: true, body: '{}' })).status).toBe(200);
    await waitFor(async () => (await delivery(id))?.status === 'sent', 10_000, 'wysłane po powrocie odbiorcy');
    const hooks = fake.hooksFor('awaria');
    expect(hooks.map((h) => h.status)).toEqual([503, 503, 200]);
    expect(new Set(hooks.map((h) => header(h, 'idempotency-key')))).toEqual(new Set([id]));
  });

  it('401 wyłącza połączenie; nowy sekret je włącza; błąd 4xx bez ponowień, „Ponów” wysyła jeszcze raz', async () => {
    const conn = await connect('odmowa');
    const ruleId = await rule(conn);
    fake.hookReplies.set('odmowa', { status: 401 });
    const id = requestDeliveryId(ruleId, await send(ruleId));
    await waitFor(async () => (await delivery(id))?.status === 'failed', 20_000, 'błąd 401');
    const { data: off } = await db.from('plugin_connections').select('status, last_error').eq('id', conn).single();
    expect(off).toEqual({ status: 'error', last_error: 'Odbiorca odpowiedział 401: {"ok":false} — połączenie wyłączone' });

    // Wyłączone połączenie: nowa prośba zostaje pominięta (bez wysyłki).
    const skipped = requestDeliveryId(ruleId, await send(ruleId));
    await waitFor(async () => (await delivery(skipped))?.status === 'skipped', 20_000, 'pominięta');
    expect((await delivery(skipped))?.error).toBe('Połączenie „Hook odmowa” jest wyłączone');
    expect(fake.hooksFor('odmowa')).toHaveLength(1);

    const res = await fn('plugins/connections/update', { jwt: user.jwt, body: JSON.stringify({ connectionId: conn, secrets: { signingSecret: `${SECRET}-nowy` } }) });
    expect(res.status).toBe(200);
    expect((await db.from('plugin_connections').select('status, last_error').eq('id', conn).single()).data).toEqual({ status: 'active', last_error: null });

    // 422 = błąd bez ponowień; użytkownik poprawia odbiorcę i klika „Ponów”.
    fake.hookReplies.set('odmowa', { status: 422, body: 'brak pola' });
    const bad = requestDeliveryId(ruleId, await send(ruleId));
    await waitFor(async () => (await delivery(bad))?.status === 'failed', 20_000, 'błąd 422');
    expect((await delivery(bad))?.error).toBe('Odbiorca odpowiedział 422: brak pola');
    fake.hookReplies.set('odmowa', { status: 200 });
    const { error } = await user.client.rpc('retry_plugin_delivery', { p_delivery: bad });
    expect(error).toBeNull();
    await waitFor(async () => (await delivery(bad))?.status === 'sent', 20_000, 'wysłane po „Ponów”');
    const last = fake.hooksFor('odmowa').at(-1)!;
    const mac = createHmac('sha256', `${SECRET}-nowy`).update(`${header(last, 'x-taskplanner-timestamp')}.${last.body}`).digest('hex');
    expect(header(last, 'x-taskplanner-signature')).toBe(`sha256=${mac}`);
  });

  it('reguła wyłączona albo bez dostępu do zadania — pominięte; obca reguła i zadanie odrzucone przy zapisie', async () => {
    const conn = await connect('pominiete');
    const ruleId = await rule(conn, { enabled: false });
    const id = requestDeliveryId(ruleId, await send(ruleId));
    await waitFor(async () => (await delivery(id))?.status === 'skipped', 20_000, 'reguła wyłączona');
    expect((await delivery(id))?.error).toBe('Reguła wyłączona');
    expect(fake.hooksFor('pominiete')).toHaveLength(0);

    const other = await createUser('pluginy-obcy');
    const result = await push(other, [{ table: 'plugin_requests', id: uuidv7(), set: { rule_id: ruleId, task_id: task, requested_at: new Date().toISOString() } }]);
    expect(result.rejected[0]?.code).toBe('TP003');
  });

  it('usunięcie połączenia: sekret znika z Vault, wiersz z deleted_at, wysyłki pominięte', async () => {
    const conn = await connect('usuniete');
    const ruleId = await rule(conn);
    const res = await fn('plugins/connections/delete', { jwt: user.jwt, body: JSON.stringify({ connectionId: conn }) });
    expect(res.status).toBe(200);
    const { data: row } = await db.from('plugin_connections').select('deleted_at, secret_id, status').eq('id', conn).single();
    expect(row!.deleted_at).toBeTruthy();
    expect(row!.secret_id).toBeNull();
    expect(sql(`select count(*) from vault.secrets where name = 'plugin_connection:${conn}'`)).toBe('0');
    const id = requestDeliveryId(ruleId, await send(ruleId));
    await waitFor(async () => (await delivery(id))?.status === 'skipped', 20_000, 'pominięta po usunięciu');
    expect((await delivery(id))?.error).toBe('Połączenie usunięte');
    const { data: own } = await user.client.from('plugin_deliveries').select('id').eq('id', id);
    expect(own).toHaveLength(1);
  });
});
