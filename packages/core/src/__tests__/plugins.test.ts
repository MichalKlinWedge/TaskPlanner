import { describe, expect, it } from 'vitest';

import { PLUGIN_EVENT } from '../labels.ts';
import {
  afterSendArgs,
  afterSendSummary,
  isEmptyAfterSend,
  deliveryId,
  eventContext,
  eventDeliveryId,
  mergeEventContext,
  outboxEvents,
  parseOutboxRow,
  recheckEvents,
  ruleDelaySec,
  ruleEvents,
  rulePreview,
  viewTaskData,
  gitlabApiUrl,
  gitlabChange,
  gitlabCreate,
  gitlabExternalId,
  gitlabDueDate,
  gitlabEstimate,
  gitlabLabels,
  gitlabUsernames,
  gitlabMarker,
  gitlabProjectRef,
  parseGitlabExternalId,
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
import { taskTagId } from '../ids.ts';
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
  priority: 4,
  ...patch,
});

describe('pluginEvents — zdarzenia z przejścia stanu', () => {
  it('nowe zadanie; nowe w koszu — nic', () => {
    expect(pluginEvents(null, state())).toEqual(['task.created']);
    expect(pluginEvents(null, state({ tagIds: [TAG], assigneeId: 'osoba', status: 'done' }))).toEqual(['task.created', 'task.completed', 'task.tagged', 'task.assigned']);
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

  it('po udanej wysyłce: zapis, walidacja, opis i argumenty serwera', () => {
    const G1 = '01900000-0000-7000-8000-0000000000a1';
    const G2 = '01900000-0000-7000-8000-0000000000a2';
    const save = (afterSend: Record<string, unknown>) =>
      pluginRuleSaveOps(USER, [], [connection], { name: 'R', connectionId: CONN, enabled: true, trigger: { kind: 'manual' }, action: {}, options: { afterSend } }, () => 'nowa');
    const options = (r: ReturnType<typeof save>) => (r.ok ? (r.ops[0]!.patch as { options: unknown }).options : r.error);
    expect(options(save({ addTagIds: [G1, G1], removeTagIds: [], status: 'done' }))).toEqual({ afterSend: { addTagIds: [G1], status: 'done' } });
    expect(options(save({ addTagIds: [], removeTagIds: [] }))).toEqual({});
    expect(options(save({ addTagIds: [G1], removeTagIds: [G1] }))).toBe('Ten sam tag nie może być po wysyłce dodany i zdjęty.');
    expect(options(save({ status: 'gotowe' }))).toBe('Niepoprawne opcje reguły.');
    const saved = save({ addTagIds: [G1], removeTagIds: [G2], status: 'waiting' });
    expect(MODEL.plugin_rules.safeParse({ id: '01900000-0000-7000-8000-0000000000e1', ...(saved.ok ? saved.ops[0]!.patch : {}) }).success).toBe(true);

    const names: Record<string, string> = { [G1]: 'wysłane', [G2]: 'zgłoś' };
    expect(afterSendSummary({ addTagIds: [G1, 'brak'], removeTagIds: [G2], status: 'done' }, (id) => names[id])).toBe('potem: +wysłane, −zgłoś, status: Gotowe');
    expect(afterSendSummary(undefined, () => undefined)).toBe('');
    expect(isEmptyAfterSend({ addTagIds: [] })).toBe(true);
    expect(afterSendArgs(TASK, { addTagIds: [G1], removeTagIds: [G2] })).toEqual({ p_status: null, p_add: [{ id: taskTagId(TASK, G1), tagId: G1 }], p_remove: [G2] });
  });

  it('prośba „Wyślij do…”: jeden wiersz na zadanie, zgodny ze schematem', () => {
    let n = 0;
    const ops = pluginRequestOps(USER, CONN, [TASK, LIST], new Date('2026-11-23T10:00:00Z'), () => `01900000-0000-7000-8000-00000000000${++n}`);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ table: 'plugin_requests', id: '01900000-0000-7000-8000-000000000001', patch: { scope_id: USER, rule_id: CONN, task_id: TASK, requested_at: '2026-11-23T10:00:00.000Z' } });
    expect(MODEL.plugin_requests.safeParse({ id: ops[0]!.id, ...ops[0]!.patch }).success).toBe(true);
  });
});

