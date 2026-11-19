/**
 * Wspólne formatowanie napisów: odmiana po liczbie, czas trwania i daty kalendarzowe. Daty liczą
 * się w UTC z południa, bo to daty pływające (bez strefy), a nie chwile w czasie.
 * Podstawa z ExpeditionPlan (`packages/core/src/format.ts`).
 */
import { daysBetween, isoWeekday } from './dates.ts';
import { MONTH_SHORT, WEEKDAY } from './labels.ts';
import type { IsoWeekday, LocalDate } from './schemas/primitives.ts';

/** Forma rzeczownika po liczbie: 1, 2–4 (22, 103…), 5+ (także 12–14 i 0). */
export function pluralForm(count: number, [one, few, many]: readonly [string, string, string]): string {
  const abs = Math.abs(count);
  const tens = abs % 100;
  const ones = abs % 10;
  if (abs === 1) return one;
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/** Liczba z odmienionym rzeczownikiem: `plural(2, ["zadanie", "zadania", "zadań"])` → „2 zadania”. */
export const plural = (count: number, forms: readonly [string, string, string]): string => `${count} ${pluralForm(count, forms)}`;

/** „45 min”, „2 h”, „1 h 24 min”. */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const localDate = (date: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('pl-PL', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

/** Pierwsza litera wielka: dla etykiety stojącej na początku wiersza. */
export const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** „sobota, 5 grudnia”. */
export const dayLabel = (date: string): string => localDate(date, { weekday: 'long', day: 'numeric', month: 'long' });

/** „sob., 5.12”: krótka etykieta dnia na chipach i w listach wyboru. */
export const dayChip = (date: string): string => localDate(date, { weekday: 'short', day: 'numeric', month: 'numeric' });

/** „5 grudnia”. */
export const dayMonth = (date: string): string => localDate(date, { day: 'numeric', month: 'long' });

/** „5 gru”. */
export const shortDate = (date: string): string => localDate(date, { day: 'numeric', month: 'short' });

const DAYS = ['dzień', 'dni', 'dni'] as const;
const WEEKS = ['tydzień', 'tygodnie', 'tygodni'] as const;
const MONTHS = ['miesiąc', 'miesiące', 'miesięcy'] as const;
const YEARS = ['rok', 'lata', 'lat'] as const;

/**
 * Dzień względem dziś: „dziś”, „jutro”, „wczoraj”, a dalej `date` → „pt 21 lis” (z rokiem, gdy inny
 * niż bieżący) albo `distance` → „za 3 dni”, „2 tygodnie temu”, „za 2 miesiące”.
 */
export function relativeDay(date: LocalDate, today: LocalDate, style: 'date' | 'distance' = 'date'): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'dziś';
  if (diff === 1) return 'jutro';
  if (diff === -1) return 'wczoraj';
  if (style === 'date') {
    const year = date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${date.slice(0, 4)}`;
    return `${WEEKDAY[isoWeekday(date) as IsoWeekday].short} ${Number(date.slice(8, 10))} ${MONTH_SHORT[Number(date.slice(5, 7)) - 1]}${year}`;
  }
  const abs = Math.abs(diff);
  // „za rok”, nie „za 1 rok”.
  const count = (n: number, forms: readonly [string, string, string]) => (n === 1 ? forms[0] : plural(n, forms));
  const amount = abs < 14 ? count(abs, DAYS) : abs < 60 ? count(Math.floor(abs / 7), WEEKS) : abs < 365 ? count(Math.floor(abs / 30), MONTHS) : count(Math.floor(abs / 365), YEARS);
  return diff > 0 ? `za ${amount}` : `${amount} temu`;
}
