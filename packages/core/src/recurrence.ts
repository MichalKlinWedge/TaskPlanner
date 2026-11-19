/**
 * Silnik cykliczności (SPECYFIKACJA §7.2). Własny podzbiór RRULE (RFC 5545) na datach pływających
 * — bez stref, więc zmiana czasu niczego nie przesuwa — plus tryb „po ukończeniu”.
 *
 * Obsługiwane: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (z pozycją w MONTHLY/YEARLY),
 * BYMONTHDAY (także ujemne), BYMONTH, BYSETPOS, COUNT, UNTIL (data). Tydzień od poniedziałku.
 * Daty nieistniejące (31 listopada, 30 lutego) są pomijane, jak w RFC.
 */
import { z } from 'zod';

import { addDays, addMonths, isoWeekday, lastDayOfMonth } from './dates.ts';
import { LocalDate } from './schemas/primitives.ts';

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export interface RRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay: { n?: number; day: WeekdayCode }[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  count?: number;
  until?: LocalDate;
}

export const Recurrence = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('schedule'), rrule: z.string(), anchor: LocalDate }),
  z.object({
    mode: z.literal('after_completion'),
    every: z.object({ unit: z.enum(['day', 'week', 'month', 'year']), n: z.number().int().min(1).max(999) }),
  }),
]);
export type Recurrence = z.infer<typeof Recurrence>;
export type ScheduleRecurrence = Extract<Recurrence, { mode: 'schedule' }>;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): LocalDate => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => Number(lastDayOfMonth(ymd(y, m, 1)).slice(8));
const weekdayIndex = (code: WeekdayCode) => WEEKDAY_CODES.indexOf(code) + 1;

// ── RRULE tekst ↔ struktura ──────────────────────────────────────────────────────────────────

export function parseRrule(text: string): RRule {
  const rule: RRule = { freq: 'DAILY', interval: 1, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [] };
  let hasFreq = false;
  const ints = (value: string, min: number, max: number, name: string) =>
    value.split(',').map((part) => {
      const n = Number(part);
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) < min || Math.abs(n) > max) throw new Error(`RRULE: zła wartość ${name}=${value}`);
      return n;
    });
  for (const part of text.replace(/^RRULE:/i, '').split(';').filter(Boolean)) {
    const [key, value = ''] = part.split('=') as [string, string?];
    switch (key.toUpperCase()) {
      case 'FREQ':
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(value)) throw new Error(`RRULE: nieobsługiwane FREQ=${value}`);
        rule.freq = value as RRule['freq'];
        hasFreq = true;
        break;
      case 'INTERVAL':
        rule.interval = ints(value, 1, 999, 'INTERVAL')[0]!;
        if (rule.interval < 1) throw new Error('RRULE: INTERVAL < 1');
        break;
      case 'BYDAY':
        rule.byDay = value.split(',').map((item) => {
          const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
          if (!match) throw new Error(`RRULE: zły BYDAY=${item}`);
          return match[1] ? { n: Number(match[1]), day: match[2] as WeekdayCode } : { day: match[2] as WeekdayCode };
        });
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = ints(value, 1, 31, 'BYMONTHDAY');
        break;
      case 'BYMONTH':
        rule.byMonth = ints(value, 1, 12, 'BYMONTH');
        if (rule.byMonth.some((m) => m < 0)) throw new Error('RRULE: ujemny BYMONTH');
        break;
      case 'BYSETPOS':
        rule.bySetPos = ints(value, 1, 366, 'BYSETPOS');
        break;
      case 'COUNT':
        rule.count = ints(value, 1, 10000, 'COUNT')[0]!;
        break;
      case 'UNTIL': {
        const match = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(value);
        if (!match) throw new Error(`RRULE: zły UNTIL=${value}`);
        rule.until = `${match[1]}-${match[2]}-${match[3]}`;
        break;
      }
      case 'WKST':
        if (value !== 'MO') throw new Error('RRULE: obsługiwany tylko WKST=MO');
        break;
      default:
        throw new Error(`RRULE: nieobsługiwana część ${key}`);
    }
  }
  if (!hasFreq) throw new Error('RRULE: brak FREQ');
  if (rule.count && rule.until) throw new Error('RRULE: COUNT i UNTIL naraz');
  if (rule.byDay.some((d) => d.n !== undefined) && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
    throw new Error('RRULE: BYDAY z pozycją tylko w MONTHLY/YEARLY');
  }
  // YEARLY + BYDAY bez BYMONTH to w RFC „N-ty dzień tygodnia w roku” — poza podzbiorem.
  if (rule.freq === 'YEARLY' && rule.byDay.length && !rule.byMonth.length) throw new Error('RRULE: YEARLY z BYDAY wymaga BYMONTH');
  return rule;
}