describe('reguły zdarzeniowe — kolejka, okno, ponowne sprawdzenie', () => {
  const rule = (patch: Partial<PluginRule> = {}): PluginRule => ({
    id: '01900000-0000-7000-8000-0000000000e1',
    name: 'Zgłoszenia',
    connectionId: CONN,
    enabled: true,
    trigger: { kind: 'event', events: ['task.tagged'], filter: { tags: { ids: [TAG], match: 'any' } } },
    action: {},
    options: {},
    sortKey: 'n',
    ...patch,
  });
  const row = (patch: Partial<Parameters<typeof parseOutboxRow>[0]> = {}) =>
    parseOutboxRow({ id: 7, table_name: 'task_tags', before: state(), after: state({ tagIds: [TAG] }), extra: null, origin: 'client', ...patch })!;
  const today = '2026-11-23' as const;
  const none = { completions: new Set<string>(), comments: new Set<string>() };

  it('wiersz kolejki: stan przed/po, dodatki; inne tabele i zepsute stany pomijane', () => {
    expect(outboxEvents(row())).toEqual(['task.tagged']);
    expect(parseOutboxRow({ id: 1, table_name: 'plugin_requests', before: null, after: {} })).toBeNull();
    expect(parseOutboxRow({ id: 1, table_name: 'tasks', before: { zly: 1 }, after: state() })!.before).toBeNull();
    const done = row({ table_name: 'task_completions', before: state(), after: state(), extra: { completion: { id: 'c1', occurrence: '2026-11-23' } } });
    expect(outboxEvents(done)).toEqual(['task.completed']);
    expect(outboxEvents(row({ table_name: 'task_comments', before: state(), after: state(), extra: { comment: { id: 'k1' } } }))).toEqual(['task.commented']);
  });

  it('reguła: zdarzenie, filtr na stanie, integracje tylko z opcją, wyłączona / ręczna — nic', () => {
    expect(ruleEvents(rule(), ['task.tagged', 'task.due_changed'], TASK, state({ tagIds: [TAG] }), { today })).toEqual(['task.tagged']);
    expect(ruleEvents(rule(), ['task.tagged'], TASK, state({ tagIds: ['inny'] }), { today })).toEqual([]);
    expect(ruleEvents(rule(), ['task.completed'], TASK, state({ tagIds: [TAG] }), { today })).toEqual([]);
    expect(ruleEvents(rule({ enabled: false }), ['task.tagged'], TASK, state({ tagIds: [TAG] }), { today })).toEqual([]);
    expect(ruleEvents(rule({ trigger: { kind: 'manual' } }), ['task.tagged'], TASK, state({ tagIds: [TAG] }), { today })).toEqual([]);
    expect(ruleEvents(rule(), ['task.tagged'], TASK, state({ tagIds: [TAG] }), { today, fromIntegration: true })).toEqual([]);
    expect(ruleEvents(rule({ options: { includeIntegrations: true } }), ['task.tagged'], TASK, state({ tagIds: [TAG] }), { today, fromIntegration: true })).toEqual(['task.tagged']);
    const urgent = rule({ trigger: { kind: 'event', events: ['task.completed'], filter: { priorities: [1], due: { kind: 'range', to: { offsetDays: 0 } } } } });
    expect(ruleEvents(urgent, ['task.completed'], TASK, state({ priority: 1, dueDate: '2026-11-23' }), { today })).toEqual(['task.completed']);
    expect(ruleEvents(urgent, ['task.completed'], TASK, state({ priority: 1, dueDate: '2026-11-24' }), { today })).toEqual([]);
    expect(ruleEvents(rule({ trigger: { kind: 'event', events: ['task.deleted'] } }), ['task.deleted'], TASK, state({ deletedAt: 'x' }), { today })).toEqual(['task.deleted']);
    expect(ruleDelaySec(rule())).toBe(20);
    expect(ruleDelaySec(rule({ options: { delaySec: 0 } }))).toBe(0);
  });

  it('okno: id z pierwszego wiersza, łączenie bez duplikatów, baseline zostaje', () => {
    expect(eventDeliveryId('r', TASK, 7)).toBe(eventDeliveryId('r', TASK, 7));
    expect(eventDeliveryId('r', TASK, 7)).not.toBe(eventDeliveryId('r', TASK, 8));
    const first = eventContext(row());
    expect(first).toEqual({ baseline: state(), completions: [], comments: [] });
    const comment = row({ table_name: 'task_comments', before: state({ tagIds: [TAG] }), after: state({ tagIds: [TAG] }), extra: { comment: { id: 'k1' } } });
    const merged = mergeEventContext(mergeEventContext(first, comment), comment);
    expect(merged).toEqual({ baseline: state(), completions: [], comments: ['k1'] });
  });

  it('ponowne sprawdzenie: cofnięte w oknie = nic; nowe zadanie z tagiem = dodane + tag; cofnięte ukończenie serii', () => {
    // Ukończenie i „Cofnij” w ciągu kilku sekund: stan wrócił do baseline.
    expect(recheckEvents({ baseline: state(), completions: [], comments: [] }, state(), none)).toEqual([]);
    expect(recheckEvents({ baseline: state(), completions: [], comments: [] }, state({ status: 'done' }), none)).toEqual(['task.completed']);
    // Zadanie dodane offline razem z tagiem (jedna paczka push_changes).
    expect(recheckEvents({ baseline: null, completions: [], comments: [] }, state({ tagIds: [TAG] }), none)).toEqual(['task.created', 'task.tagged']);
    // Tag dodany i zdjęty w oknie.
    expect(recheckEvents({ baseline: state(), completions: [], comments: [] }, state(), none)).toEqual([]);
    // Wystąpienie serii: wpis `task_completions` żyje / cofnięty; termin przesunięty dalej.
    const series = { baseline: state({ dueDate: '2026-11-23' }), completions: [{ id: 'c1', occurrence: '2026-11-23' }], comments: [] };
    expect(recheckEvents(series, state({ dueDate: '2026-11-24' }), { completions: new Set(['c1']), comments: new Set() })).toEqual(['task.completed', 'task.due_changed']);
    expect(recheckEvents(series, state({ dueDate: '2026-11-23' }), none)).toEqual([]);
    // Komentarz usunięty w oknie; zadanie w koszu — tylko „usunięte”.
    expect(recheckEvents({ baseline: state(), completions: [], comments: ['k1'] }, state(), none)).toEqual([]);
    expect(recheckEvents({ baseline: state(), completions: [], comments: ['k1'] }, state({ deletedAt: 'x' }), { completions: new Set(), comments: new Set(['k1']) })).toEqual(['task.deleted']);
    expect(recheckEvents({ baseline: state(), completions: [], comments: [] }, null, none)).toEqual([]);
  });
});

