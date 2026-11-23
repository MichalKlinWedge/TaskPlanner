/**
 * Pluginy, etap I1 (M21) — Edge Function `plugins` w prawdziwym Edge Runtime z fałszywym odbiorcą webhooków
 * (`/hooks/<nazwa>`; `host.docker.internal` zwolniony przez `PLUGIN_TEST_HOSTS` z `.env.test`):
 * połączenia (sekret w Vault, tylko https, SSRF), „Wyślij próbne”, „Wyślij do…” zapisane przez `push_changes`
 * → wyzwalacz → `pg_net` → `plugins/flush` → dokładnie jedna podpisana wysyłka, ponowienia bez duplikatów,
 * wyłączenie połączenia po 401, „Ponów”, usunięcie połączenia; I2 — reguły zdarzeniowe; I3 — GitLab (fałszywy
 * GitLab pod `/gitlab/api/v4/…`: issue, powiązanie `plugin_links`, zamknięcie, notatka, ponowienie bez duplikatu);
 * zmiana zadania po udanej wysyłce (`options.afterSend`: tagi, status — bez pętli reguł).
 */
import { createHmac } from 'node:crypto';

import { requestDeliveryId, uuidv7 } from '@taskplanner/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeServices, type HookRequest } from './fake-services.ts';
import { adminClient, createTag, createUser, createWorkspace, fn, measure, sql, waitFor, type TestUser } from './helpers.ts';

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

