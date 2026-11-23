/**
 * Reguły zdarzeniowe (SPECYFIKACJA M21, etap I2): kolejka `plugin_outbox` → wysyłki z opóźnieniem,
 * łączeniem zdarzeń i ponownym sprawdzeniem warunku tuż przed wysyłką. Czysty TS — liczy to Edge Function
 * `plugins` (`_shared/plugins/deliver.ts`), testy Vitest.
 *
 * Wiersz kolejki niesie rzut zadania przed i po zmianie (`PluginTaskState`) albo dodatek: ukończenie wystąpienia
 * serii (`task_completions` — status serii się nie zmienia) i nowy komentarz. Wysyłka zapamiętuje w `context`
 * stan z chwili pierwszego zdarzenia okna (`baseline`) i dodatki; przed wysyłką zdarzenia liczą się od nowa
 * z `baseline` → bieżący stan — ukończenie cofnięte „Cofnij” w oknie opóźnienia nie zostawia nic do wysłania.
 */
import { z } from 'zod';

import type { LocalDate } from '../schemas/primitives.ts';
import { matchesFilter, type ViewTask } from '../views.ts';
import { PLUGIN_EVENTS, PluginTaskState, pluginEvents, type PluginEvent } from './events.ts';
import { deliveryId, pluginPayload, taskUrl, type PluginPayload, type PluginTaskData } from './payload.ts';
import { DEFAULT_DELAY_SEC, type PluginRule, type PluginTrigger } from './rules.ts';
import { renderActionFields } from './template.ts';
import type { PluginDef } from './catalog.ts';
import { gitlabIssueBody } from './gitlab.ts';

/** Ukończenie wystąpienia serii z kolejki (id wiersza `task_completions`). */
export const OutboxCompletion = z.object({ id: z.string(), occurrence: z.string() });
export type OutboxCompletion = z.infer<typeof OutboxCompletion>;

/** Dodatek wiersza kolejki (`plugin_outbox.extra`). */
export const OutboxExtra = z.object({
  completion: OutboxCompletion.optional(),
  comment: z.object({ id: z.string() }).optional(),
});
export type OutboxExtra = z.infer<typeof OutboxExtra>;

/** Wiersz `plugin_outbox` zmiany zadania (I2). */
export interface OutboxEventRow {
  id: number;
  table: string;
  before: PluginTaskState | null;
  after: PluginTaskState | null;
  extra: OutboxExtra | null;
  origin: 'client' | 'integration';
}

/** Kontekst wysyłki zdarzeniowej (`plugin_deliveries.context`). */
export const EventContext = z.object({
  /** Stan zadania przed pierwszym zdarzeniem okna; `null` = zadanie powstało w oknie. */
  baseline: PluginTaskState.nullable(),
  completions: z.array(OutboxCompletion).default([]),
  comments: z.array(z.string()).default([]),
});
export type EventContext = z.infer<typeof EventContext>;

