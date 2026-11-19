/**
 * Zadanie z lokalnej bazy w postaci dla widoków (`ViewTask`) oraz ukończenie i cofnięcie
 * ukończenia jako operacje `mutate` (M3, §7.2). Web i telefon wołają te same funkcje — reguła
 * „seria przesuwa termin, zamiast się zamykać” jest tylko tutaj.
 */
import { addDays, daysBetween, localDateAt } from './dates.ts';
import { HabitSettings } from './habits.ts';
import { isHlc, parseHlc } from './hlc.ts';
import { completionId } from './ids.ts';
import { nextDue, Recurrence } from './recurrence.ts';
import type { LocalDate, LocalTime, Priority, TaskStatus } from './schemas/primitives.ts';
import type { ViewTask } from './views.ts';

/** Wiersz `tasks` z lokalnej bazy: kolumny `jsonb` jako tekst JSON albo już obiekt. */
export interface LocalTaskRow {
  id: string;
  scope_id: string | null;
  list_id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  status: string;
  priority: number;
  start_date: string | null;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  recurrence: unknown;
  habit: unknown;
  completed_at: string | null;
  created_at: string | null;
  sort_key: string;
  postpone_count: number | null;
  field_clock?: unknown;
}

const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** Czas z HLC pola (`field_clock`) jako ISO; brak / zły zapis → `null`. */
function fieldChangedAt(fieldClock: unknown, field: string): string | null {
  const clock = json(fieldClock);
  const hlc = clock && typeof clock === 'object' ? (clock as Record<string, unknown>)[field] : undefined;
  return isHlc(hlc) ? new Date(parseHlc(hlc).wall).toISOString() : null;
}

/**
 * Wiersz lokalnej bazy → `ViewTask`. Niepoprawna reguła cyklu lub ustawienia nawyku (np. z nowszej
 * wersji aplikacji) dają `null` — zadanie zostaje widoczne jako zwykłe.
 */
export function toViewTask(row: LocalTaskRow, tagIds: readonly string[] = []): ViewTask {
  const recurrence = Recurrence.safeParse(json(row.recurrence));
  const habit = HabitSettings.safeParse(json(row.habit));
  return {
    id: row.id,
    workspaceId: row.scope_id ?? '',
    listId: row.list_id,
    parentId: row.parent_id,
    kind: row.kind === 'habit' ? 'habit' : 'task',
    title: row.title,
    status: row.status as TaskStatus,
    priority: Number(row.priority) as Priority,
    startDate: row.start_date as LocalDate | null,
    dueDate: row.due_date as LocalDate | null,
    dueTime: row.due_time as LocalTime | null,
    durationMin: row.duration_min === null ? null : Number(row.duration_min),
    recurrence: recurrence.success && row.recurrence !== null ? recurrence.data : null,
    habit: habit.success && row.habit !== null ? habit.data : null,
    completedAt: row.completed_at,
    // Wiersz utworzony offline nie ma jeszcze `created_at` z serwera.
    createdAt: row.created_at ?? new Date(0).toISOString(),
    sortKey: row.sort_key,
    tagIds,
    postponeCount: Number(row.postpone_count ?? 0),
    statusChangedAt: fieldChangedAt(row.field_clock, 'status'),
  };
}

export interface TaskOp {
  table: 'tasks' | 'task_completions';
  id: string;
  patch: Record<string, unknown>;
}

export interface CompleteResult {
  ops: TaskOp[];
  /** Operacje przywracające stan sprzed ukończenia („Cofnij”). */
  undo: TaskOp[];
  /** Nowy termin serii; `null` = zadanie zamknięte (zwykłe albo koniec serii). */
  nextDue: LocalDate | null;
}

type CompletableTask = Pick<ViewTask, 'id' | 'kind' | 'status' | 'startDate' | 'dueDate' | 'recurrence' | 'completedAt' | 'postponeCount'>;

/**
 * Ukończenie zadania w chwili `now`. Zwykłe zadanie → `done`. Seria → wpis w `task_completions`
 * (id deterministyczne: dwa urządzenia ukończą to samo wystąpienie jednym wierszem) i termin
 * przesunięty na `nextDue` razem z początkiem zakresu; licznik przesunięć się zeruje, bo to nowe
 * wystąpienie. Koniec serii (`COUNT`/`UNTIL`) zamyka zadanie. Nawyk → tylko wpis na dziś.
 */
export function completeTaskOps(task: CompletableTask, { now, timeZone }: { now: Date | string; timeZone?: string }): CompleteResult {
  const at = new Date(now).toISOString();
  const today = localDateAt(at, timeZone);
  const completion = (date: LocalDate): TaskOp => ({
    table: 'task_completions',
    id: completionId(task.id, date),
    patch: { task_id: task.id, occurrence_date: date, kind: 'done', value: null, completed_at: at, deleted_at: null },
  });
  const removed = (op: TaskOp): TaskOp => ({ table: op.table, id: op.id, patch: { deleted_at: at } });
  const close: TaskOp = { table: 'tasks', id: task.id, patch: { status: 'done', completed_at: at } };
  const before: TaskOp = { table: 'tasks', id: task.id, patch: { status: task.status, completed_at: task.completedAt } };

  if (task.kind === 'habit') {
    const done = completion(today);
    return { ops: [done], undo: [removed(done)], nextDue: null };
  }
  if (!task.recurrence) return { ops: [close], undo: [before], nextDue: null };

  const occurrence = task.dueDate ?? today;
  const done = completion(occurrence);
  const next = nextDue(task.recurrence, { occurrence, completedOn: today });
  if (!next) return { ops: [done, close], undo: [removed(done), before], nextDue: null };
  const shift = daysBetween(occurrence, next);
  return {
    ops: [done, { table: 'tasks', id: task.id, patch: { due_date: next, start_date: task.startDate ? addDays(task.startDate, shift) : null, postpone_count: 0 } }],
    undo: [removed(done), { table: 'tasks', id: task.id, patch: { due_date: task.dueDate, start_date: task.startDate, postpone_count: task.postponeCount } }],
    nextDue: next,
  };
}

/** Ponowne otwarcie zamkniętego zadania (odhaczenie w widoku ukończonych). */
export const reopenTaskPatch = (): Record<string, unknown> => ({ status: 'todo', completed_at: null });