describe('reguły zdarzeniowe (I2)', () => {
  /** Reguła zdarzeniowa przez `push_changes`. */
  const eventRule = (connectionId: string, events: string[], options: Record<string, unknown> = {}, filter?: unknown) =>
    rule(connectionId, { name: `Gdy ${events.join(', ')}`, trigger: { kind: 'event', events, ...(filter ? { filter } : {}) }, options, action: { message: '{{event}}: {{title}}' } });
  const deliveriesFor = async (ruleId: string) =>
    ((await db.from('plugin_deliveries').select('*').eq('rule_id', ruleId).order('created_at')).data ?? []) as Record<string, unknown>[];
  const newTask = async (title: string, extra: Record<string, unknown> = {}) => {
    const id = uuidv7();
    expect((await push(user, [{ table: 'tasks', id, set: { list_id: ws.inbox, title, ...extra } }])).rejected).toEqual([]);
    return id;
  };

  it('kryterium: zadanie z tagiem #zgłoś dodane offline (jedna paczka) → dokładnie jedna wysyłka < 1 min; powtórka paczki nic nie dubluje', async () => {
    const conn = await connect('zglos');
    const tag = uuidv7();
    await createTag(user, tag, `zgłoś-${tag.slice(-6)}`);
    const ruleId = await eventRule(conn, ['task.tagged'], {}, { tags: { ids: [tag], match: 'any' } });
    const id = uuidv7();
    // Paczka z outboxu telefonu po powrocie sieci: zadanie i jego tag w jednym push_changes.
    const ops = [
      { op: uuidv7(), hlc: hlc(), table: 'tasks', id, set: { list_id: ws.inbox, title: 'Ekspres przecieka' } },
      { op: uuidv7(), hlc: hlc(), table: 'task_tags', id: uuidv7(), set: { task_id: id, tag_id: tag } },
    ];
    const started = Date.now();
    expect((await pushRaw(user, ops)).rejected).toEqual([]);
    const [hook] = await waitFor(async () => (fake.hooksFor('zglos').length ? fake.hooksFor('zglos') : null), 60_000, 'wysyłka reguły zdarzeniowej', 250);
    const elapsed = Date.now() - started;
    measure('plugins: tag offline → odbiorca (opóźnienie 20 s)', elapsed);
    expect(elapsed).toBeLessThan(60_000);
    expect(elapsed).toBeGreaterThan(15_000);
    expect(JSON.parse(hook!.body)).toMatchObject({ event: 'task.tagged', events: ['task.tagged'], message: 'Dodany tag: Ekspres przecieka', task: { id, title: 'Ekspres przecieka' } });
    expect(header(hook!, 'x-taskplanner-event')).toBe('task.tagged');
    expect((await pushRaw(user, ops)).rejected).toEqual([]);
    await flush();
    await new Promise((r) => setTimeout(r, 3000));
    expect(fake.hooksFor('zglos')).toHaveLength(1);
    expect((await deliveriesFor(ruleId)).map((d) => d.status)).toEqual(['sent']);
  });

  it('ukończenie cofnięte w oknie opóźnienia → nic nie wychodzi (pominięte)', async () => {
    const conn = await connect('cofniete');
    const ruleId = await eventRule(conn, ['task.completed'], { delaySec: 3 });
    const id = await newTask('Do cofnięcia');
    await push(user, [{ table: 'tasks', id, set: { status: 'done', completed_at: new Date().toISOString() } }]);
    await new Promise((r) => setTimeout(r, 500));
    await push(user, [{ table: 'tasks', id, set: { status: 'todo', completed_at: null } }]);
    const [d] = await waitFor(async () => {
      const all = await deliveriesFor(ruleId);
      return all.length && all.every((x) => x.status !== 'pending' && x.status !== 'sending') ? all : null;
    }, 20_000, 'rozstrzygnięta wysyłka');
    expect(d).toMatchObject({ status: 'skipped', error: 'Zmiana cofnięta przed wysyłką', source: 'event' });
    expect(fake.hooksFor('cofniete')).toHaveLength(0);
  });

  it('zdarzenia z okna łączą się w jedną wysyłkę; potem nowe okno', async () => {
    const conn = await connect('okno');
    const tag = uuidv7();
    await createTag(user, tag, `okno-${tag.slice(-6)}`);
    const ruleId = await eventRule(conn, ['task.tagged', 'task.due_changed'], { delaySec: 3 });
    const id = await newTask('Łączenie');
    await push(user, [{ table: 'task_tags', id: uuidv7(), set: { task_id: id, tag_id: tag } }]);
    await push(user, [{ table: 'tasks', id, set: { due_date: '2026-12-01' } }]);
    const [hook] = await waitFor(async () => (fake.hooksFor('okno').length ? fake.hooksFor('okno') : null), 20_000, 'wysyłka okna');
    expect(JSON.parse(hook!.body)).toMatchObject({ events: ['task.tagged', 'task.due_changed'], task: { dueDate: '2026-12-01' } });
    await new Promise((r) => setTimeout(r, 1500));
    expect(fake.hooksFor('okno')).toHaveLength(1);
    await push(user, [{ table: 'tasks', id, set: { due_date: '2026-12-02' } }]);
    await waitFor(async () => fake.hooksFor('okno').length === 2, 20_000, 'druga wysyłka');
    expect(JSON.parse(fake.hooksFor('okno')[1]!.body).events).toEqual(['task.due_changed']);
    expect((await deliveriesFor(ruleId)).map((d) => d.status)).toEqual(['sent', 'sent']);
  });

  it('ukończenie wystąpienia serii i komentarz: dzień wystąpienia i treść w ładunku', async () => {
    const conn = await connect('seria');
    await eventRule(conn, ['task.completed', 'task.commented'], { delaySec: 2 });
    const id = await newTask('Podlać kwiaty', { due_date: '2026-11-23' });
    await push(user, [
      { table: 'task_completions', id: uuidv7(), set: { task_id: id, occurrence_date: '2026-11-23', kind: 'done', completed_at: new Date().toISOString() } },
      { table: 'tasks', id, set: { due_date: '2026-11-24' } },
      { table: 'task_comments', id: uuidv7(), set: { task_id: id, body: 'Podlane, ale liście żółkną', posted_at: new Date().toISOString() } },
    ]);
    const [hook] = await waitFor(async () => (fake.hooksFor('seria').length ? fake.hooksFor('seria') : null), 20_000, 'wysyłka serii');
    expect(JSON.parse(hook!.body)).toMatchObject({
      events: ['task.completed', 'task.commented'],
      occurrence: '2026-11-23',
      comment: { body: 'Podlane, ale liście żółkną' },
      task: { status: 'todo', dueDate: '2026-11-24' },
    });
  });

  it('zadanie z integracji (e-mail) pominięte; z opcją „także z integracji” — wysłane', async () => {
    const conn = await connect('integracja');
    const off = await eventRule(conn, ['task.created'], { delaySec: 1 });
    const on = await eventRule(conn, ['task.created'], { delaySec: 1, includeIntegrations: true });
    await newTask('Z maila', { source: { kind: 'email', from: 'ktos@example.com', subject: 'Z maila' } });
    await waitFor(async () => fake.hooksFor('integracja').length === 1, 20_000, 'wysyłka reguły z opcją');
    expect(JSON.parse(fake.hooksFor('integracja')[0]!.body).rule.id).toBe(on);
    await waitFor(async () => (await deliveriesFor(off))[0]?.status === 'skipped', 10_000, 'pominięta bez opcji');
    expect((await deliveriesFor(off))[0]!.error).toMatch(/^Zadanie z integracji/);
  });
});

