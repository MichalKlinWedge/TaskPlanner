/**
 * Nawyki (SPECYFIKACJA M15, §7.5): passa, najdłuższa passa, regularność i stan dni do mapy cieplnej.
 *
 * Okres nawyku: wystąpienie reguły (codziennie, dni robocze, wybrane dni) albo tydzień/miesiąc
 * przy celu „N razy”. Okres zaliczony = zrobione (przy celu ilościowym: wartość ≥ cel);
 * dzień wolny (`skipped`) nie przerywa passy i nie zalicza; okres w toku (dziś / bieżący
 * tydzień) nie przerywa passy, dopóki się nie skończy.
 */
import { z } from 'zod';

import { addDays, isoWeekday } from './dates.ts';
import { occurrences, type ScheduleRecurrence } from './recurrence.ts';
import type { LocalDate } from './schemas/primitives.ts';

/** Zawartość `tasks.habit` (jsonb). */
export const HabitSettings = z.object({
  goal: z.object({ period: z.enum(['week', 'month']), times: z.number().int().min(1).max(31) }).optional(),
  target: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
});
export type HabitSettings = z.infer<typeof HabitSettings>;

export interface Habit extends HabitSettings {
  recurrence: ScheduleRecurrence;
}

export interface HabitCompletion {
  date: LocalDate;
  kind: 'done' | 'skipped';
  value?: number | null;
}

export type PeriodState = 'done' | 'skipped' | 'missed' | 'pending';

export interface HabitPeriod {
  /** Wystąpienie albo pierwszy dzień tygodnia / miesiąca. */
  start: LocalDate;
  end: LocalDate;
  state: PeriodState;
  done: number;
}

const periodStart = (date: LocalDate, period: 'week' | 'month') => (period === 'week' ? addDays(date, 1 - isoWeekday(date)) : `${date.slice(0, 8)}01`);
const periodEnd = (start: LocalDate, period: 'week' | 'month') => {
  if (period === 'week') return addDays(start, 6);
  const next = new Date(`${start}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1, 0);
  return next.toISOString().slice(0, 10);
};

function index(habit: Habit, completions: readonly HabitCompletion[]) {
  const byDate = new Map<LocalDate, HabitCompletion>();
  for (const c of completions) byDate.set(c.date, c);
  const counts = (c: HabitCompletion | undefined) => c?.kind === 'done' && (habit.target === undefined || (c.value ?? habit.target) >= habit.target);
  return { byDate, counts };
}

/** Okresy nawyku od kotwicy do dziś (włącznie) ze stanami. */
export function habitPeriods(habit: Habit, completions: readonly HabitCompletion[], today: LocalDate): HabitPeriod[] {
  const { byDate, counts } = index(habit, completions);
  if (!habit.goal) {
    return occurrences(habit.recurrence, { to: today, limit: 5000 }).map((date) => {
      const c = byDate.get(date);
      const state: PeriodState = counts(c) ? 'done' : c?.kind === 'skipped' ? 'skipped' : date === today ? 'pending' : 'missed';
      return { start: date, end: date, state, done: state === 'done' ? 1 : 0 };
    });
  }
  const { period, times } = habit.goal;
  const periods: HabitPeriod[] = [];
  for (let start = periodStart(habit.recurrence.anchor, period); start <= today; start = addDays(periodEnd(start, period), 1)) {
    const end = periodEnd(start, period);
    let done = 0;
    let skipped = 0;
    for (let d = start; d <= end && d <= today; d = addDays(d, 1)) {
      const c = byDate.get(d);
      if (counts(c)) done++;
      else if (c?.kind === 'skipped') skipped++;
    }
    const state: PeriodState = done >= times ? 'done' : end >= today ? 'pending' : done + skipped >= times ? 'skipped' : 'missed';
    periods.push({ start, end, state, done });
  }
  return periods;
}

export interface HabitStreak {
  current: number;
  best: number;
  unit: 'occurrence' | 'week' | 'month';
}

export function habitStreak(habit: Habit, completions: readonly HabitCompletion[], today: LocalDate): HabitStreak {
  const periods = habitPeriods(habit, completions, today);
  let current = 0;
  for (let i = periods.length - 1; i >= 0; i--) {
    const state = periods[i]!.state;
    if (state === 'missed') break;
    if (state === 'done') current++;
  }
  let best = 0;
  let run = 0;
  for (const { state } of periods) {
    if (state === 'missed') run = 0;
    else if (state === 'done') best = Math.max(best, ++run);
  }
  return { current, best, unit: habit.goal?.period ?? 'occurrence' };
}

/** Regularność w zakresie: zaliczone / (okresy − wolne − w toku). */
export function habitRate(habit: Habit, completions: readonly HabitCompletion[], from: LocalDate, to: LocalDate, today: LocalDate) {
  const periods = habitPeriods(habit, completions, today < to ? today : to).filter((p) => p.end >= from && p.start <= to);
  const done = periods.filter((p) => p.state === 'done').length;
  const possible = periods.filter((p) => p.state === 'done' || p.state === 'missed').length;
  return { done, possible, rate: possible ? done / possible : null };
}

export type DayState = 'done' | 'partial' | 'skipped' | 'missed' | 'pending' | 'off';

/** Stan każdego dnia zakresu (mapa cieplna, kalendarz nawyku). */
export function habitDays(habit: Habit, completions: readonly HabitCompletion[], from: LocalDate, to: LocalDate, today: LocalDate): { date: LocalDate; state: DayState }[] {
  const { byDate, counts } = index(habit, completions);
  const scheduled = new Set(habit.goal ? [] : occurrences(habit.recurrence, { from, to, limit: 5000 }));
  const days: { date: LocalDate; state: DayState }[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const c = byDate.get(date);
    let state: DayState;
    if (counts(c)) state = 'done';
    else if (c?.kind === 'done') state = 'partial';
    else if (c?.kind === 'skipped') state = 'skipped';
    else if (habit.goal ? date > today : !scheduled.has(date) || date > today) state = 'off';
    else state = date === today ? 'pending' : habit.goal ? 'off' : 'missed';
    days.push({ date, state });
  }
  return days;
}