const parseState = (value: unknown): PluginTaskState | null => {
  const parsed = PluginTaskState.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Surowy wiersz kolejki (z bazy) → wiersz zdarzenia albo `null` (nie dotyczy reguł zdarzeniowych). */
export function parseOutboxRow(row: { id: number; table_name: string; before: unknown; after: unknown; extra?: unknown; origin?: unknown }): OutboxEventRow | null {
  if (!['tasks', 'task_tags', 'task_completions', 'task_comments'].includes(row.table_name)) return null;
  const extra = OutboxExtra.safeParse(row.extra ?? {});
  return {
    id: row.id,
    table: row.table_name,
    before: parseState(row.before),
    after: parseState(row.after),
    extra: extra.success ? extra.data : null,
    origin: row.origin === 'integration' ? 'integration' : 'client',
  };
}

/** Zdarzenia jednego wiersza kolejki: przejście stanu + ukończenie wystąpienia serii / komentarz. */
export function outboxEvents(row: OutboxEventRow): PluginEvent[] {
  const out = new Set<PluginEvent>(row.after ? pluginEvents(row.before, row.after) : []);
  if (row.extra?.completion) out.add('task.completed');
  if (row.extra?.comment) out.add('task.commented');
  return PLUGIN_EVENTS.filter((e) => out.has(e));
}

/** Minimalne zadanie widoku z rzutu — tyle, ile sprawdza `matchesFilter`. */
export function stateTask(id: string, state: PluginTaskState): ViewTask {
  return {
    id,
    workspaceId: state.workspaceId,
    listId: state.listId,
    parentId: null,
    kind: 'task',
    title: '',
    status: state.status,
    priority: state.priority,
    startDate: null,
    dueDate: state.dueDate as LocalDate | null,
    dueTime: state.dueTime as ViewTask['dueTime'],
    durationMin: null,
    recurrence: null,
    habit: null,
    completedAt: null,
    createdAt: '',
    sortKey: '',
    tagIds: state.tagIds,
    postponeCount: 0,
    assigneeId: state.assigneeId,
  };
}

/**
 * Zdarzenia, na które reguła odpowiada dla tego stanu zadania: reguła zdarzeniowa włączona, wspólne zdarzenia,
 * filtr pasuje do stanu, zmiana z integracji tylko z opcją `includeIntegrations`. Pusta lista = nie wysyłać.
 */
export function ruleEvents(
  rule: PluginRule,
  events: readonly PluginEvent[],
  taskId: string,
  state: PluginTaskState | null,
  ctx: { today: LocalDate; fromIntegration?: boolean },
): PluginEvent[] {
  if (!rule.enabled || rule.trigger.kind !== 'event' || !state || (state.deletedAt && !events.includes('task.deleted'))) return [];
  if (ctx.fromIntegration && !rule.options.includeIntegrations) return [];
  const wanted = new Set<string>(rule.trigger.events);
  const hits = events.filter((e) => wanted.has(e));
  if (!hits.length) return [];
  return !rule.trigger.filter || matchesFilter(rule.trigger.filter, ctx.today)(stateTask(taskId, state)) ? hits : [];
}

/** Opóźnienie reguły (s). */
export const ruleDelaySec = (rule: PluginRule): number => rule.options.delaySec ?? DEFAULT_DELAY_SEC;

/** Id wysyłki zdarzeniowej: reguła + zadanie + pierwszy wiersz kolejki okna (powtórne przetworzenie = ten sam id). */
export const eventDeliveryId = (ruleId: string, taskId: string, outboxId: number): string => deliveryId(ruleId, `event:${taskId}:${outboxId}`);

/** Kontekst nowej wysyłki z pierwszego wiersza okna. */
export const eventContext = (row: OutboxEventRow): EventContext => ({
  baseline: row.before,
  completions: row.extra?.completion ? [row.extra.completion] : [],
  comments: row.extra?.comment ? [row.extra.comment.id] : [],
});

/** Dołączenie kolejnego wiersza do okna wysyłki (bez zmiany `baseline`; powtórka nic nie dubluje). */
export function mergeEventContext(context: EventContext, row: OutboxEventRow): EventContext {
  const completions = [...context.completions];
  if (row.extra?.completion && !completions.some((c) => c.id === row.extra!.completion!.id)) completions.push(row.extra.completion);
  const comments = row.extra?.comment && !context.comments.includes(row.extra.comment.id) ? [...context.comments, row.extra.comment.id] : context.comments;
  return { baseline: context.baseline, completions, comments };
}

/**
 * Ponowne sprawdzenie tuż przed wysyłką: zdarzenia od `baseline` do bieżącego stanu + dodatki, które nadal
 * istnieją (ukończenie wystąpienia nie cofnięte, komentarz nie usunięty).
 */
export function recheckEvents(context: EventContext, current: PluginTaskState | null, alive: { completions: ReadonlySet<string>; comments: ReadonlySet<string> }): PluginEvent[] {
  const out = new Set<PluginEvent>(current ? pluginEvents(context.baseline, current) : []);
  if (current && !current.deletedAt) {
    if (context.completions.some((c) => alive.completions.has(c.id))) out.add('task.completed');
    if (context.comments.some((id) => alive.comments.has(id))) out.add('task.commented');
  }
  return PLUGIN_EVENTS.filter((e) => out.has(e));
}

// ── Podgląd reguły (kreator w aplikacji) ────────────────────────────────────────────────────

/** Zadanie z lokalnej bazy → dane ładunku (nazwy list, tagów, osób z danych aplikacji). */
export function viewTaskData(
  task: ViewTask,
  names: { list: string; listKind: PluginTaskData['listKind']; workspace: string | null; tags: readonly string[]; assignee: string | null; description?: string | null },
): PluginTaskData {
  return {
    id: task.id,
    title: task.title,
    description: names.description ?? null,
    status: task.status,
    priority: task.priority,
    startDate: task.startDate,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    durationMin: task.durationMin,
    completedAt: task.completedAt,
    deletedAt: null,
    createdAt: task.createdAt,
    listId: task.listId,
    list: names.list,
    listKind: names.listKind,
    workspaceId: task.workspaceId,
    workspace: names.workspace,
    tags: [...names.tags],
    assignee: names.assignee,
    fromIntegration: false,
  };
}

/** Podgląd wysyłki: ładunek, wypełnione pola akcji i to, co naprawdę idzie do usługi (`request`). */
export interface RulePreview {
  payload: PluginPayload;
  fields: Record<string, string>;
  request: { method: string; path: string; body: unknown };
}

/**
 * Podgląd wysyłki reguły dla zadania taki, jaki zbuduje serwer — zdarzenia reguły zdarzeniowej połączone
 * w jedną wysyłkę, ręczna = `task.sent`. Id i chwila wysłania są przykładowe; GitLab — nowe issue.
 */
export function rulePreview(input: {
  rule: { id: string; name: string; trigger: PluginTrigger };
  def: PluginDef;
  action: Record<string, unknown>;
  task: PluginTaskData;
  appUrl: string;
  now?: Date;
}): RulePreview {
  const { rule, task, def } = input;
  const events: PluginEvent[] = rule.trigger.kind === 'event' ? PLUGIN_EVENTS.filter((e) => (rule.trigger as { events: readonly string[] }).events.includes(e)) : ['task.sent'];
  if (!events.length) events.push('task.sent');
  const url = taskUrl(input.appUrl, task.id);
  const fields = renderActionFields(def, input.action, task, { event: events[0]!, url });
  const id = deliveryId(rule.id, `preview:${task.id}`);
  const payload = pluginPayload({
    id,
    events,
    sentAt: (input.now ?? new Date()).toISOString(),
    rule: { id: rule.id, name: rule.name },
    task,
    appUrl: input.appUrl,
    message: fields.message,
  });
  const request =
    def.id === 'gitlab'
      ? { method: 'POST', path: '/api/v4/projects/…/issues', body: gitlabIssueBody(fields, payload.task, id) }
      : { method: 'POST', path: '(adres webhooka)', body: payload };
  return { payload, fields, request };
}
