/**
 * Edytor reguły powtarzania (M7) — stan formularza ↔ `Recurrence`, gotowe szablony i podgląd
 * najbliższych dat. Web i telefon budują ten sam formularz na tych funkcjach; opis po polsku
 * daje `describeRecurrence`.
 */
import { addDays, addMonths, isoWeekday, lastDayOfMonth } from './dates.ts';
import { formatRrule, occurrences, parseRrule, WEEKDAY_CODES, type Recurrence, type RRule, type WeekdayCode } from './recurrence.ts';
import type { LocalDate } from './schemas/primitives.ts';

export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';
/** Miesięcznie: dzień miesiąca / N-ty dzień tygodnia / ostatni dzień / ostatni dzień roboczy. */
export type MonthlyBy = 'day' | 'weekday' | 'last_day' | 'last_workday';
export type RecurrenceEnd = { kind: 'never' } | { kind: 'until'; date: LocalDate } | { kind: 'count'; n: number };

export interface RecurrenceDraft {
  mode: 'schedule' | 'after_completion';
  /** Harmonogram: jednostka i co ile; po ukończeniu: odstęp. */
  unit: RecurrenceUnit;
  interval: number;
  /** Tygodniowo: dni tygodnia (puste = dzień kotwicy). */
  days: WeekdayCode[];
  monthlyBy: MonthlyBy;
  /** Miesięcznie „dzień”: dni miesiąca (−1 = ostatni). */
  monthDays: number[];
  /** Miesięcznie „dzień tygodnia”: który (1–5, −1 = ostatni) i jaki. */
  nth: number;
  weekday: WeekdayCode;
  /** Rocznie: miesiąc i dzień. */
  month: number;
  monthDay: number;
  end: RecurrenceEnd;
}

export const MAX_INTERVAL = 999;
export const MAX_COUNT = 999;
const FREQ: Record<RecurrenceUnit, RRule['freq']> = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
const UNIT: Record<RRule['freq'], RecurrenceUnit> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const WORKDAYS: WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR'];

const anchorParts = (anchor: LocalDate) => {
  const day = Number(anchor.slice(8));
  const weekday = WEEKDAY_CODES[isoWeekday(anchor) - 1]!;
  const isLastWeek = Number(addDays(anchor, 7).slice(5, 7)) !== Number(anchor.slice(5, 7));
  return { day, weekday, month: Number(anchor.slice(5, 7)), nth: Math.ceil(day / 7) > 4 && isLastWeek ? -1 : Math.ceil(day / 7) };
};

/** Formularz dla istniejącej reguły (albo domyślny: co tydzień w dzień kotwicy). */
export function draftFromRecurrence(recurrence: Recurrence | null, anchor: LocalDate): RecurrenceDraft {
  const a = anchorParts(anchor);
  const base: RecurrenceDraft = {
    mode: 'schedule', unit: 'week', interval: 1, days: [a.weekday], monthlyBy: 'day', monthDays: [a.day],
    nth: a.nth, weekday: a.weekday, month: a.month, monthDay: a.day, end: { kind: 'never' },
  };
  if (!recurrence) return base;
  if (recurrence.mode === 'after_completion') return { ...base, mode: 'after_completion', unit: recurrence.every.unit, interval: recurrence.every.n };
  const rule = parseRrule(recurrence.rrule);
  const draft: RecurrenceDraft = {
    ...base,
    unit: UNIT[rule.freq],
    interval: rule.interval,
    end: rule.until ? { kind: 'until', date: rule.until } : rule.count ? { kind: 'count', n: rule.count } : { kind: 'never' },
  };
  if (rule.freq === 'WEEKLY' && rule.byDay.length) draft.days = rule.byDay.map((d) => d.day);
  if (rule.freq === 'MONTHLY') {
    const workdays = rule.byDay.length === 5 && WORKDAYS.every((d) => rule.byDay.some((b) => b.day === d));
    if (workdays && rule.bySetPos[0] === -1) draft.monthlyBy = 'last_workday';
    else if (rule.byDay.length === 1 && rule.byDay[0]!.n !== undefined) {
      draft.monthlyBy = 'weekday';
      draft.nth = rule.byDay[0]!.n!;
      draft.weekday = rule.byDay[0]!.day;
    } else if (rule.byMonthDay.length === 1 && rule.byMonthDay[0] === -1) draft.monthlyBy = 'last_day';
    else if (rule.byMonthDay.length) draft.monthDays = [...rule.byMonthDay];
  }
  if (rule.freq === 'YEARLY') {
    if (rule.byMonth.length === 1) draft.month = rule.byMonth[0]!;
    if (rule.byMonthDay.length === 1) draft.monthDay = rule.byMonthDay[0]!;
  }
  return draft;
}

