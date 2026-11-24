/**
 * Akcje z powiadomienia o przypomnieniu w przeglądarce (M8): „Ukończ” i „Odłóż 10 min”. Powtórzona
 * akcja albo stare powiadomienie nic nie psują. Telefon odkłada samo lokalne powiadomienie; przeglądarka
 * nie potrafi zaplanować go przy zamkniętej karcie, więc odłożenie to jednorazowe przypomnienie
 * (`reminders`, `absolute`) — wyśle je `reminders-push`.
 */
import { localDateAt, localDateTimeAt } from './dates.ts';
import { uuidv5 } from './ids.ts';
import { SNOOZE_MINUTES, snoozeUntil, type ReminderRule } from './reminders.ts';
import type { LocalDate, LocalTime } from './schemas/primitives.ts';
import { completeTaskOps, type CompleteOptions, type CompleteResult, type TaskOp } from './tasks.ts';
import { isOpen, type ViewTask } from './views.ts';

export const REMINDER_ACTIONS = ['done', 'snooze'] as const;
export type ReminderAction = (typeof REMINDER_ACTIONS)[number];

/** Id odłożonego przypomnienia — z niego widać też, że wiersz powstał przez odłożenie. */
export const snoozeReminderId = (userId: string, taskId: string, date: LocalDate, time: LocalTime): string => uuidv5(`reminder-snooze:${userId}:${taskId}:${date}T${time}`);

const isSnooze = (userId: string, r: ReminderRule) => r.kind === 'absolute' && !!r.atDate && !!r.atTime && r.id === snoozeReminderId(userId, r.taskId, r.atDate, r.atTime);

/** Usunięcie wcześniejszych odłożeń zadania (bez `keep`). */
const dropSnoozes = (userId: string, rules: readonly ReminderRule[], now: Date | string, keep?: string): TaskOp[] =>
  rules.filter((r) => r.id !== keep && isSnooze(userId, r)).map((r) => ({ table: 'reminders', id: r.id, patch: { deleted_at: new Date(now).toISOString() } }));

/**
 * „Ukończ”: `null`, gdy zadanie jest już zamknięte albo powiadomienie dotyczy minionego wystąpienia serii.
 * `key` = klucz powiadomienia (`ReminderFire.key`); względne przypomnienie niesie w nim dzień wystąpienia,
 * jednorazowe — nie, więc seria z terminem w przyszłości (już ukończona) zostaje bez zmian.
 */
export function reminderDoneOps(
  task: ViewTask,
  key: string,
  rules: readonly ReminderRule[],
  options: CompleteOptions & { userId: string },
): CompleteResult | null {
  if (task.kind !== 'task' || !isOpen(task)) return null;
  if (task.recurrence) {
    const [reminderId, day] = key.split(':');
    const relative = rules.find((r) => r.id === reminderId)?.kind === 'relative';
    if (relative ? task.dueDate !== day : !!task.dueDate && task.dueDate > localDateAt(options.now, options.timeZone)) return null;
  }
  const result = completeTaskOps(task, options);
  const drop = dropSnoozes(options.userId, rules, options.now);
  return { ...result, ops: [...result.ops, ...drop], undo: [...result.undo, ...drop.map((op): TaskOp => ({ ...op, patch: { deleted_at: null } }))] };
}

/**
 * „Odłóż”: jednorazowe przypomnienie za `minutes` (pełna minuta w górę — `reminders-push` działa co minutę),
 * w strefie przypiętej do zadania albo profilu; poprzednie odłożenie znika. `null` — zadanie zamknięte.
 */
export function snoozeReminderOps(
  task: Pick<ViewTask, 'id' | 'kind' | 'status'>,
  rules: readonly ReminderRule[],
  { userId, now, timeZone, minutes = SNOOZE_MINUTES['10m'] }: { userId: string; now: Date | string; timeZone?: string; minutes?: number },
): { ops: TaskOp[]; undo: TaskOp[]; time: LocalTime } | null {
  if (task.kind !== 'task' || !isOpen(task)) return null;
  const at = Math.ceil(new Date(snoozeUntil(now, minutes)).getTime() / 60_000) * 60_000;
  const local = localDateTimeAt(new Date(at), timeZone);
  const date = local.slice(0, 10) as LocalDate;
  const time = local.slice(11, 16) as LocalTime;
  const id = snoozeReminderId(userId, task.id, date, time);
  const drop = dropSnoozes(userId, rules, now, id);
  return {
    time,
    ops: [{ table: 'reminders', id, patch: { task_id: task.id, kind: 'absolute', offset_min: null, at_date: date, at_time: time, deleted_at: null } }, ...drop],
    undo: [{ table: 'reminders', id, patch: { deleted_at: new Date(now).toISOString() } }, ...drop.map((op): TaskOp => ({ ...op, patch: { deleted_at: null } }))],
  };
}