export function formatRrule(rule: RRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byMonth.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byDay.length) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.n ?? ''}${d.day}`).join(',')}`);
  if (rule.bySetPos.length) parts.push(`BYSETPOS=${rule.bySetPos.join(',')}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}`);
  return parts.join(';');
}

// ── Wystąpienia ──────────────────────────────────────────────────────────────────────────────

/** Dni miesiąca pasujące do BYMONTHDAY / BYDAY (domyślnie dzień z kotwicy). */
function monthCandidates(rule: RRule, y: number, m: number, anchorDay: number): number[] {
  const last = daysIn(y, m);
  const fromMonthDay = rule.byMonthDay.map((d) => (d > 0 ? d : last + 1 + d)).filter((d) => d >= 1 && d <= last);
  if (!rule.byDay.length) return rule.byMonthDay.length ? fromMonthDay : anchorDay <= last ? [anchorDay] : [];
  const firstWeekday = isoWeekday(ymd(y, m, 1));
  const fromDay = new Set<number>();
  for (const { n, day } of rule.byDay) {
    const all: number[] = [];
    for (let d = 1 + ((weekdayIndex(day) - firstWeekday + 7) % 7); d <= last; d += 7) all.push(d);
    if (n === undefined) all.forEach((d) => fromDay.add(d));
    else {
      const pick = n > 0 ? all[n - 1] : all[all.length + n];
      if (pick !== undefined) fromDay.add(pick);
    }
  }
  const days = [...fromDay];
  return rule.byMonthDay.length ? days.filter((d) => fromMonthDay.includes(d)) : days;
}

function applySetPos(rule: RRule, dates: LocalDate[]): LocalDate[] {
  const sorted = [...new Set(dates)].sort();
  if (!rule.bySetPos.length) return sorted;
  return [...new Set(rule.bySetPos.map((p) => (p > 0 ? sorted[p - 1] : sorted[sorted.length + p])).filter((d): d is LocalDate => !!d))].sort();
}

/** Kandydaci jednego okresu (dzień / tydzień / miesiąc / rok) o numerze `k` od kotwicy. */
function period(rule: RRule, anchor: LocalDate, k: number): LocalDate[] {
  const [ay, am, ad] = anchor.split('-').map(Number) as [number, number, number];
  const byMonthOk = (date: LocalDate) => !rule.byMonth.length || rule.byMonth.includes(Number(date.slice(5, 7)));
  switch (rule.freq) {
    case 'DAILY': {
      const date = addDays(anchor, k * rule.interval);
      const day = Number(date.slice(8));
      const last = daysIn(Number(date.slice(0, 4)), Number(date.slice(5, 7)));
      const monthDayOk = !rule.byMonthDay.length || rule.byMonthDay.some((d) => (d > 0 ? d : last + 1 + d) === day);
      const dayOk = !rule.byDay.length || rule.byDay.some((d) => weekdayIndex(d.day) === isoWeekday(date));
      return byMonthOk(date) && monthDayOk && dayOk ? [date] : [];
    }
    case 'WEEKLY': {
      const monday = addDays(anchor, 1 - isoWeekday(anchor) + 7 * k * rule.interval);
      const days = rule.byDay.length ? rule.byDay.map((d) => weekdayIndex(d.day)) : [isoWeekday(anchor)];
      return applySetPos(rule, days.map((d) => addDays(monday, d - 1)).filter(byMonthOk));
    }
    case 'MONTHLY': {
      const first = addMonths(ymd(ay, am, 1), k * rule.interval);
      const [y, m] = first.split('-').map(Number) as [number, number];
      if (rule.byMonth.length && !rule.byMonth.includes(m)) return [];
      return applySetPos(rule, monthCandidates(rule, y, m, ad).map((d) => ymd(y, m, d)));
    }
    case 'YEARLY': {
      const y = ay + k * rule.interval;
      const months = rule.byMonth.length ? rule.byMonth : [am];
      return applySetPos(rule, months.flatMap((m) => monthCandidates(rule, y, m, ad).map((d) => ymd(y, m, d))));
    }
  }
}

export interface OccurrenceOptions {
  /** Pierwsza data brana pod uwagę (włącznie). */
  from?: LocalDate;
  /** Ostatnia data (włącznie). */
  to?: LocalDate;
  /** Najwyżej tyle dat. */
  limit?: number;
}