/** Błąd formularza po polsku albo `null`. */
export function draftError(draft: RecurrenceDraft): string | null {
  if (!Number.isInteger(draft.interval) || draft.interval < 1 || draft.interval > MAX_INTERVAL) return `„Co ile” musi być liczbą od 1 do ${MAX_INTERVAL}.`;
  if (draft.mode === 'after_completion') return null;
  if (draft.unit === 'week' && !draft.days.length) return 'Wybierz co najmniej jeden dzień tygodnia.';
  if (draft.unit === 'month' && draft.monthlyBy === 'day' && (!draft.monthDays.length || draft.monthDays.some((d) => !Number.isInteger(d) || d === 0 || d < -1 || d > 31)))
    return 'Dzień miesiąca od 1 do 31 (albo „ostatni”).';
  if (draft.unit === 'year' && (draft.monthDay < 1 || draft.monthDay > Number(lastDayOfMonth(`2024-${String(draft.month).padStart(2, '0')}-01`).slice(8))))
    return 'Taki dzień nie istnieje w tym miesiącu.';
  if (draft.end.kind === 'count' && (!Number.isInteger(draft.end.n) || draft.end.n < 1 || draft.end.n > MAX_COUNT)) return `Liczba powtórzeń od 1 do ${MAX_COUNT}.`;
  return null;
}

/** Reguła z formularza; kotwica = pierwsze pasujące wystąpienie od `anchor` (jak szybkie dodawanie). */
export function recurrenceFromDraft(draft: RecurrenceDraft, anchor: LocalDate): Recurrence {
  const error = draftError(draft);
  if (error) throw new Error(error);
  if (draft.mode === 'after_completion') return { mode: 'after_completion', every: { unit: draft.unit, n: draft.interval } };
  const rule: RRule = { freq: FREQ[draft.unit], interval: draft.interval, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [] };
  if (draft.unit === 'week') rule.byDay = WEEKDAY_CODES.filter((d) => draft.days.includes(d)).map((day) => ({ day }));
  if (draft.unit === 'month') {
    if (draft.monthlyBy === 'day') rule.byMonthDay = [...new Set(draft.monthDays)].sort((x, y) => (x === -1 ? 1 : y === -1 ? -1 : x - y));
    if (draft.monthlyBy === 'last_day') rule.byMonthDay = [-1];
    if (draft.monthlyBy === 'weekday') rule.byDay = [{ n: draft.nth, day: draft.weekday }];
    if (draft.monthlyBy === 'last_workday') {
      rule.byDay = WORKDAYS.map((day) => ({ day }));
      rule.bySetPos = [-1];
    }
  }
  if (draft.unit === 'year') {
    rule.byMonth = [draft.month];
    rule.byMonthDay = [draft.monthDay];
  }
  if (draft.end.kind === 'until') rule.until = draft.end.date;
  if (draft.end.kind === 'count') rule.count = draft.end.n;
  const rrule = formatRrule(rule);
  const first = occurrences({ mode: 'schedule', rrule, anchor }, { from: anchor, limit: 1 })[0];
  return { mode: 'schedule', rrule, anchor: first ?? anchor };
}

/**
 * Najbliższe daty serii od `from` (podgląd w edytorze). „Po ukończeniu” — przy założeniu, że każde
 * wystąpienie jest ukończone w swoim terminie.
 */
export function previewDates(recurrence: Recurrence, from: LocalDate, count = 5): LocalDate[] {
  if (recurrence.mode === 'schedule') return occurrences(recurrence, { from: from > recurrence.anchor ? from : recurrence.anchor, limit: count });
  const { unit, n } = recurrence.every;
  const out: LocalDate[] = [from];
  while (out.length < count) {
    const last = out.at(-1)!;
    out.push(unit === 'day' ? addDays(last, n) : unit === 'week' ? addDays(last, 7 * n) : addMonths(last, unit === 'month' ? n : 12 * n));
  }
  return out;
}

export interface RecurrenceTemplate {
  id: string;
  label: string;
  draft: RecurrenceDraft;
}

/** Gotowe szablony dla terminu `anchor` (dzień tygodnia i miesiąca brane z kotwicy). */
export function recurrenceTemplates(anchor: LocalDate): RecurrenceTemplate[] {
  const base = draftFromRecurrence(null, anchor);
  const t = (id: string, label: string, patch: Partial<RecurrenceDraft>): RecurrenceTemplate => ({ id, label, draft: { ...base, ...patch } });
  return [
    t('daily', 'Codziennie', { unit: 'day' }),
    t('workdays', 'W dni robocze', { unit: 'week', days: [...WORKDAYS] }),
    t('weekly', 'Co tydzień', { unit: 'week' }),
    t('biweekly', 'Co 2 tygodnie', { unit: 'week', interval: 2 }),
    t('monthly', 'Co miesiąc', { unit: 'month', monthlyBy: 'day' }),
    t('monthly_weekday', 'Co miesiąc (dzień tygodnia)', { unit: 'month', monthlyBy: 'weekday' }),
    t('last_day', 'Ostatni dzień miesiąca', { unit: 'month', monthlyBy: 'last_day' }),
    t('quarterly', 'Co 3 miesiące', { unit: 'month', interval: 3, monthlyBy: 'day' }),
    t('yearly', 'Co roku', { unit: 'year' }),
    t('after_3d', '3 dni po ukończeniu', { mode: 'after_completion', unit: 'day', interval: 3 }),
  ];
}
