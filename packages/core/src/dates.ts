/**
 * Daty pływające `RRRR-MM-DD` (SPECYFIKACJA §5): liczone w UTC z południa, więc zmiana czasu
 * (DST) i strefa urządzenia nie przesuwają dnia.
 */
import type { LocalDate, LocalTime } from './schemas/primitives.ts';

const toDate = (date: LocalDate) => new Date(`${date}T12:00:00Z`);
const fromDate = (d: Date): LocalDate => d.toISOString().slice(0, 10);

/**
 * Dzień lokalny chwili `instant` w strefie `timeZone` (domyślnie urządzenia): „Dziś” i dzień
 * ukończenia (`completed_at timestamptz`) liczone według zegara ściennego (SPECYFIKACJA §7.1).
 */
export function localDateAt(instant: Date | string, timeZone?: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Lokalny zegar ścienny chwili jako `RRRR-MM-DDTGG:MM` (kontekst `now` szybkiego dodawania). */
export function localDateTimeAt(instant: Date | string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Dni między datami (`to` − `from`); ujemne, gdy `to` jest wcześniej. */
export const daysBetween = (from: LocalDate, to: LocalDate): number => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);

/**
 * Przesunięcie o `n` dni roboczych (`workdays` — numery ISO, domyślnie pon.–pt.): liczone są tylko
 * dni robocze po drodze, więc wynik (dla `n` ≠ 0) zawsze wypada w dzień roboczy.
 */
export function addWorkdays(date: LocalDate, n: number, workdays: readonly number[] = [1, 2, 3, 4, 5]): LocalDate {
  if (n === 0 || !workdays.length) return date;
  const step = Math.sign(n);
  let d = date;
  for (let left = Math.abs(n); left > 0; ) {
    d = addDays(d, step);
    if (workdays.includes(isoWeekday(d))) left--;
  }
  return d;
}

/** Pierwszy dzień tygodnia zawierającego `date`; `firstDay` jak w ISO (1 = poniedziałek, 7 = niedziela). */
export const weekStart = (date: LocalDate, firstDay = 1): LocalDate => addDays(date, -((isoWeekday(date) - firstDay + 7) % 7));

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDate(d);
}

/** Ostatni dzień miesiąca daty. */
export function lastDayOfMonth(date: LocalDate): LocalDate {
  const d = toDate(`${date.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return fromDate(d);
}

/** Dodaj miesiące; brak dnia w docelowym miesiącu (31 → luty) = ostatni dzień miesiąca. */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const [y, m, day] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const first = `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
  const last = dayOfMonth(lastDayOfMonth(first));
  return `${first.slice(0, 8)}${String(Math.min(day, last)).padStart(2, '0')}`;
}

export const dayOfMonth = (date: LocalDate): number => Number(date.slice(8, 10));

/** 1 = poniedziałek … 7 = niedziela. */
export const isoWeekday = (date: LocalDate): number => ((toDate(date).getUTCDay() + 6) % 7) + 1;

/** `RRRR-MM-DDTGG:MM` → data i godzina. */
export function parseLocalDateTime(value: string): { date: LocalDate; time: LocalTime } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (!match) throw new Error(`Niepoprawna data i godzina: „${value}”.`);
  return { date: match[1]!, time: match[2]! };
}