const dayNumber = (date: LocalDate) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;

/**
 * Numer okresu, od którego warto szukać dat ≥ `from` (o jeden wcześniej — okres może zaczynać się
 * przed `from`). Bez tego seria codzienna sprzed lat liczyłaby każdy dzień od kotwicy.
 */
function firstPeriod(rule: RRule, anchor: LocalDate, from: LocalDate): number {
  if (from <= anchor) return 0;
  const [ay, am] = anchor.split('-').map(Number) as [number, number];
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const units =
    rule.freq === 'DAILY'
      ? dayNumber(from) - dayNumber(anchor)
      : rule.freq === 'WEEKLY'
        ? Math.floor((dayNumber(from) - dayNumber(addDays(anchor, 1 - isoWeekday(anchor)))) / 7)
        : rule.freq === 'MONTHLY'
          ? (fy - ay) * 12 + (fm - am)
          : fy - ay;
  return Math.max(0, Math.floor(units / rule.interval) - 1);
}

/** Wystąpienia reguły od kotwicy (włącznie), z `COUNT` liczonym od kotwicy. */
export function occurrences(recurrence: ScheduleRecurrence, { from, to, limit = 1000 }: OccurrenceOptions = {}): LocalDate[] {
  const rule = parseRrule(recurrence.rrule);
  const out: LocalDate[] = [];
  let counted = 0;
  // `COUNT` liczy od kotwicy, więc tylko bez niego można przeskoczyć do `from`.
  const start = from && !rule.count ? firstPeriod(rule, recurrence.anchor, from) : 0;
  // Pusty okres nie kończy pętli (29 lutego, 31. dnia), ale ogranicza ją bezpiecznik.
  for (let k = start, empty = 0; empty < 2000 && out.length < limit; k++) {
    const dates = period(rule, recurrence.anchor, k).filter((d) => d >= recurrence.anchor);
    empty = dates.length ? 0 : empty + 1;
    for (const date of dates) {
      if (rule.until && date > rule.until) return out;
      if (to && date > to) return out;
      counted++;
      if (rule.count && counted > rule.count) return out;
      if (!from || date >= from) out.push(date);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Pierwsze wystąpienie ściśle po dacie (brak = seria się skończyła). */
export function nextOccurrence(recurrence: ScheduleRecurrence, after: LocalDate): LocalDate | null {
  return occurrences(recurrence, { from: addDays(after, 1), limit: 1 })[0] ?? null;
}

/**
 * Termin po ukończeniu wystąpienia `occurrence` w dniu `completedOn` (SPECYFIKACJA §7.2):
 * według harmonogramu — pierwsze wystąpienie po późniejszej z tych dat (zaległa seria nie
 * zalewa zaległymi wystąpieniami); po ukończeniu — `completedOn` + odstęp.
 */
export function nextDue(recurrence: Recurrence, { occurrence, completedOn }: { occurrence: LocalDate; completedOn: LocalDate }): LocalDate | null {
  if (recurrence.mode === 'after_completion') {
    const { unit, n } = recurrence.every;
    return unit === 'day' ? addDays(completedOn, n) : unit === 'week' ? addDays(completedOn, 7 * n) : addMonths(completedOn, unit === 'month' ? n : 12 * n);
  }
  return nextOccurrence(recurrence, occurrence > completedOn ? occurrence : completedOn);
}

// ── Opis po polsku ───────────────────────────────────────────────────────────────────────────

const DAY_ACC = { MO: 'poniedziałek', TU: 'wtorek', WE: 'środę', TH: 'czwartek', FR: 'piątek', SA: 'sobotę', SU: 'niedzielę' } as const;
const FEMININE = new Set<WeekdayCode>(['WE', 'SA', 'SU']);
const ORDINAL = { 1: ['pierwszy', 'pierwszą'], 2: ['drugi', 'drugą'], 3: ['trzeci', 'trzecią'], 4: ['czwarty', 'czwartą'], 5: ['piąty', 'piątą'], [-1]: ['ostatni', 'ostatnią'] } as Record<number, [string, string]>;
const MONTH_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const UNIT_FORMS = { day: ['dzień', 'dni', 'dni'], week: ['tydzień', 'tygodnie', 'tygodni'], month: ['miesiąc', 'miesiące', 'miesięcy'], year: ['rok', 'lata', 'lat'] } as const;

const every = (n: number, unit: keyof typeof UNIT_FORMS): string => {
  if (n === 1) return `co ${UNIT_FORMS[unit][0]}`;
  const ones = n % 10;
  const tens = n % 100;
  const form = ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 1 : 2;
  return `co ${n} ${UNIT_FORMS[unit][form]}`;
};
const ordinal = (n: number, day: WeekdayCode) => ORDINAL[n]?.[FEMININE.has(day) ? 1 : 0] ?? `${n}.`;
const listPl = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} i ${items.at(-1)}` : (items[0] ?? ''));
const monthDayPl = (d: number) => (d === -1 ? 'ostatniego' : `${d}.`);
const isWorkdays = (rule: RRule) => rule.byDay.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => rule.byDay.some((b) => b.day === d && b.n === undefined));

/**
 * „co drugi wtorek”, „ostatniego dnia roboczego miesiąca”, „co 3 dni po ukończeniu”. Formy, które
 * rozumie szybkie dodawanie, wracają przez `parseQuickAdd` do tej samej reguły (test „tam i z powrotem”).
 */
export function describeRecurrence(recurrence: Recurrence): string {
  if (recurrence.mode === 'after_completion') return `${every(recurrence.every.n, recurrence.every.unit)} po ukończeniu`;
  const rule = parseRrule(recurrence.rrule);
  const anchorDay = Number(recurrence.anchor.slice(8));
  const anchorMonth = Number(recurrence.anchor.slice(5, 7));
  let text: string;
  switch (rule.freq) {
    case 'DAILY':
      text = rule.interval === 1 ? 'codziennie' : every(rule.interval, 'day');
      break;
    case 'WEEKLY': {
      const days = rule.byDay.length ? rule.byDay.map((d) => d.day) : [WEEKDAY_CODES[isoWeekday(recurrence.anchor) - 1]!];
      if (rule.interval === 1 && isWorkdays(rule)) text = 'w dni robocze';
      else if (days.length === 1) {
        const day = days[0]!;
        text = rule.interval === 1 ? `w ${FEMININE.has(day) ? 'każdą' : 'każdy'} ${DAY_ACC[day]}` : rule.interval <= 4 ? `co ${ordinal(rule.interval, day)} ${DAY_ACC[day]}` : `${every(rule.interval, 'week')}, ${DAY_ACC[day]}`;
      } else text = `${rule.interval === 1 ? 'w' : `${every(rule.interval, 'week')},`} ${listPl(days.map((d) => DAY_ACC[d]))}`;
      break;
    }
    case 'MONTHLY': {
      const prefix = rule.interval === 1 ? '' : `${every(rule.interval, 'month')}, `;
      if (isWorkdays(rule) && rule.bySetPos.length === 1 && rule.bySetPos[0] === -1) text = `${prefix}ostatniego dnia roboczego miesiąca`;
      else if (rule.byDay.length === 1 && rule.byDay[0]!.n !== undefined && !rule.byMonthDay.length) {
        const { n, day } = rule.byDay[0]! as { n: number; day: WeekdayCode };
        text = `${prefix}${ordinal(n, day)} ${DAY_ACC[day]} miesiąca`;
      } else if (rule.byMonthDay.length && !rule.byDay.length) {
        text = `${prefix}${listPl(rule.byMonthDay.map(monthDayPl))} dnia miesiąca`;
      } else if (!rule.byDay.length) text = `${prefix || 'co miesiąc, '}${anchorDay}. dnia`.replace(/, $/, '');
      else text = `${every(rule.interval, 'month')} (${rule.byDay.map((d) => `${d.n ?? ''}${d.day}`).join(', ')})`;
      break;
    }
    case 'YEARLY': {
      const month = rule.byMonth.length === 1 ? rule.byMonth[0]! : anchorMonth;
      const day = rule.byMonthDay.length === 1 ? rule.byMonthDay[0]! : anchorDay;
      text = rule.byDay.length || rule.byMonth.length > 1 || rule.byMonthDay.length > 1 ? `${every(rule.interval, 'year')} (${formatRrule(rule)})` : `${rule.interval === 1 ? 'co roku' : every(rule.interval, 'year')} ${day} ${MONTH_GEN[month - 1]}`;
      break;
    }
  }
  if (rule.count) text += `, ${rule.count} ${rule.count === 1 ? 'raz' : 'razy'}`;
  if (rule.until) text += `, do ${Number(rule.until.slice(8))}.${rule.until.slice(5, 7)}.${rule.until.slice(0, 4)}`;
  return text;
}
