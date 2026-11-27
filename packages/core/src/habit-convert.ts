/**
 * Zamiana zadania cyklicznego z passą (nawyk, `kind = 'habit'`) na zwykłe zadanie z powtarzaniem
 * (seria, `kind = 'task'`) i odwrotnie. Reguła (`recurrence`) i historia (`task_completions` — te
 * same id `completionId` w obu rodzajach) zostają; zmienia się rodzaj i pola terminu:
 *
 * - nawyk → seria: termin = najbliższe od dziś wystąpienie bez wpisu, godzina = pora nawyku,
 *   cel ilościowy i pora znikają (cofnięcie je przywraca);
 * - seria → nawyk: termin, godzina i początek znikają, godzina terminu zostaje porą nawyku.
 *
 * Nie da się zamienić: nawyku z celem „N razy w okresie” (seria nie ma takiej reguły), serii „po
 * ukończeniu” (nawyk liczy passę według stałych dni), podzadania ani zadania z podzadaniami.
 */
import { habitNextDate, toHabit, type HabitCompletion, type HabitSettings } from './habits.ts';
import type { LocalDate } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';
import type { ViewTask } from './views.ts';

/** Podtytuł widoku „Cykliczne” (nawyki + zwykłe zadania z powtarzaniem). */
export const HABITS_VIEW_NOTE = 'Nawyki z passą i zwykłe zadania z powtarzaniem';

export const HABIT_CONVERT = {
  toSeries: 'Zamień na zadanie z powtarzaniem',
  toHabit: 'Zamień na nawyk',
} as const;

type ConvertTask = Pick<ViewTask, 'id' | 'kind' | 'title' | 'parentId' | 'recurrence' | 'habit' | 'dueDate' | 'dueTime' | 'startDate'>;

export interface ConvertResult {
  ops: TaskOp[];
  undo: TaskOp[];
  /** Komunikat po zamianie (toast z „Cofnij”). */
  message: string;
}

/** Dlaczego nawyku nie da się zamienić na serię; `null` = da się. */
export function habitToSeriesProblem(task: ConvertTask): string | null {
  if (task.kind !== 'habit') return 'To nie jest nawyk.';
  if (!toHabit(task)) return 'Nawyk nie ma harmonogramu.';
  if (task.habit?.goal) return 'Cel „N razy w tygodniu / miesiącu” nie ma odpowiednika w zadaniu z powtarzaniem — najpierw ustaw konkretne dni.';
  return null;
}

/** Dlaczego serii nie da się zamienić na nawyk; `null` = da się. `subtasks` = liczba podzadań (bez kosza). */
export function seriesToHabitProblem(task: ConvertTask, { subtasks = 0 }: { subtasks?: number } = {}): string | null {
  if (task.kind !== 'task' || !task.recurrence) return 'Zadanie się nie powtarza.';
  if (task.recurrence.mode !== 'schedule') return 'Powtarzanie „po ukończeniu” nie ma stałych dni, więc nie da się liczyć passy — najpierw ustaw powtarzanie według kalendarza.';
  if (task.parentId) return 'Podzadanie nie może być nawykiem.';
  if (subtasks > 0) return 'Nawyk nie ma podzadań — najpierw je przenieś albo usuń.';
  return null;
}

const restore = (task: ConvertTask): TaskOp => ({
  table: 'tasks',
  id: task.id,
  patch: { kind: task.kind, habit: task.habit, due_date: task.dueDate, due_time: task.dueTime, start_date: task.startDate },
});

/** Nawyk → zwykłe zadanie z powtarzaniem. Błąd, gdy `habitToSeriesProblem` coś zwraca. */
export function habitToSeriesOps(task: ConvertTask, completions: readonly HabitCompletion[], today: LocalDate): ConvertResult {
  const problem = habitToSeriesProblem(task);
  if (problem) throw new Error(problem);
  const due = habitNextDate(toHabit(task)!, completions, today);
  return {
    ops: [{ table: 'tasks', id: task.id, patch: { kind: 'task', habit: null, due_date: due, due_time: due ? (task.habit?.time ?? null) : null, start_date: null } }],
    undo: [restore(task)],
    message: `„${task.title}” jest teraz zadaniem z powtarzaniem`,
  };
}

/** Zwykłe zadanie z powtarzaniem → nawyk. Błąd, gdy `seriesToHabitProblem` coś zwraca. */
export function seriesToHabitOps(task: ConvertTask, { subtasks = 0 }: { subtasks?: number } = {}): ConvertResult {
  const problem = seriesToHabitProblem(task, { subtasks });
  if (problem) throw new Error(problem);
  const habit: HabitSettings = task.dueTime ? { time: task.dueTime } : {};
  return {
    ops: [{ table: 'tasks', id: task.id, patch: { kind: 'habit', habit, due_date: null, due_time: null, start_date: null } }],
    undo: [restore(task)],
    message: `„${task.title}” jest teraz nawykiem`,
  };
}
