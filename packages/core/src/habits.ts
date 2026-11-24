/**
 * Nawyki (SPECYFIKACJA M15, §7.5): passa, najdłuższa passa, regularność i stan dni do mapy cieplnej.
 *
 * Okres nawyku: wystąpienie reguły (codziennie, dni robocze, wybrane dni) albo tydzień/miesiąc
 * przy celu „N razy”. Okres zaliczony = zrobione (przy celu ilościowym: wartość ≥ cel);
 * dzień wolny (`skipped`) nie przerywa passy i nie zalicza; okres w toku (dziś / bieżący
 * tydzień) nie przerywa passy, dopóki się nie skończy.
 */
import { z } from 'zod';

import { addDays, daysBetween, isoWeekday } from './dates.ts';
import { pluralForm } from './format.ts';
import { completionId, uuidv7 } from './ids.ts';
import { WEEKDAY } from './labels.ts';
import { describeRecurrence, formatRrule, occurrences, parseRrule, WEEKDAY_CODES, type Recurrence, type RRule, type ScheduleRecurrence, type WeekdayCode } from './recurrence.ts';
import { draftFromRecurrence, MAX_COUNT, recurrenceFromDraft, type MonthlyBy, type RecurrenceEnd } from './recurrence-editor.ts';
import { LocalTime, type IsoWeekday, type LocalDate } from './schemas/primitives.ts';
import { keyBetween } from './sort-key.ts';
import type { TaskOp } from './tasks.ts';
import { habitDueOn, isOpen, type ViewTask } from './views.ts';

