/**
 * Daty pływające `RRRR-MM-DD` (SPECYFIKACJA §5): liczone w UTC z południa, więc zmiana czasu
 * (DST) i strefa urządzenia nie przesuwają dnia.
 */
import type { LocalDate, LocalTime } from './schemas/primitives.ts';

const toDate = (date: LocalDate) => new Date(`${date}T12:00:00Z`);
const fromDate = (d: Date): LocalDate => d.toISOString().slice(0, 10);

// `Intl.DateTimeFormat` jest drogi w tworzeniu (kalendarz liczy setki chwil na widok) — jeden na strefę
// (strefa urządzenia ustala się przy pierwszym użyciu, do przeładowania strony).
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: 'date' | 'minute' | 'second', timeZone?: string): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone ?? ''}`;
  let f = formatters.get(key);
  if (!f) {
    const time = kind === 'date' ? {} : { hourCycle: 'h23' as const, hour: '2-digit' as const, minute: '2-digit' as const, ...(kind === 'second' && { second: '2-digit' as const }) };
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', ...time });
    formatters.set(key, f);
  }
  return f;
}

/**
 * Dzień lokalny chwili `instant` w strefie `timeZone` (domyślnie urządzenia): „Dziś” i dzień
 * ukończenia (`completed_at timestamptz`) liczone według zegara ściennego (SPECYFIKACJA §7.1).
 */
export function localDateAt(instant: Date | string, timeZone?: string): LocalDate {
  const parts = formatter('date', timeZone).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Lokalny zegar ścienny chwili jako `RRRR-MM-DDTGG:MM` (kontekst `now` szybkiego dodawania). */
export function localDateTimeAt(instant: Date | string, timeZone?: string): string {
  const parts = formatter('minute', timeZone).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Przesunięcie strefy w chwili `ms` (minuty; Warszawa zimą = 60). */
function zoneOffsetMin(ms: number, timeZone?: string): number {
  const parts = formatter('second', timeZone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * Chwila, w której zegar ścienny strefy `timeZone` pokazuje `date` `time` (czas pływający → instant).
 * Przy zmianie czasu: godzina, której nie ma (wiosną 2:30), przesuwa się o godzinę do przodu
 * (3:30); godzina podwójna (jesienią 2:30) — pierwsze wystąpienie (jeszcze czas letni).
 */
export function zonedInstant(date: LocalDate, time: LocalTime, timeZone?: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Przesunięcia dobę przed i dobę po — obejmują obie strony ewentualnej zmiany czasu.
  const before = zoneOffsetMin(wall - 86_400_000, timeZone);
  const after = zoneOffsetMin(wall + 86_400_000, timeZone);
  const candidates = [wall - before * 60_000, wall - after * 60_000].sort((a, b) => a - b);
  for (const c of candidates) if (c + zoneOffsetMin(c, timeZone) * 60_000 === wall) return new Date(c);
  // Godzina w luce: przesunięcie sprzed luki (wynik o tyle później, ile luka trwa).
  return new Date(wall - Math.min(before, after) * 60_000);
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

/**
 * Siatka miesiąca daty (widok miesiąca w kalendarzu): pełne tygodnie od tygodnia z 1. dniem do
 * tygodnia z ostatnim dniem, każdy po 7 dni od `firstDay` (ISO: 1 = poniedziałek).
 */
export function monthWeeks(date: LocalDate, firstDay = 1): LocalDate[][] {
  const last = lastDayOfMonth(date);
  const weeks: LocalDate[][] = [];
  for (let start = weekStart(`${date.slice(0, 7)}-01`, firstDay); start <= last; start = addDays(start, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  return weeks;
}

/** 1 = poniedziałek … 7 = niedziela. */
export const isoWeekday = (date: LocalDate): number => ((toDate(date).getUTCDay() + 6) % 7) + 1;

/** `RRRR-MM-DDTGG:MM` → data i godzina. */
export function parseLocalDateTime(value: string): { date: LocalDate; time: LocalTime } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (!match) throw new Error(`Niepoprawna data i godzina: „${value}”.`);
  return { date: match[1]!, time: match[2]! };
}