describe('podgląd reguły', () => {
  const task = viewTaskData(
    { id: TASK, workspaceId: WS, listId: LIST, parentId: null, kind: 'task', title: 'Ekspres "przecieka"', status: 'todo', priority: 2, startDate: null, dueDate: '2026-11-24', dueTime: null, durationMin: null, recurrence: null, habit: null, completedAt: null, createdAt: '2026-11-23T08:00:00Z', sortKey: 'n', tagIds: [TAG], postponeCount: 0 },
    { list: 'Biuro', listKind: 'list', workspace: 'Praca', tags: ['zgłoś'], assignee: null },
  );

  it('reguła zdarzeniowa: zdarzenia w kolejności katalogu, treść z szablonu, żądanie = ładunek webhooka', () => {
    const preview = rulePreview({
      rule: { id: CONN, name: 'Zgłoś', trigger: { kind: 'event', events: ['task.tagged', 'task.created'] } },
      def: PLUGINS.webhook,
      action: { message: '{{title}} / {{event}}' },
      task,
      appUrl: 'https://app.example.com/',
      now: new Date('2026-11-23T10:00:00Z'),
    });
    expect(preview.payload).toMatchObject({
      event: 'task.created',
      events: ['task.created', 'task.tagged'],
      message: 'Ekspres "przecieka" / Dodane zadanie',
      task: { list: { id: LIST, name: 'Biuro' }, tags: ['zgłoś'], url: `https://app.example.com/?task=${TASK}` },
    });
    expect(preview.request.body).toBe(preview.payload);
  });

  it('reguła ręczna = task.sent; pusty szablon — bez treści', () => {
    const { payload } = rulePreview({ rule: { id: CONN, name: 'Ręczna', trigger: { kind: 'manual' } }, def: PLUGINS.webhook, action: {}, task, appUrl: 'https://x.test' });
    expect(payload.events).toEqual(['task.sent']);
    expect(payload).not.toHaveProperty('message');
  });

  it('GitLab: puste pola = domyślne (tytuł zadania, opis z linkiem), żądanie = treść nowego issue', () => {
    const preview = rulePreview({ rule: { id: CONN, name: 'Issue', trigger: { kind: 'manual' } }, def: PLUGINS.gitlab, action: { labels: 'zgłoszenie, {{tags}}' }, task, appUrl: 'https://x.test' });
    expect(preview.fields).toEqual({ title: 'Ekspres "przecieka"', description: `\n\n---\n[Zadanie w Task Plannerze](https://x.test/?task=${TASK})`, labels: 'zgłoszenie, zgłoś', dueDate: '2026-11-24', estimate: '', assignees: '' });
    expect(preview.request.body).toEqual({
      title: 'Ekspres "przecieka"',
      description: `---\n[Zadanie w Task Plannerze](https://x.test/?task=${TASK})\n\n${gitlabMarker(preview.payload.id)}`,
      labels: 'zgłoszenie,zgłoś',
      due_date: '2026-11-24',
      assignees: [],
      estimate: '',
    });
  });

  it('GitLab: szacowany czas = „Czas (min)” zadania albo stała wartość; {{time}} (godzina) odrzucone przy zapisie', () => {
    const estimate = (durationMin: number | null, action: Record<string, string> = {}) =>
      (rulePreview({ rule: { id: CONN, name: 'Issue', trigger: { kind: 'manual' } }, def: PLUGINS.gitlab, action, task: { ...task, durationMin }, appUrl: 'https://x.test' }).request.body as { estimate: string }).estimate;
    expect([estimate(90), estimate(45), estimate(480), estimate(null)]).toEqual(['1h30m', '45m', '8h', '']);
    expect([estimate(90, { estimate: '2h' }), estimate(90, { estimate: '0' }), estimate(null, { estimate: '30' })]).toEqual(['2h', '', '30m']);
    expect([gitlabEstimate(' 1D 2h 30m '), gitlabEstimate('14:00'), gitlabEstimate('1.5h'), gitlabEstimate(undefined)]).toEqual(['1d2h30m', '', '', '']);
    const ok = (value: string) => PLUGINS.gitlab.actionSchema.safeParse({ estimate: value }).success;
    expect(['', '{{duration}}', '{{ duration }}', '90', '0', '1h 30m', '2d'].map(ok)).toEqual(Array(7).fill(true));
    expect(['{{time}}', '{{title}}', 'długo', '14:00'].map(ok)).toEqual(Array(4).fill(false));
    expect(PLUGINS.gitlab.actionSchema.safeParse({ estimate: '{{time}}' }).error?.issues[0]?.message).toContain('{{duration}}');
  });

  it('GitLab: termin issue z szablonu albo stała data; zła wartość = bez terminu; walidacja przy zapisie', () => {
    const body = (dueDate: string) => rulePreview({ rule: { id: CONN, name: 'Issue', trigger: { kind: 'manual' } }, def: PLUGINS.gitlab, action: { dueDate }, task, appUrl: 'https://x.test' }).request.body as { due_date: string | null };
    expect(body('').due_date).toBe('2026-11-24');
    expect(body('2026-12-31').due_date).toBe('2026-12-31');
    expect(body('{{time}}').due_date).toBeNull();
    expect(gitlabDueDate(' 2026-12-01 ')).toBe('2026-12-01');
    expect(gitlabDueDate('jutro')).toBeNull();
    expect(PLUGINS.gitlab.actionSchema.safeParse({ dueDate: '{{due}}' }).success).toBe(true);
    expect(PLUGINS.gitlab.actionSchema.safeParse({ dueDate: 'jutro' }).success).toBe(false);
  });
});