/** Zawartość `tasks.habit` (jsonb). */
export const HabitSettings = z.object({
  goal: z.object({ period: z.enum(['week', 'month']), times: z.number().int().min(1).max(31) }).optional(),
  target: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  /** Pora nawyku (Etap 8): godzina przypomnień względnych; brak = domyślna godzina z ustawień. */
  time: LocalTime.optional(),
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
  // Nawyk z końcem (`UNTIL`): okresy do dnia końca; ostatni kończy się wraz z nawykiem.
  const last = habitEndDate(habit);
  const stop = last !== null && last < today ? last : today;
  for (let start = periodStart(habit.recurrence.anchor, period); start <= stop; start = addDays(periodEnd(start, period), 1)) {
    const end = periodEnd(start, period);
    let done = 0;
    let skipped = 0;
    for (let d = start; d <= end && d <= stop; d = addDays(d, 1)) {
      const c = byDate.get(d);
      if (counts(c)) done++;
      else if (c?.kind === 'skipped') skipped++;
    }
    const open = end >= today && (last === null || last >= today);
    const state: PeriodState = done >= times ? 'done' : open ? 'pending' : done + skipped >= times ? 'skipped' : 'missed';
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
  // Okresy liczone względem prawdziwego „dziś”: dzień `to` sprzed dziś bez wpisu jest opuszczony, nie „w toku”.
  const periods = habitPeriods(habit, completions, today).filter((p) => p.end >= from && p.start <= to);
  const done = periods.filter((p) => p.state === 'done').length;
  const possible = periods.filter((p) => p.state === 'done' || p.state === 'missed').length;
  return { done, possible, rate: possible ? done / possible : null };
}

export type DayState = 'done' | 'partial' | 'skipped' | 'missed' | 'pending' | 'off';

/** Stan każdego dnia zakresu (mapa cieplna, kalendarz nawyku). */
export function habitDays(habit: Habit, completions: readonly HabitCompletion[], from: LocalDate, to: LocalDate, today: LocalDate): { date: LocalDate; state: DayState }[] {
  const { byDate, counts } = index(habit, completions);
  const scheduled = new Set(habit.goal ? [] : occurrences(habit.recurrence, { from, to, limit: 5000 }));
  const last = habit.goal ? habitEndDate(habit) : null;
  const days: { date: LocalDate; state: DayState }[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const c = byDate.get(date);
    let state: DayState;
    if (counts(c)) state = 'done';
    else if (c?.kind === 'done') state = 'partial';
    else if (c?.kind === 'skipped') state = 'skipped';
    else if (habit.goal ? date > today || (last !== null && date > last) : !scheduled.has(date) || date > today) state = 'off';
    else state = date === today ? 'pending' : habit.goal ? 'off' : 'missed';
    days.push({ date, state });
  }
  return days;
}

// ── Etap 8: nawyk z zadania, stan dnia, odhaczanie ───────────────────────────────────────────

/** Ile dni wstecz można uzupełnić (M15): dziś i 7 poprzednich dni. */
export const HABIT_BACKFILL_DAYS = 7;

/** Nawyk z pól zadania; zadanie bez reguły według harmonogramu nie jest nawykiem do liczenia. */
export function toHabit(task: { recurrence: Recurrence | null; habit: HabitSettings | null }): Habit | null {
  if (task.recurrence?.mode !== 'schedule') return null;
  return { ...(task.habit ?? {}), recurrence: task.recurrence };
}

/** Wiersz lokalnej bazy `task_completions` → `HabitCompletion`. */
export const toHabitCompletion = (row: { occurrence_date: unknown; kind: unknown; value: unknown }): HabitCompletion => ({
  date: String(row.occurrence_date) as LocalDate,
  kind: row.kind === 'skipped' ? 'skipped' : 'done',
  value: row.value === null || row.value === undefined || row.value === '' ? null : Number(row.value),
});

/** Najdawniejszy dzień, który można jeszcze uzupełnić (nie wcześniej niż początek nawyku). */
export const habitBackfillFrom = (habit: Habit, today: LocalDate): LocalDate => {
  const limit = addDays(today, -HABIT_BACKFILL_DAYS);
  return habit.recurrence.anchor > limit ? habit.recurrence.anchor : limit;
};

/** Czy dzień można odhaczyć / zmienić: od `habitBackfillFrom` do dziś. */
export const canEditHabitDay = (habit: Habit, date: LocalDate, today: LocalDate): boolean => date <= today && date >= habitBackfillFrom(habit, today);

export interface HabitDayStatus {
  date: LocalDate;
  state: DayState;
  /** Wpis dnia (albo brak). */
  entry: HabitCompletion | null;
  /** Postęp celu ilościowego: wartość dnia (`done` bez wartości = cel osiągnięty). */
  value: number | null;
  /** Okres „N razy w tygodniu/miesiącu”, do którego należy dzień. */
  period: { start: LocalDate; end: LocalDate; done: number; times: number; state: PeriodState } | null;
  /** Czy w tym dniu jest wystąpienie reguły (przy celu „N razy” — każdy dzień trwającej serii). */
  scheduled: boolean;
}

/** Stan jednego dnia nawyku — wiersz w „Dziś”, pasek 7 dni, powiadomienie. */
export function habitDayStatus(habit: Habit, completions: readonly HabitCompletion[], date: LocalDate, today: LocalDate): HabitDayStatus {
  const { byDate } = index(habit, completions);
  const entry = byDate.get(date) ?? null;
  const [day] = habitDays(habit, completions, date, date, today);
  const value = entry?.kind === 'done' ? (entry.value ?? habit.target ?? null) : null;
  let period: HabitDayStatus['period'] = null;
  if (habit.goal) {
    const p = habitPeriods(habit, completions, today).find((x) => x.start <= date && x.end >= date);
    if (p) period = { start: p.start, end: p.end, done: p.done, times: habit.goal.times, state: p.state };
  }
  const next = occurrences(habit.recurrence, { from: date, to: habit.goal ? undefined : date, limit: 1 });
  return { date, state: day!.state, entry, value, period, scheduled: date >= habit.recurrence.anchor && next.length > 0 };
}

/**
 * Czy przypominać o nawyku w danym dniu: nie, gdy dzień jest już zaliczony albo wolny, a przy celu
 * „N razy” — gdy cel okresu jest już osiągnięty. Częściowa wartość (3 z 8) przypomina dalej.
 */
export function habitNeedsReminder(habit: Habit, completions: readonly HabitCompletion[], date: LocalDate): boolean {
  if (habitEnded(habit, date)) return false;
  const { byDate, counts } = index(habit, completions);
  const c = byDate.get(date);
  if (counts(c) || c?.kind === 'skipped') return false;
  if (!habit.goal) return true;
  let done = 0;
  for (let d = periodStart(date, habit.goal.period); d <= date; d = addDays(d, 1)) if (counts(byDate.get(d))) done++;
  return done < habit.goal.times;
}

/** Wpis dnia do zapisania; `null` = wyczyszczenie dnia. */
export type HabitEntry = { kind: 'done'; value?: number | null } | { kind: 'skipped' } | null;

export interface HabitEntryOptions {
  now: Date | string;
  today: LocalDate;
  /** Obecny wpis dnia — do „Cofnij”. */
  previous?: HabitCompletion | null;
}

/**
 * Odhaczenie / dzień wolny / wartość / wyczyszczenie dnia nawyku jako operacje `mutate` na
 * `task_completions`. Id deterministyczne (`completionId`), więc dwa urządzenia piszą ten sam
 * wiersz (LWW per pole — dwa równoległe „+1” dają jedną wartość). Dzień spoza okna uzupełniania
 * (`HABIT_BACKFILL_DAYS`), przed początkiem nawyku albo przyszły — błąd.
 */
export function habitEntryOps(habit: Habit, taskId: string, date: LocalDate, entry: HabitEntry, { now, today, previous = null }: HabitEntryOptions): { ops: TaskOp[]; undo: TaskOp[] } {
  if (date > today) throw new Error('Nie można odhaczyć dnia, który jeszcze nie nadszedł.');
  if (date < habit.recurrence.anchor) throw new Error('Ten dzień jest przed początkiem zadania cyklicznego.');
  if (date < addDays(today, -HABIT_BACKFILL_DAYS)) throw new Error(`Można uzupełnić najwyżej ${HABIT_BACKFILL_DAYS} dni wstecz.`);
  const at = new Date(now).toISOString();
  const id = completionId(taskId, date);
  const write = (e: HabitEntry): TaskOp =>
    e
      ? { table: 'task_completions', id, patch: { task_id: taskId, occurrence_date: date, kind: e.kind, value: e.kind === 'done' ? (e.value ?? null) : null, completed_at: at, deleted_at: null } }
      : { table: 'task_completions', id, patch: { deleted_at: at } };
  return { ops: [write(entry)], undo: [write(previous ? (previous.kind === 'done' ? { kind: 'done', value: previous.value ?? null } : { kind: 'skipped' }) : null)] };
}

/** Kolejny stan dnia po kliknięciu w pasku dni: brak → zrobione → wolne → brak. */
export function nextHabitEntry(habit: Habit, current: HabitCompletion | null): HabitEntry {
  if (!current) return { kind: 'done', value: habit.target ?? null };
  if (current.kind === 'done') return { kind: 'skipped' };
  return null;
}

/** Zmiana wartości celu ilościowego o `delta` (np. +1 szklanka); 0 i mniej czyści dzień. */
export function addHabitValue(habit: Habit, current: HabitCompletion | null, delta: number): HabitEntry {
  const base = current?.kind === 'done' ? (current.value ?? habit.target ?? 0) : 0;
  const value = Math.round((base + delta) * 100) / 100;
  return value > 0 ? { kind: 'done', value } : null;
}

// ── Etap 8: statystyki (M15) ─────────────────────────────────────────────────────────────────

export const HABIT_RATE_WINDOWS = [7, 30, 90] as const;
export type HabitRateWindow = (typeof HABIT_RATE_WINDOWS)[number];

export interface HabitRate {
  done: number;
  possible: number;
  rate: number | null;
}

export interface HabitStats {
  streak: HabitStreak;
  /** Regularność ostatnich 7/30/90 dni (do dziś): zaliczone okresy / okresy bez wolnych i bez „w toku”. */
  rates: Record<HabitRateWindow, HabitRate>;
  /** Dni zaliczone od początku nawyku. */
  totalDone: number;
  /** Suma wartości celu ilościowego od początku (np. wypite szklanki); bez celu — dni zrobione. */
  totalValue: number;
}

/** Ostatni wpis dnia wygrywa (jak `index`). */
const dedupe = (completions: readonly HabitCompletion[]) => [...new Map(completions.map((c) => [c.date, c])).values()];

export function habitStats(habit: Habit, completions: readonly HabitCompletion[], today: LocalDate): HabitStats {
  const { counts } = index(habit, completions);
  const rates = {} as Record<HabitRateWindow, HabitRate>;
  for (const days of HABIT_RATE_WINDOWS) rates[days] = habitRate(habit, completions, addDays(today, 1 - days), today, today);
  let totalDone = 0;
  let totalValue = 0;
  for (const c of dedupe(completions)) {
    if (c.date < habit.recurrence.anchor || c.date > today || c.kind !== 'done') continue;
    if (counts(c)) totalDone++;
    totalValue += habit.target === undefined ? 1 : (c.value ?? habit.target);
  }
  return { streak: habitStreak(habit, completions, today), rates, totalDone, totalValue };
}

export interface HabitWeek {
  /** Poniedziałek tygodnia (ISO). */
  start: LocalDate;
  end: LocalDate;
  /** Dni zaliczone w tygodniu. */
  done: number;
  /** Cel tygodnia: zaplanowane wystąpienia albo N przy „N razy w tygodniu”; przy celu miesięcznym `null`. */
  target: number | null;
  /** Suma wartości celu ilościowego w tygodniu (bez celu ilościowego — liczba dni zrobionych). */
  value: number;
}

/** Wykres tygodniowy: ostatnie `count` tygodni (ISO) do bieżącego włącznie, od najstarszego. */
export function habitWeeks(habit: Habit, completions: readonly HabitCompletion[], today: LocalDate, count = 12): HabitWeek[] {
  const { byDate, counts } = index(habit, completions);
  const current = addDays(today, 1 - isoWeekday(today));
  const last = habitEndDate(habit);
  const weeks: HabitWeek[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = addDays(current, -7 * i);
    const end = addDays(start, 6);
    let done = 0;
    let value = 0;
    for (let d = start; d <= end && d <= today; d = addDays(d, 1)) {
      const c = byDate.get(d);
      if (d < habit.recurrence.anchor || c?.kind !== 'done') continue;
      if (counts(c)) done++;
      value += habit.target === undefined ? 1 : (c.value ?? habit.target);
    }
    const from = start < habit.recurrence.anchor ? habit.recurrence.anchor : start;
    const target = habit.goal ? (habit.goal.period !== 'week' ? null : last !== null && start > last ? 0 : habit.goal.times) : from > end ? 0 : occurrences(habit.recurrence, { from, to: end, limit: 7 }).length;
    weeks.push({ start, end, done, target, value });
  }
  return weeks;
}

export interface HabitHeatDay {
  date: LocalDate;
  state: DayState;
  value: number | null;
  /** Dzień po dziś (pusta komórka, chyba że `planned`). */
  future: boolean;
  /** Przyszły dzień nawyku według reguły (nie przy celu „N razy w okresie” — tam dni nie są ustalone). */
  planned: boolean;
  /** Dzień spoza wybranego roku kalendarzowego (`year`) — pusta komórka w pierwszym / ostatnim tygodniu. */
  outside: boolean;
}

export interface HabitYear {
  /** Kolumny = tygodnie (pon–ndz), od najstarszego; bez `year` 53 kolumny (+ `ahead`), ostatnia z dziś. */
  weeks: HabitHeatDay[][];
  /** Kolumny, w których zaczyna się miesiąc (etykiety nad mapą). */
  months: { column: number; month: number }[];
  /** Dni w każdym stanie w ostatnich 365 dniach (z `year` — w tym roku) do dziś. */
  counts: Record<DayState, number>;
}

/** Liczba dni w każdym stanie. */
export function habitDayCounts(days: readonly { state: DayState }[]): Record<DayState, number> {
  const counts: Record<DayState, number> = { done: 0, partial: 0, skipped: 0, missed: 0, pending: 0, off: 0 };
  for (const d of days) counts[d.state]++;
  return counts;
}

/**
 * Mapa cieplna roku. Bez `year`: 53 tygodnie do bieżącego włącznie (+ `ahead` tygodni naprzód z
 * zaplanowanymi dniami). Z `year`: rok kalendarzowy — tygodnie pon–ndz od tego z 1 stycznia do tego
 * z 31 grudnia; dni spoza roku są `outside`.
 */
export function habitYear(habit: Habit, completions: readonly HabitCompletion[], today: LocalDate, { ahead = 0, year }: { ahead?: number; year?: number } = {}): HabitYear {
  const { byDate } = index(habit, completions);
  let from: LocalDate;
  let end: LocalDate;
  let first: LocalDate;
  let lastDay: LocalDate;
  if (year === undefined) {
    const current = addDays(today, 7 - isoWeekday(today));
    from = addDays(current, -53 * 7 + 1);
    end = addDays(current, ahead * 7);
    first = addDays(today, -364);
    lastDay = end;
  } else {
    first = `${String(year).padStart(4, '0')}-01-01` as LocalDate;
    lastDay = `${String(year).padStart(4, '0')}-12-31` as LocalDate;
    from = addDays(first, 1 - isoWeekday(first));
    end = addDays(lastDay, 7 - isoWeekday(lastDay));
  }
  const days = habitDays(habit, completions, from, end, today);
  const after = addDays(today, 1);
  const planned = new Set(habit.goal || end < after ? [] : occurrences(habit.recurrence, { from: from > after ? from : after, to: end, limit: 1000 }));
  const weeks: HabitHeatDay[][] = [];
  const months: HabitYear['months'] = [];
  days.forEach((d, i) => {
    const column = Math.floor(i / 7);
    if (i % 7 === 0) weeks.push([]);
    const c = byDate.get(d.date);
    const outside = year !== undefined && (d.date < first || d.date > lastDay);
    weeks[column]!.push({ date: d.date, state: d.state, value: c?.kind === 'done' ? (c.value ?? null) : null, future: d.date > today, planned: !outside && planned.has(d.date), outside });
    if (d.date.endsWith('-01') && !outside) months.push({ column, month: Number(d.date.slice(5, 7)) });
  });
  return { weeks, months, counts: habitDayCounts(days.filter((d) => d.date <= today && d.date >= first && d.date <= lastDay)) };
}

/**
 * Lata do przeglądania mapy nawyku: od roku początku (albo najstarszego wpisu) do roku końca nawyku,
 * a bez końca — do przyszłego roku (zaplanowane dni); zawsze z bieżącym.
 */
export function habitYearRange(habit: Habit, completions: readonly HabitCompletion[], today: LocalDate): { min: number; max: number } {
  const year = (d: LocalDate) => Number(d.slice(0, 4));
  const now = year(today);
  const oldest = completions.reduce((m, c) => (c.date < m ? c.date : m), habit.recurrence.anchor);
  const last = habitEndDate(habit);
  const min = Math.min(year(oldest), now);
  return { min, max: last === null ? now + 1 : Math.max(now, year(last)) };
}

// ── Nawyki w kalendarzu i planie dnia ────────────────────────────────────────────────────────

/** Nawyk z porą w danym dniu — blok w kalendarzu / planie dnia (`time-blocking.ts`). */
export interface HabitSlot {
  id: string;
  title: string;
  date: LocalDate;
  time: LocalTime;
  /** Stan dnia; przyszły dzień według reguły = `pending`. */
  state: DayState;
  /** Dzień po dziś (do odczytu, jak przyszłe wystąpienia serii). */
  future: boolean;
}

/**
 * Nawyki z porą (`habit.time`) w dniach `[from, to)`: dni według reguły (od początku do końca nawyku)
 * oraz dni z wpisem spoza reguły. Bez nawyków zakończonych i bez celu „N razy w okresie” (dni nie są
 * ustalone — zostają w bloku „Cykliczne”).
 */
export function habitSlots(
  tasks: readonly Pick<ViewTask, 'id' | 'title' | 'kind' | 'status' | 'recurrence' | 'habit'>[],
  completions: ReadonlyMap<string, readonly HabitCompletion[]>,
  from: LocalDate,
  to: LocalDate,
  today: LocalDate,
): HabitSlot[] {
  if (to <= from) return [];
  const out: HabitSlot[] = [];
  for (const task of tasks) {
    if (task.kind !== 'habit' || !isOpen(task) || !task.habit?.time) continue;
    const habit = toHabit(task);
    if (!habit || habit.goal) continue;
    const list = completions.get(task.id) ?? [];
    const last = addDays(to, -1);
    const scheduled = new Set(occurrences(habit.recurrence, { from, to: last, limit: 1000 }));
    const logged = new Set(list.map((c) => c.date));
    for (const day of habitDays(habit, list, from, last, today)) {
      if (!scheduled.has(day.date) && !logged.has(day.date)) continue;
      const future = day.date > today;
      out.push({ id: task.id, title: task.title, date: day.date, time: task.habit.time, state: future && day.state === 'off' ? 'pending' : day.state, future });
    }
  }
  return out;
}

// ── Etap 8: formularz nawyku ─────────────────────────────────────────────────────────────────

export type HabitSchedule =
  | { kind: 'daily' }
  | { kind: 'days'; days: IsoWeekday[] }
  | { kind: 'goal'; period: 'week' | 'month'; times: number }
  /**
   * Co miesiąc w ustalony dzień: `day` (1–31; w krótszym miesiącu bez wystąpienia), N-ty dzień
   * tygodnia (`nth` 1–4 albo −1 = ostatni, `weekday`), ostatni dzień albo ostatni dzień roboczy.
   */
  | { kind: 'monthly'; by: MonthlyBy; day: number; nth: number; weekday: WeekdayCode }
  /** Reguła spoza formularza (np. z szybkiego dodawania „co 2 dni”) — zostaje bez zmian. */
  | { kind: 'custom'; rrule: string };

export interface HabitDraft {
  schedule: HabitSchedule;
  /** Początek nawyku (kotwica reguły). */
  start: LocalDate;
  /** Koniec: nigdy, w dniu (`UNTIL`) albo po N wystąpieniach (`COUNT`; nie przy „N razy w okresie”). Brak = nigdy. */
  end?: RecurrenceEnd;
  target: number | null;
  unit: string | null;
  time: LocalTime | null;
}

/** Domyślny „co miesiąc” z dnia początku: ten sam dzień miesiąca / ten sam N-ty dzień tygodnia. */
export function habitMonthly(start: LocalDate): Extract<HabitSchedule, { kind: 'monthly' }> {
  const d = draftFromRecurrence(null, start);
  return { kind: 'monthly', by: 'day', day: d.monthDays[0]!, nth: d.nth, weekday: d.weekday };
}

/** Formularz z pól zadania (nowy nawyk: codziennie od dziś). */
export function habitDraft(task: { recurrence: Recurrence | null; habit: HabitSettings | null } | null, today: LocalDate): HabitDraft {
  const habit = task ? toHabit(task) : null;
  const base: HabitDraft = { schedule: { kind: 'daily' }, start: habit?.recurrence.anchor ?? today, end: { kind: 'never' }, target: habit?.target ?? null, unit: habit?.unit ?? null, time: habit?.time ?? null };
  if (!habit) return base;
  const { count, until, ...rule } = parseRrule(habit.recurrence.rrule);
  base.end = until ? { kind: 'until', date: until } : count ? { kind: 'count', n: count } : { kind: 'never' };
  if (habit.goal) return { ...base, schedule: { kind: 'goal', ...habit.goal } };
  const simple = rule.interval === 1 && !rule.byMonthDay.length && !rule.byMonth.length && !rule.bySetPos.length;
  if (simple && rule.freq === 'DAILY' && !rule.byDay.length) return base;
  if (simple && rule.freq === 'WEEKLY' && rule.byDay.length && rule.byDay.every((d) => d.n === undefined)) {
    const days = rule.byDay.map((d) => (WEEKDAY_CODES.indexOf(d.day) + 1) as IsoWeekday).sort();
    return { ...base, schedule: days.length === 7 ? { kind: 'daily' } : { kind: 'days', days } };
  }
  if (rule.freq === 'MONTHLY' && rule.interval === 1 && !rule.byMonth.length) {
    const m = draftFromRecurrence({ mode: 'schedule', rrule: formatRrule(rule as RRule), anchor: habit.recurrence.anchor }, habit.recurrence.anchor);
    // Edytor nawyku zna jeden dzień miesiąca; kilka dni („1, 15”) zostaje własną regułą.
    if (m.monthlyBy !== 'day' || (m.monthDays.length === 1 && m.monthDays[0]! > 0)) {
      return { ...base, schedule: { kind: 'monthly', by: m.monthlyBy, day: m.monthDays[0]!, nth: m.nth, weekday: m.weekday } };
    }
  }
  return { ...base, schedule: { kind: 'custom', rrule: formatRrule(rule as RRule) } };
}

/** Formularz → pola zadania `recurrence` i `habit`. Błąd przy pustych dniach albo złym celu. */
export function habitFields(draft: HabitDraft): { recurrence: ScheduleRecurrence; habit: HabitSettings } {
  const { schedule } = draft;
  let rrule = 'FREQ=DAILY';
  const habit: HabitSettings = {};
  if (schedule.kind === 'days') {
    if (!schedule.days.length) throw new Error('Wybierz co najmniej jeden dzień tygodnia.');
    const days = [...new Set(schedule.days)].sort();
    if (days.length < 7) rrule = `FREQ=WEEKLY;BYDAY=${days.map((d) => WEEKDAY_CODES[d - 1]).join(',')}`;
  } else if (schedule.kind === 'monthly') {
    if (schedule.by === 'day' && (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 31)) throw new Error('Dzień miesiąca: od 1 do 31.');
    const monthly = { ...draftFromRecurrence(null, draft.start), unit: 'month' as const, monthlyBy: schedule.by, monthDays: [schedule.day], nth: schedule.nth, weekday: schedule.weekday };
    rrule = (recurrenceFromDraft(monthly, draft.start) as ScheduleRecurrence).rrule;
  } else if (schedule.kind === 'custom') {
    // Koniec reguły ustawia pole „Koniec” — własna reguła bez COUNT/UNTIL.
    const { count: _count, until: _until, ...rule } = parseRrule(schedule.rrule);
    rrule = formatRrule(rule as RRule);
  } else if (schedule.kind === 'goal') {
    const max = schedule.period === 'week' ? 7 : 31;
    if (!Number.isInteger(schedule.times) || schedule.times < 1 || schedule.times > max) throw new Error(`Liczba razy: od 1 do ${max}.`);
    habit.goal = { period: schedule.period, times: schedule.times };
  }
  if (draft.target !== null) {
    if (!(draft.target > 0)) throw new Error('Cel ilościowy musi być większy od zera.');
    habit.target = draft.target;
    const unit = draft.unit?.trim();
    if (unit) habit.unit = unit.slice(0, 20);
  }
  if (draft.time) habit.time = draft.time;
  const end = draft.end ?? { kind: 'never' };
  if (end.kind === 'until') {
    if (!end.date) throw new Error('Podaj dzień końca.');
    if (end.date < draft.start) throw new Error('Koniec nie może być przed początkiem.');
    rrule += `;UNTIL=${end.date.replace(/-/g, '')}`;
  } else if (end.kind === 'count') {
    if (schedule.kind === 'goal') throw new Error('Przy „N razy w okresie” koniec ustaw datą.');
    if (!Number.isInteger(end.n) || end.n < 1 || end.n > MAX_COUNT) throw new Error(`Liczba powtórzeń: od 1 do ${MAX_COUNT}.`);
    rrule += `;COUNT=${end.n}`;
  }
  parseRrule(rrule);
  return { recurrence: { mode: 'schedule', rrule, anchor: draft.start }, habit: HabitSettings.parse(habit) };
}

const TIMES: readonly [string, string, string] = ['raz', 'razy', 'razy'];

/**
 * Ostatni dzień nawyku: `UNTIL` albo ostatnie z `COUNT` wystąpień; `null` = bez końca.
 * Przy „N razy w okresie” reguła jest dzienna, więc `UNTIL` to ostatni dzień ostatniego okresu.
 */
export function habitEndDate(habit: Pick<Habit, 'recurrence'>): LocalDate | null {
  const rule = parseRrule(habit.recurrence.rrule);
  if (rule.until) return rule.until;
  if (!rule.count) return null;
  return occurrences(habit.recurrence, { limit: rule.count }).at(-1) ?? habit.recurrence.anchor;
}

/** Nawyk zakończony przed dniem `date` (po końcu reguły). */
export const habitEnded = (habit: Pick<Habit, 'recurrence'>, date: LocalDate): boolean => {
  const last = habitEndDate(habit);
  return last !== null && last < date;
};

const endText = (rrule: string): string => {
  const rule = parseRrule(rrule);
  if (rule.count) return `, ${rule.count} ${pluralForm(rule.count, TIMES)}`;
  if (rule.until) return `, do ${Number(rule.until.slice(8))}.${rule.until.slice(5, 7)}.${rule.until.slice(0, 4)}`;
  return '';
};

/** „codziennie”, „pon, śr, pt”, „3 razy w tygodniu” + „· cel 8 szklanek”. */
export function describeHabit(habit: Habit): string {
  let text: string;
  if (habit.goal) text = `${habit.goal.times} ${pluralForm(habit.goal.times, TIMES)} w ${habit.goal.period === 'week' ? 'tygodniu' : 'miesiącu'}${endText(habit.recurrence.rrule)}`;
  else {
    const { schedule } = habitDraft({ recurrence: habit.recurrence, habit }, habit.recurrence.anchor);
    text = schedule.kind === 'days' && schedule.days.length < 5 ? schedule.days.map((d) => WEEKDAY[d].short).join(', ') + endText(habit.recurrence.rrule) : describeRecurrence(habit.recurrence);
  }
  if (habit.target !== undefined) text += ` · cel ${habit.target}${habit.unit ? ` ${habit.unit}` : ''}`;
  return text;
}

/** Postęp dnia / okresu jako tekst: „3 / 8 szklanek”, „2 / 3 w tym tygodniu”. */
export function habitProgressLabel(habit: Habit, status: HabitDayStatus): string | null {
  const parts: string[] = [];
  if (habit.target !== undefined) parts.push(`${status.value ?? 0} / ${habit.target}${habit.unit ? ` ${habit.unit}` : ''}`);
  if (status.period) parts.push(`${status.period.done} / ${status.period.times} w ${habit.goal?.period === 'week' ? 'tym tygodniu' : 'tym miesiącu'}`);
  return parts.length ? parts.join(' · ') : null;
}

/** Dni od początku nawyku (włącznie z dziś). */
export const habitAgeDays = (habit: Habit, today: LocalDate): number => Math.max(0, daysBetween(habit.recurrence.anchor, today) + 1);

/** Przypomnienie nawyku w formularzu: względne (przed porą nawyku, w każdy jego dzień) albo jednorazowe. */
export type HabitReminderDraft =
  | { id?: string; kind: 'relative'; offsetMin: number }
  | { id?: string; kind: 'absolute'; atDate: LocalDate; atTime: LocalTime };

export interface HabitSaveInput {
  /** Brak = nowy nawyk. */
  id?: string;
  title: string;
  listId: string;
  draft: HabitDraft;
  /** Przypomnienie o porze zadania (względne, 0 min przed); ignorowane, gdy jest `reminders`. */
  remind?: boolean;
  /** Obecne przypomnienia nawyku — przy wyłączeniu usuwane, przy włączeniu nie dublowane. */
  reminderIds?: readonly string[];
  /**
   * Pełna lista przypomnień z formularza (zamiast `remind`): pozycje z `id` zostają, obecne spoza
   * listy są usuwane, pozycje bez `id` dodawane.
   */
  reminders?: readonly HabitReminderDraft[];
  /** Ostatni klucz kolejności na liście (nowy nawyk trafia na koniec). */
  lastSortKey?: string;
  now: Date | string;
  newId?: () => string;
}

/** Zapis formularza nawyku jako operacje `mutate`: zadanie `kind = 'habit'` i przypomnienie. */
export function habitSaveOps(input: HabitSaveInput): { taskId: string; ops: TaskOp[] } {
  const title = input.title.trim();
  if (!title) throw new Error('Zadanie cykliczne musi mieć nazwę.');
  const newId = input.newId ?? (() => uuidv7());
  const fields = habitFields(input.draft);
  const taskId = input.id ?? newId();
  const ops: TaskOp[] = [
    {
      table: 'tasks',
      id: taskId,
      patch: input.id
        ? { title: title.slice(0, 500), list_id: input.listId, ...fields }
        : {
            list_id: input.listId, parent_id: null, kind: 'habit', title: title.slice(0, 500), status: 'todo', priority: 4,
            due_date: null, due_time: null, duration_min: null, ...fields, sort_key: keyBetween(input.lastSortKey), source: { kind: 'manual' },
          },
    },
  ];
  const existing = input.reminderIds ?? [];
  if (input.reminders) {
    const now = new Date(input.now).toISOString();
    const kept = new Set(input.reminders.flatMap((r) => (r.id ? [r.id] : [])));
    for (const id of existing) if (!kept.has(id)) ops.push({ table: 'reminders', id, patch: { deleted_at: now } });
    for (const r of input.reminders) {
      if (r.id) continue;
      if (r.kind === 'relative') {
        if (!Number.isInteger(r.offsetMin) || r.offsetMin < 0 || r.offsetMin > 40320) throw new Error('Wyprzedzenie przypomnienia: od 0 do 28 dni.');
        ops.push({ table: 'reminders', id: newId(), patch: { task_id: taskId, kind: 'relative', offset_min: r.offsetMin, at_date: null, at_time: null } });
      } else {
        if (!r.atDate || !r.atTime) throw new Error('Podaj dzień i godzinę przypomnienia.');
        ops.push({ table: 'reminders', id: newId(), patch: { task_id: taskId, kind: 'absolute', offset_min: null, at_date: r.atDate, at_time: r.atTime } });
      }
    }
    return { taskId, ops };
  }
  if (input.remind && !existing.length) ops.push({ table: 'reminders', id: newId(), patch: { task_id: taskId, kind: 'relative', offset_min: 0, at_date: null, at_time: null } });
  if (!input.remind) for (const id of existing) ops.push({ table: 'reminders', id, patch: { deleted_at: new Date(input.now).toISOString() } });
  return { taskId, ops };
}

export interface HabitForDay {
  task: ViewTask;
  habit: Habit;
  status: HabitDayStatus;
  streak: HabitStreak;
  /** Dzień załatwiony: zrobione, wolne albo cel okresu „N razy” już osiągnięty. */
  settled: boolean;
}

/**
 * Nawyki do odhaczenia w dniu `date` (blok „Dziś”, licznik w pasku bocznym) w kolejności `tasks` —
 * otwarte, z okresem w tym dniu, opcjonalnie z jednej przestrzeni.
 */
export function habitsForDay(
  tasks: readonly ViewTask[],
  completions: ReadonlyMap<string, readonly HabitCompletion[]>,
  date: LocalDate,
  today: LocalDate,
  workspaceId?: string | null,
): HabitForDay[] {
  const out: HabitForDay[] = [];
  for (const task of tasks) {
    if (task.kind !== 'habit' || !isOpen(task) || (workspaceId && task.workspaceId !== workspaceId) || !habitDueOn(task, date)) continue;
    const habit = toHabit(task);
    if (!habit) continue;
    const list = completions.get(task.id) ?? [];
    const status = habitDayStatus(habit, list, date, today);
    const settled = status.state === 'done' || status.state === 'skipped' || (status.period !== null && status.period.done >= status.period.times);
    out.push({ task, habit, status, streak: habitStreak(habit, list, today), settled });
  }
  return out;
}
