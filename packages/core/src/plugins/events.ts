/**
 * Zdarzenia pluginów (SPECYFIKACJA M21): wynikają z **przejścia stanu zadania po scaleniu na serwerze**,
 * nie z pojedynczej operacji — kolejność zmian i liczba urządzeń nie mają znaczenia. `pluginEvents`
 * porównuje rzut zadania przed i po zmianie (I2: wyzwalacze na `tasks` / `task_tags`).
 * `task.sent` = „Wyślij do…” (wyzwalacz ręczny), `task.commented` — wstawienie komentarza.
 */
import { z } from 'zod';

import { Priority, TaskStatus } from '../schemas/primitives.ts';

export const PLUGIN_EVENTS = [
  'task.created',
  'task.completed',
  'task.reopened',
  'task.deleted',
  'task.restored',
  'task.moved',
  'task.tagged',
  'task.untagged',
  'task.due_changed',
  'task.assigned',
  'task.commented',
  'task.sent',
] as const;
export const PluginEvent = z.enum(PLUGIN_EVENTS);
export type PluginEvent = z.infer<typeof PluginEvent>;

/** Zdarzenia do wyboru w regule zdarzeniowej (bez ręcznego `task.sent`). */
export const RULE_EVENTS = PLUGIN_EVENTS.filter((e): e is Exclude<PluginEvent, 'task.sent'> => e !== 'task.sent');
export const RuleEvent = z.enum(RULE_EVENTS as [Exclude<PluginEvent, 'task.sent'>, ...Exclude<PluginEvent, 'task.sent'>[]]);
export type RuleEvent = z.infer<typeof RuleEvent>;

/**
 * Rzut zadania, na którym liczą się zdarzenia i filtr reguły (z wiersza `tasks` i jego `task_tags`) — ten sam
 * kształt buduje w bazie `plugin_task_state` (wyzwalacze → `plugin_outbox.before` / `after`).
 */
export const PluginTaskState = z.object({
  status: TaskStatus,
  /** `timestamptz` albo `null`. */
  deletedAt: z.string().nullable(),
  listId: z.string(),
  workspaceId: z.string(),
  tagIds: z.array(z.string()).readonly(),
  dueDate: z.string().nullable(),
  dueTime: z.string().nullable(),
  assigneeId: z.string().nullable(),
  priority: Priority,
});
export type PluginTaskState = z.infer<typeof PluginTaskState>;

const closed = (status: TaskStatus) => status === 'done' || status === 'cancelled';

/**
 * Zdarzenia przejścia `before` → `after` (`null` = brak wiersza), w kolejności `PLUGIN_EVENTS`.
 * Przeniesienie do kosza daje tylko `task.deleted` (inne zmiany w tej chwili nie mają znaczenia),
 * zmiany zadania w koszu — nic; przywrócenie z kosza — `task.restored` i zmiany, które przyszły razem z nim.
 * Nowe zadanie: `task.created` i to, co ma od początku (tagi, odpowiedzialny, ukończone) — zadanie dodane
 * offline razem z tagiem `#zgłoś` łapie reguła „dodany tag”.
 */
export function pluginEvents(before: PluginTaskState | null, after: PluginTaskState | null): PluginEvent[] {
  if (!after) return [];
  if (!before) {
    if (after.deletedAt) return [];
    const created: PluginEvent[] = ['task.created'];
    if (after.status === 'done') created.push('task.completed');
    if (after.tagIds.length) created.push('task.tagged');
    if (after.assigneeId) created.push('task.assigned');
    return created;
  }
  if (after.deletedAt) return before.deletedAt ? [] : ['task.deleted'];
  const out = new Set<PluginEvent>();
  if (before.status !== 'done' && after.status === 'done') out.add('task.completed');
  if (closed(before.status) && !closed(after.status)) out.add('task.reopened');
  if (before.deletedAt) out.add('task.restored');
  if (before.listId !== after.listId || before.workspaceId !== after.workspaceId) out.add('task.moved');
  const was = new Set(before.tagIds);
  const is = new Set(after.tagIds);
  if ([...is].some((id) => !was.has(id))) out.add('task.tagged');
  if ([...was].some((id) => !is.has(id))) out.add('task.untagged');
  if (before.dueDate !== after.dueDate || before.dueTime !== after.dueTime) out.add('task.due_changed');
  if (before.assigneeId !== after.assigneeId) out.add('task.assigned');
  return PLUGIN_EVENTS.filter((e) => out.has(e));
}