describe('GitLab (I3)', () => {
  const connectGitlab = async (token = fake.gitlab.token) => {
    const res = await fn('plugins/connections/create', {
      jwt: user.jwt,
      body: JSON.stringify({ plugin: 'gitlab', label: 'GitLab', config: { baseUrl: fake.gitlabUrl(), project: fake.gitlab.path }, secrets: { token } }),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.connectionId as string;
  };
  const issueOf = (taskId: string) => fake.gitlab.issues.filter((i) => i.description.includes(taskId));

  it('„Wyślij próbne” sprawdza projekt i token', async () => {
    const id = await connectGitlab();
    expect(await (await fn('plugins/test', { jwt: user.jwt, body: JSON.stringify({ connectionId: id }) })).json()).toEqual({ ok: true, httpStatus: 200 });
    const bad = await connectGitlab('zly-token-123');
    expect(await (await fn('plugins/test', { jwt: user.jwt, body: JSON.stringify({ connectionId: bad }) })).json()).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it('reguła zdarzeniowa: nowe zadanie → jedno issue z powiązaniem; ukończenie zamyka to samo issue, komentarz = notatka', async () => {
    const conn = await connectGitlab();
    const ruleId = await rule(conn, {
      name: 'Do GitLaba',
      trigger: { kind: 'event', events: ['task.created', 'task.completed', 'task.commented'] },
      options: { delaySec: 1 },
      action: { labels: 'task-planner, {{priority}}', assignees: '@jan.kowalski' },
    });
    const id = uuidv7();
    expect((await push(user, [{ table: 'tasks', id, set: { list_id: ws.inbox, title: 'Serwer nie wstaje', description_md: 'Po aktualizacji jądra.', due_date: '2026-12-01' } }])).rejected).toEqual([]);
    const [issue] = await waitFor(async () => (issueOf(id).length ? issueOf(id) : null), 20_000, 'issue w GitLabie');
    expect(issue).toMatchObject({ title: 'Serwer nie wstaje', labels: ['task-planner', 'Niski'], due_date: '2026-12-01', assignee_ids: [501], state: 'opened' });
    expect(issue!.description).toContain('Po aktualizacji jądra.');
    expect(issue!.description).toContain(`?task=${id}`);
    const { data: link } = await db.from('plugin_links').select('external_id, external_url').eq('connection_id', conn).eq('task_id', id).single();
    expect(link).toEqual({ external_id: `77:${issue!.iid}`, external_url: issue!.web_url });
    const { data: own } = await user.client.from('plugin_links').select('external_url').eq('task_id', id);
    expect(own).toEqual([{ external_url: issue!.web_url }]);

    await push(user, [
      { table: 'tasks', id, set: { status: 'done', completed_at: new Date().toISOString() } },
      { table: 'task_comments', id: uuidv7(), set: { task_id: id, body: 'Pomógł restart', posted_at: new Date().toISOString() } },
    ]);
    await waitFor(async () => issue!.state === 'closed' && issue!.notes.length === 1, 20_000, 'zamknięte issue z notatką');
    expect(issue!.notes[0]).toMatch(/^Pomógł restart/);
    expect(issueOf(id)).toHaveLength(1);
    const deliveries = ((await db.from('plugin_deliveries').select('status, external_url').eq('rule_id', ruleId).order('created_at')).data ?? []) as Record<string, unknown>[];
    expect(deliveries).toEqual([
      { status: 'sent', external_url: issue!.web_url },
      { status: 'sent', external_url: issue!.web_url },
    ]);
  });

  it('„Wyślij do…” ponownie aktualizuje to samo issue; GitLab 503 → ponowienie bez drugiego issue', async () => {
    const conn = await connectGitlab();
    const ruleId = await rule(conn, { name: 'Issue ręcznie', action: { title: '[TP] {{title}}' } });
    const id = uuidv7();
    expect((await push(user, [{ table: 'tasks', id, set: { list_id: ws.inbox, title: 'Faktura' } }])).rejected).toEqual([]);
    const sendTask = async () => {
      const op = { table: 'plugin_requests', id: uuidv7(), set: { rule_id: ruleId, task_id: id, requested_at: new Date().toISOString() } };
      expect((await push(user, [op])).rejected).toEqual([]);
      return requestDeliveryId(ruleId, op.id);
    };
    const first = await sendTask();
    await waitFor(async () => (await delivery(first))?.status === 'sent', 20_000, 'pierwsze issue');
    expect(issueOf(id).map((i) => i.title)).toEqual(['[TP] Faktura']);

    await push(user, [{ table: 'tasks', id, set: { title: 'Faktura VAT' } }]);
    fake.gitlab.status = 503;
    const second = await sendTask();
    await waitFor(async () => (await delivery(second))?.attempts === 1 && (await delivery(second))?.status === 'pending', 20_000, 'nieudana próba');
    fake.gitlab.status = null;
    await db.from('plugin_deliveries').update({ next_attempt_at: new Date().toISOString() }).eq('id', second);
    await flush();
    await waitFor(async () => (await delivery(second))?.status === 'sent', 20_000, 'ponowienie');
    expect(issueOf(id).map((i) => i.title)).toEqual(['[TP] Faktura VAT']);
  });
});

describe('po udanej wysyłce', () => {
  const taskState = async (id: string) => {
    const { data: t } = await db.from('tasks').select('status, completed_at').eq('id', id).single();
    const { data: tags } = await db.from('task_tags').select('tag_id').eq('task_id', id).is('deleted_at', null);
    return { status: t!.status as string, done: !!t!.completed_at, tags: (tags ?? []).map((r) => r.tag_id as string).sort() };
  };

  it('reguła „dodany tag”: zdejmuje #zgłoś, dodaje #wysłane i ustawia status — sama się drugi raz nie wywołuje', async () => {
    const conn = await connect('po-wysylce');
    const [report, sent] = [uuidv7(), uuidv7()];
    await createTag(user, report, `zgłoś-${report.slice(-6)}`);
    await createTag(user, sent, `wysłane-${sent.slice(-6)}`);
    const ruleId = await rule(conn, {
      name: 'Zgłoś i oznacz',
      trigger: { kind: 'event', events: ['task.tagged'] },
      options: { delaySec: 1, afterSend: { addTagIds: [sent], removeTagIds: [report], status: 'waiting' } },
    });
    const id = uuidv7();
    expect((await pushRaw(user, [
      { op: uuidv7(), hlc: hlc(), table: 'tasks', id, set: { list_id: ws.inbox, title: 'Pralka cieknie' } },
      { op: uuidv7(), hlc: hlc(), table: 'task_tags', id: uuidv7(), set: { task_id: id, tag_id: report } },
    ])).rejected).toEqual([]);
    await waitFor(async () => (await taskState(id)).status === 'waiting', 30_000, 'zmiana po wysyłce');
    expect(await taskState(id)).toEqual({ status: 'waiting', done: false, tags: [sent] });
    expect(fake.hooksFor('po-wysylce')).toHaveLength(1);
    // Zmiana „z integracji” — ta sama reguła na „dodany tag” jej nie łapie.
    await flush();
    await new Promise((r) => setTimeout(r, 4000));
    const deliveries = ((await db.from('plugin_deliveries').select('status, error').eq('rule_id', ruleId)).data ?? []) as Record<string, unknown>[];
    expect(deliveries).toEqual([{ status: 'sent', error: null }]);
    // Klient dostaje zmianę serwera jak z innego urządzenia.
    const { data: pulled } = await user.client.rpc('pull_changes', { p_since: {} });
    expect(pulled.tables.tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ status: 'waiting' });
  });

  it('„Wyślij do…” zadania cyklicznego ze statusem Gotowe: wysłane, seria otwarta, uwaga w historii', async () => {
    const conn = await connect('po-wysylce-seria');
    const ruleId = await rule(conn, { name: 'Zamknij', options: { afterSend: { status: 'done' } } });
    const id = uuidv7();
    expect((await push(user, [{ table: 'tasks', id, set: { list_id: ws.inbox, title: 'Podlać kwiaty', due_date: '2026-11-24', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-24' } } }])).rejected).toEqual([]);
    const op = { op: uuidv7(), hlc: hlc(), table: 'plugin_requests', id: uuidv7(), set: { rule_id: ruleId, task_id: id, requested_at: new Date().toISOString() } };
    expect((await pushRaw(user, [op])).rejected).toEqual([]);
    const deliveryId = requestDeliveryId(ruleId, op.id);
    await waitFor(async () => (await delivery(deliveryId))?.status === 'sent', 20_000, 'wysłane');
    expect((await delivery(deliveryId))?.error).toBe('Po wysyłce: status serii bez zmian (ukończ ją w aplikacji)');
    expect((await taskState(id)).status).toBe('todo');
  });
});
