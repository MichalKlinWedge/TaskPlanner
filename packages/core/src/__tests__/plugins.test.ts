import { describe, expect, it } from 'vitest';

import { PLUGIN_EVENT } from '../labels.ts';
import {
  deliveryId,
  generateSecret,
  MAX_DELIVERY_ATTEMPTS,
  parsePluginConnection,
  parsePluginRule,
  PLUGINS,
  pluginDef,
  pluginEvents,
  pluginPayload,
  pluginRequestOps,
  pluginRuleDeleteOps,
  pluginRuleSaveOps,
  renderTemplate,
  requestDeliveryId,
  retryDelaySec,
  ruleMatches,
  SAMPLE_TASK,
  sendableRules,
  taskUrl,
  templateValues,
  unknownTemplateFields,
  type PluginConnection,
  type PluginRule,
  type PluginTaskState,
} from '../plugins/index.ts';
import { MODEL } from '../schemas/model.ts';
import type { ViewTask } from '../views.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '01900000-0000-7000-8000-000000000001';
const LIST = '01900000-0000-7000-8000-0000000000a1';
const WS = '01900000-0000-7000-8000-0000000000b1';
const TAG = '01900000-0000-7000-8000-0000000000c1';
const CONN = '01900000-0000-7000-8000-0000000000d1';

const state = (patch: Partial<PluginTaskState> = {}): PluginTaskState => ({
  status: 'todo',
  deletedAt: null,
  listId: LIST,
  workspaceId: WS,
  tagIds: [],
  dueDate: null,
  dueTime: null,
  assigneeId: null,
  ...patch,
});

describe('pluginEvents — zdarzenia z przejścia stanu', () => {
  it('nowe zadanie; nowe w koszu — nic', () => {
    expect(pluginEvents(null, state())).toEqual(['task.created']);
    expect(pluginEvents(null, state({ deletedAt: '2026-11-23T10:00:00Z' }))).toEqual([]);
    expect(pluginEvents(state(), null)).toEqual([]);
  });

  it('ukończenie, wznowienie; anulowanie to nie ukończenie', () => {
    expect(pluginEvents(state(), state({ status: 'done' }))).toEqual(['task.completed']);
    expect(pluginEvents(state({ status: 'done' }), state({ status: 'todo' }))).toEqual(['task.reopened']);
    expect(pluginEvents(state(), state({ status: 'cancelled' }))).toEqual([]);
    expect(pluginEvents(state({ status: 'cancelled' }), state({ status: 'done' }))).toEqual(['task.completed']);
    expect(pluginEvents(state(), state({ status: 'in_progress' }))).toEqual([]);
  });

  it('kosz: tylko „usunięte”; zmiany w koszu — nic; przywrócenie razem z innymi zmianami', () => {
    const del = '2026-11-23T10:00:00Z';
    expect(pluginEvents(state(), state({ deletedAt: del, status: 'done', tagIds: [TAG] }))).toEqual(['task.deleted']);
    expect(pluginEvents(state({ deletedAt: del }), state({ deletedAt: del, status: 'done' }))).toEqual([]);
    expect(pluginEvents(state({ deletedAt: del }), state({ dueDate: '2026-11-24' }))).toEqual(['task.restored', 'task.due_changed']);
  });

  it('przeniesienie, tagi, termin, odpowiedzialny — w stałej kolejności', () => {
    const after = state({ listId: 'inna', tagIds: [TAG], dueTime: '09:00', assigneeId: 'osoba', status: 'done' });
    expect(pluginEvents(state(), after)).toEqual(['task.completed', 'task.moved', 'task.tagged', 'task.due_changed', 'task.assigned']);
    expect(pluginEvents(state({ tagIds: [TAG, 'b'] }), state({ tagIds: ['b', 'c'] }))).toEqual(['task.tagged', 'task.untagged']);
    expect(pluginEvents(state({ tagIds: [TAG, 'b'] }), state({ tagIds: ['b', TAG] }))).toEqual([]);
  });

  it('każde zdarzenie ma etykietę', () => {
    for (const e of Object.keys(PLUGIN_EVENT)) expect(PLUGIN_EVENT[e as keyof typeof PLUGIN_EVENT]).toBeTruthy();
  });
});