describe('GitLab — plan zmian powiązanego issue', () => {
  const issue = { title: 'T', description: 'D', labels: 'a,b', due_date: '2026-11-24', assignees: ['jan'], estimate: '' };
  const task = pluginPayload({ id: 'd', events: ['task.sent'], sentAt: 'x', rule: null, task: SAMPLE_TASK, appUrl: 'https://app' }).task;

  it('zdarzenia → pola PUT; „Wyślij do…” = pełna aktualizacja ze stanem zadania', () => {
    expect(gitlabChange(['task.completed'], task, issue)).toEqual({ put: { state_event: 'close' } });
    expect(gitlabChange(['task.restored'], task, issue)).toEqual({ put: { state_event: 'reopen' } });
    expect(gitlabChange(['task.moved', 'task.created'], task, issue)).toEqual({ put: {} });
    expect(gitlabChange(['task.untagged'], task, { ...issue, labels: '' })).toEqual({ put: {} });
    expect(gitlabChange(['task.sent'], { ...task, status: 'done' }, issue)).toEqual({ put: { title: 'T', description: 'D', due_date: '2026-11-24', labels: 'a,b', assignees: ['jan'], state_event: 'close' } });
    expect(gitlabChange(['task.sent'], task, { ...issue, estimate: '1h' }).estimate).toBe('1h');
    expect(gitlabChange(['task.due_changed'], task, { ...issue, estimate: '1h' })).not.toHaveProperty('estimate');
    expect(gitlabChange(['task.assigned'], task, issue)).toEqual({ put: { assignees: ['jan'] } });
    expect(gitlabChange(['task.assigned'], task, { ...issue, assignees: [] })).toEqual({ put: {} });
    expect(gitlabChange(['task.commented'], task, issue, { body: 'Hej' }).note).toBe(`Hej\n\n— komentarz w [Task Plannerze](${task.url})`);
  });

  it('bez issue: same zmiany stanu nic nie zakładają; reszta zakłada', () => {
    expect(gitlabCreate(['task.deleted', 'task.untagged'], task, issue)).toBeNull();
    expect(gitlabCreate(['task.created'], task, issue)).toEqual({ create: issue, after: { put: {} } });
    expect(gitlabCreate(['task.created'], task, { ...issue, estimate: '1h' })?.after).toEqual({ put: {}, estimate: '1h' });
  });

  it('etykiety, projekt, id obiektu', () => {
    expect(gitlabLabels(' a, b ,, a,c ')).toBe('a,b,c');
    expect(gitlabUsernames(' @jan.kowalski, ola  ola,, @Jan.Kowalski')).toEqual(['jan.kowalski', 'ola', 'Jan.Kowalski']);
    expect(gitlabProjectRef('/grupa/pod/projekt/')).toBe('grupa%2Fpod%2Fprojekt');
    expect(gitlabApiUrl('https://git.example.com/gitlab/', '/projects/1')).toBe('https://git.example.com/gitlab/api/v4/projects/1');
    expect(parseGitlabExternalId(gitlabExternalId(7, 12))).toEqual({ projectId: 7, iid: 12 });
    expect(parseGitlabExternalId('x')).toBeNull();
    expect(PLUGINS.gitlab.configSchema.parse({ project: 'g/p' })).toEqual({ baseUrl: 'https://gitlab.com', project: 'g/p' });
  });
});
