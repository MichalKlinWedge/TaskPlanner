/**
 * Widżety Android (SPECYFIKACJA M20, Etap 11): co pokazują „Dziś”, „Nawyki” i „Szybkie dodawanie”
 * i jaki stan docelowy niesie każde kliknięcie. Te same reguły co ekrany (`selectToday`,
 * `selectInbox`, `habitsForDay`); aplikacja tylko rysuje wynik.
 *
 * Kliknięcie w widżecie zapisuje **stan docelowy** (ukończone / otwarte, wpis dnia nawyku z
 * wartością), a nie „przełącz” — powtórzona obsługa tego samego kliknięcia nic nie zmienia.
 */
import { habitProgressLabel, habitsForDay, type HabitCompletion, type HabitEntry } from './habits.ts';
import type { LocalDate } from './schemas/primitives.ts';
import { selectInbox, selectToday, type ViewContext, type ViewTask } from './views.ts';

/** Najwięcej wierszy w widżecie „Dziś” (M20). */
export const WIDGET_TASK_LIMIT = 10;

export interface WidgetTaskItem {
  id: string;
  title: string;
  done: boolean;
  time: string | null;
  overdue: boolean;
  /** Wystąpienie serii, które ukończy kliknięcie (stare kliknięcie nie ukończy kolejnego). */
  occurrence: LocalDate | null;
}

export interface TodayWidgetModel {
  items: WidgetTaskItem[];
  /** Otwarte na dziś (zaległe + dziś), także te poza limitem. */
  open: number;
  /** Ile wierszy nie zmieściło się w limicie. */
  more: number;
}

/** „Dziś”: zaległe, dziś, potem ukończone dziś — razem najwyżej `limit`; otwarte mają pierwszeństwo. */
export function todayWidgetModel(tasks: readonly ViewTask[], ctx: ViewContext, limit = WIDGET_TASK_LIMIT): TodayWidgetModel {
  const view = selectToday(tasks, ctx);
  const all = [...view.overdue, ...view.today, ...view.done];
  const items = all.slice(0, limit).map(
    (t): WidgetTaskItem => ({
      id: t.id,
      title: t.title,
      done: t.status === 'done',
      time: t.dueTime,
      overdue: !!t.dueDate && t.dueDate < ctx.today && t.status !== 'done',
      occurrence: t.recurrence ? t.dueDate : null,
    }),
  );
  return { items, open: view.overdue.length + view.today.length, more: all.length - items.length };
}

export interface WidgetHabitItem {
  id: string;
  title: string;
  /** Dzień zaliczony (zrobione albo cel ilościowy osiągnięty). */
  done: boolean;
  /** Dzień załatwiony: zrobione, wolne albo cel okresu „N razy” już osiągnięty. */
  settled: boolean;
  /** „3 / 8 szklanek”, „2 / 3 w tym tygodniu”. */
  progress: string | null;
  /** Wpis po kliknięciu w pole: zrobione ↔ wyczyszczone. */
  toggle: HabitEntry;
  /** Wpis po „+1” (tylko nawyk z celem ilościowym, póki cel nieosiągnięty). */
  plusOne: HabitEntry | null;
}

export interface HabitsWidgetModel {
  date: LocalDate;
  items: WidgetHabitItem[];
  /** Ile nawyków zostało na dziś. */
  open: number;
}

/** „Nawyki”: nawyki z okresem na dziś w kolejności dnia; kliknięcie = wpis dnia `date`. */
export function habitsWidgetModel(tasks: readonly ViewTask[], completions: ReadonlyMap<string, readonly HabitCompletion[]>, ctx: ViewContext): HabitsWidgetModel {
  const ordered = selectToday(tasks, ctx).habits;
  const items = habitsForDay(ordered, completions, ctx.today, ctx.today, ctx.workspaceId).map(({ task, habit, status, settled }): WidgetHabitItem => {
    const done = status.state === 'done';
    const value = status.entry?.kind === 'done' ? (status.value ?? 0) : 0;
    return {
      id: task.id,
      title: task.title,
      done,
      settled,
      progress: habitProgressLabel(habit, status),
      toggle: done ? null : { kind: 'done', value: habit.target ?? null },
      plusOne: habit.target !== undefined && !done ? { kind: 'done', value: Math.round((value + 1) * 100) / 100 } : null,
    };
  });
  return { date: ctx.today, items, open: items.filter((h) => !h.settled).length };
}

/** Licznik Inbox na widżecie „Szybkie dodawanie” (M9: „Licznik w pasku bocznym i na widżecie”). */
export const inboxCount = (tasks: readonly ViewTask[], inboxListIds: ReadonlySet<string>, ctx: ViewContext): number => selectInbox(tasks, inboxListIds, ctx).length;

/** Czy wpis dnia już jest taki, jak chce kliknięcie (powtórzona obsługa → bez zapisu). */
export function sameHabitEntry(current: HabitCompletion | null, entry: HabitEntry): boolean {
  if (!entry) return !current;
  if (!current || current.kind !== entry.kind) return false;
  return entry.kind === 'skipped' || (current.value ?? null) === (entry.value ?? null);
}