describe('renderTemplate', () => {
  it('pola, odstępy w nawiasach, brak wartości = pusto, nieznane pole zostaje', () => {
    expect(renderTemplate('{{title}} — {{ due }} {{time}}! {{nieznane}}', { title: 'Raport', due: '2026-11-24' })).toBe('Raport — 2026-11-24 ! {{nieznane}}');
    expect(unknownTemplateFields('{{title}} {{x}} {{ x }} {{url}}')).toEqual(['x']);
  });

  it('ucieczka według celu', () => {
    const v = { title: 'A "b" <c> *d* & e\n' };
    expect(renderTemplate('{{title}}', v, 'json')).toBe('A \\"b\\" <c> *d* & e\\n');
    expect(renderTemplate('{{title}}', v, 'markdown')).toBe('A "b" \\<c\\> \\*d\\* & e\n');
    expect(renderTemplate('{{title}}', v, 'slack')).toBe('A "b" &lt;c&gt; *d* &amp; e\n');
    // Ucieczka nie dotyka tekstu szablonu, tylko wartości.
    expect(renderTemplate('*{{title}}*', { title: 'x_y' }, 'markdown')).toBe('*x\\_y*');
  });

  it('wartości z rzutu zadania', () => {
    const values = templateValues(SAMPLE_TASK, { event: 'task.sent', url: 'https://app/?task=1' });
    expect(values).toMatchObject({ title: SAMPLE_TASK.title, due: '2026-11-24', time: '09:30', priority: 'Wysoki', status: 'Do zrobienia', list: 'Inbox', workspace: 'Praca', tags: 'zgłoś', assignee: '', event: 'Wysłane ręcznie' });
    expect(renderTemplate('{{title}} ({{priority}}) — {{url}}', values)).toBe('Przykładowe zadanie z Task Plannera (Wysoki) — https://app/?task=1');
  });
});

describe('ładunek i wysyłki', () => {
  it('ładunek: zadanie z linkiem, treść tylko gdy jest, długi opis ucięty', () => {
    const payload = pluginPayload({
      id: 'd1',
      events: ['task.sent'],
      sentAt: '2026-11-23T10:00:00.000Z',
      rule: { id: 'r', name: 'Do n8n' },
      task: { ...SAMPLE_TASK, description: 'x'.repeat(20_000) },
      appUrl: 'https://app.example/',
      message: '',
    });
    expect(payload.event).toBe('task.sent');
    expect(payload.task.url).toBe(`https://app.example/?task=${SAMPLE_TASK.id}`);
    expect(payload.task.list).toEqual({ id: SAMPLE_TASK.listId, name: 'Inbox' });
    expect(payload.task.description).toHaveLength(10_000);
    expect('message' in payload).toBe(false);
    expect(pluginPayload({ id: 'd', events: ['task.completed'], sentAt: 'x', rule: null, task: SAMPLE_TASK, appUrl: 'a', message: 'hej' }).message).toBe('hej');
    expect(taskUrl('https://a//', 'x')).toBe('https://a/?task=x');
  });

  it('id wysyłki deterministyczne (Idempotency-Key)', () => {
    expect(requestDeliveryId('r1', 'q1')).toBe(requestDeliveryId('r1', 'q1'));
    expect(requestDeliveryId('r1', 'q1')).not.toBe(requestDeliveryId('r2', 'q1'));
    expect(deliveryId('r1', 'request:q1')).toBe(requestDeliveryId('r1', 'q1'));
    expect(requestDeliveryId('r1', 'q1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
  });

  it('ponowienia: 1 min, 5 min, 30 min, 2 h, 12 h, potem koniec; Retry-After tylko wydłuża', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelaySec(n))).toEqual([60, 300, 1800, 7200, 43_200]);
    expect(retryDelaySec(MAX_DELIVERY_ATTEMPTS)).toBeNull();
    expect(retryDelaySec(1, 10)).toBe(60);
    expect(retryDelaySec(1, 600)).toBe(600);
    expect(retryDelaySec(1, 10_000_000)).toBe(43_200);
  });
});

describe('katalog', () => {
  it('Webhook: adres http(s) bez danych logowania, sekret ≥ 16 znaków, treść opcjonalna', () => {
    const def = pluginDef('webhook')!;
    expect(def).toBe(PLUGINS.webhook);
    expect(def.configSchema.safeParse({ url: 'https://n8n.example.com/webhook/x' }).success).toBe(true);
    expect(def.configSchema.safeParse({ url: 'ftp://x' }).success).toBe(false);
    expect(def.configSchema.safeParse({ url: 'https://u:p@x.com' }).success).toBe(false);
    expect(def.secretSchema.safeParse({ signingSecret: 'krótki' }).success).toBe(false);
    expect(def.secretSchema.safeParse({ signingSecret: generateSecret() }).success).toBe(true);
    expect(def.actionSchema.safeParse({}).success).toBe(true);
    expect(pluginDef('slack')).toBeNull();
  });

  it('wygenerowany sekret: 43 znaki base64url, za każdym razem inny', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(a);
  });
});

describe('reguły', () => {
  const connection: PluginConnection = { id: CONN, plugin: 'webhook', label: 'n8n', config: { url: 'https://x.y' }, status: 'active', lastError: null, lastUsedAt: null };
  const manual = (id: string, patch: Partial<PluginRule> = {}): PluginRule => ({
    id,
    name: id,
    connectionId: CONN,
    enabled: true,
    trigger: { kind: 'manual' },
    action: {},
    options: {},
    sortKey: 'n',
    ...patch,
  });
  const task = (patch: Partial<ViewTask> = {}): ViewTask => ({
    id: TASK,
    workspaceId: WS,
    listId: LIST,
    parentId: null,
    kind: 'task',
    title: 'Zgłoś',
    status: 'todo',
    priority: 4,
    startDate: null,
    dueDate: null,
    dueTime: null,
    durationMin: null,
    recurrence: null,
    habit: null,
    completedAt: null,
    createdAt: '2026-11-23T10:00:00Z',
    sortKey: 'n',
    tagIds: [],
    postponeCount: 0,
    ...patch,
  });

  it('wiersze z lokalnej bazy: jsonb jako tekst, 0/1, nieznany wyzwalacz i usunięte pominięte', () => {
    expect(parsePluginRule({ id: 'r', name: 'A', connection_id: CONN, enabled: 1, trigger: '{"kind":"manual"}', action: '{"message":"x"}', options: '{}', sort_key: 'a' })).toEqual(
      manual('r', { name: 'A', action: { message: 'x' }, sortKey: 'a' }),
    );
    expect(parsePluginRule({ id: 'r', trigger: '{"kind":"schedule"}' })).toBeNull();
    expect(parsePluginRule({ id: 'r', trigger: '{"kind":"manual"}', deleted_at: '2026-01-01' })).toBeNull();
    expect(parsePluginConnection({ id: CONN, plugin: 'webhook', label: 'n8n', config: '{"url":"https://x.y"}', status: 'active' })).toEqual(connection);
    expect(parsePluginConnection({ id: CONN, label: 'x', status: 'dziwny' })?.status).toBe('disabled');
  });

  it('„Wyślij do…”: tylko ręczne, włączone, z aktywnym połączeniem, w kolejności', () => {
    const rules = [
      manual('b', { sortKey: 'b' }),
      manual('a', { sortKey: 'a' }),
      manual('wyl', { enabled: false }),
      manual('zdarz', { trigger: { kind: 'event', events: ['task.created'] } }),
      manual('inne', { connectionId: 'brak' }),
    ];
    expect(sendableRules(rules, [connection]).map((r) => r.id)).toEqual(['a', 'b']);
    expect(sendableRules(rules, [{ ...connection, status: 'error' }])).toEqual([]);
  });

  it('dopasowanie reguły zdarzeniowej: zdarzenie, filtr FilterQuery, zadania z integracji', () => {
    const rule = manual('r', { trigger: { kind: 'event', events: ['task.tagged'], filter: { tags: { ids: [TAG], match: 'any' } } } });
    const ctx = { today: '2026-11-23' };
    expect(ruleMatches(rule, ['task.tagged'], task({ tagIds: [TAG] }), ctx)).toBe(true);
    expect(ruleMatches(rule, ['task.tagged'], task({ tagIds: ['inny'] }), ctx)).toBe(false);
    expect(ruleMatches(rule, ['task.completed'], task({ tagIds: [TAG] }), ctx)).toBe(false);
    expect(ruleMatches(rule, ['task.tagged'], task({ tagIds: [TAG] }), { ...ctx, fromIntegration: true })).toBe(false);
    expect(ruleMatches({ ...rule, options: { includeIntegrations: true } }, ['task.tagged'], task({ tagIds: [TAG] }), { ...ctx, fromIntegration: true })).toBe(true);
    expect(ruleMatches({ ...rule, enabled: false }, ['task.tagged'], task({ tagIds: [TAG] }), ctx)).toBe(false);
    expect(ruleMatches(manual('m'), ['task.sent'], task(), ctx)).toBe(false);
  });

  it('zapis reguły: walidacja, nowa na końcu z zakresem osobistym, edycja bez sort_key', () => {
    const save = (draft: Partial<Parameters<typeof pluginRuleSaveOps>[3]>, rules: PluginRule[] = []) =>
      pluginRuleSaveOps(USER, rules, [connection], { name: 'Do n8n', connectionId: CONN, enabled: true, trigger: { kind: 'manual' }, action: { message: '{{title}}' }, ...draft }, () => 'nowa');
    expect(save({ name: ' ' })).toEqual({ ok: false, error: 'Nazwa reguły nie może być pusta.' });
    expect(save({ connectionId: 'x' })).toEqual({ ok: false, error: 'Wybierz połączenie.' });
    expect(save({ action: { message: '{{tytul}}' } })).toEqual({ ok: false, error: 'Nieznane pole szablonu: {{tytul}}.' });
    const created = save({ action: { message: '' } }, [manual('a', { sortKey: 'n' })]);
    expect(created.ok && created.ops[0]).toMatchObject({ table: 'plugin_rules', id: 'nowa', patch: { scope_id: USER, name: 'Do n8n', action: {}, options: {} } });
    const patch = created.ok ? (created.ops[0]!.patch as Record<string, unknown>) : {};
    expect(String(patch.sort_key) > 'n').toBe(true);
    expect(MODEL.plugin_rules.safeParse({ id: '01900000-0000-7000-8000-0000000000e1', ...patch }).success).toBe(true);
    const edited = save({ id: 'a', name: 'Inna' }, [manual('a')]);
    expect(edited.ok && edited.ops[0]!.patch).not.toHaveProperty('sort_key');
    expect(pluginRuleDeleteOps('a', new Date('2026-11-23T10:00:00Z'))).toEqual([{ table: 'plugin_rules', id: 'a', patch: { deleted_at: '2026-11-23T10:00:00.000Z' } }]);
  });

  it('prośba „Wyślij do…”: jeden wiersz na zadanie, zgodny ze schematem', () => {
    let n = 0;
    const ops = pluginRequestOps(USER, CONN, [TASK, LIST], new Date('2026-11-23T10:00:00Z'), () => `01900000-0000-7000-8000-00000000000${++n}`);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ table: 'plugin_requests', id: '01900000-0000-7000-8000-000000000001', patch: { scope_id: USER, rule_id: CONN, task_id: TASK, requested_at: '2026-11-23T10:00:00.000Z' } });
    expect(MODEL.plugin_requests.safeParse({ id: ops[0]!.id, ...ops[0]!.patch }).success).toBe(true);
  });
});
