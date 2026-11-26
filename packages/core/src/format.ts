/**
 * Wspólne formatowanie napisów: odmiana po liczbie, czas trwania i daty kalendarzowe. Daty liczą
 * się w UTC z południa, bo to daty pływające (bez strefy), a nie chwile w czasie.
 * Podstawa z ExpeditionPlan (`packages/core/src/format.ts`).
 */
import { addDays, daysBetween, isoWeekday } from './dates.ts';
import { AUTH_ERROR, MONTH_SHORT, PRIORITY, QUICK_ADD_FIELD, QUICK_ADD_KIND, SIGNUP_NOT_INVITED, WEEKDAY } from './labels.ts';
import type { QuickAddResult, QuickAddToken } from './quick-add.ts';
import { describeRecurrence } from './recurrence.ts';
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

/** Tarcza timera: „24:59”, „1:02:03” (zaokrąglenie w górę — 0:00 dopiero na końcu). */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

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

let collator: Intl.Collator | undefined;

/**
 * Porównanie napisów po polsku (sortowanie tytułów) jednym wspólnym `Intl.Collator`. Nie
 * `localeCompare(…, 'pl')`: w Hermes na Androidzie każde wywołanie tworzy nowy kolator, a agenda
 * miesiąca przy 10 000 zadań porównywała tytuły kilkadziesiąt tysięcy razy (~10 s, `docs/WYDAJNOSC.md`).
 */
export const compareText = (a: string, b: string): number => (collator ??= new Intl.Collator('pl')).compare(a, b);

/** Porównanie kodów (id, daty i godziny ISO) bez reguł języka — kolejność znaków. */
export const compareCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/** „5 gru”, a spoza roku `today` — „5 gru 2027” (kolumny dat w widoku listy). */
export const columnDate = (date: string, today: string): string =>
  date.slice(0, 4) === today.slice(0, 4) ? shortDate(date) : localDate(date, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Gotowe dni wyboru terminu (arkusz daty na telefonie, paleta „Wybierz datę…” na webie): Dziś, Jutro,
 * Pojutrze, najbliższy poniedziałek po dzisiejszym („Pon. 23.11”) i Za tydzień. W niedzielę „Pon.” = jutro.
 */
export function datePresets(today: LocalDate): { label: string; date: LocalDate }[] {
  const nextMonday = addDays(today, (8 - isoWeekday(today)) % 7 || 7);
  return [
    { label: 'Dziś', date: today },
    { label: 'Jutro', date: addDays(today, 1) },
    { label: 'Pojutrze', date: addDays(today, 2) },
    { label: `Pon. ${localDate(nextMonday, { day: 'numeric', month: 'numeric' })}`, date: nextMonday },
    { label: 'Za tydzień', date: addDays(today, 7) },
  ];
}

/** „listopad 2026”: nagłówek miesiąca w kalendarzu wyboru dnia. */
export const monthLabel = (date: string): string => localDate(date, { month: 'long', year: 'numeric' });

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

/** Błąd logowania (Supabase `AuthError`, parametry adresu powrotu albo sam tekst) jako komunikat po polsku. */
export function authErrorMessage(error: { code?: string | null; message?: string | null; status?: number; name?: string } | string | null | undefined): string {
  const e = typeof error === 'string' ? { message: error } : (error ?? {});
  const message = e.message ?? '';
  // Odmowa rejestracji przed kodem: przy wyłączonej rejestracji GoTrue zwraca dla maila `otp_disabled`
  // („Signups not allowed for otp”), a hook — swój komunikat ze znacznikiem pod ogólnym kodem.
  if (message.includes(SIGNUP_NOT_INVITED)) return AUTH_ERROR.signup_not_invited!;
  if (/signups? not allowed/i.test(message)) return AUTH_ERROR.signup_disabled!;
  if (e.code && AUTH_ERROR[e.code]) return AUTH_ERROR[e.code]!;
  // Starsze serwery i błędy bez kodu: po treści (jak na webie w `login-screen.tsx`).
  if (e.name === 'AuthRetryableFetchError' || /network request failed|failed to fetch|fetch failed/i.test(message)) return AUTH_ERROR.network!;
  if (/provider is not enabled|unsupported provider/i.test(message)) return AUTH_ERROR.provider_disabled!;
  if (/invalid or has expired|token has expired/i.test(message)) return AUTH_ERROR.otp_expired!;
  if (/code verifier/i.test(message)) return AUTH_ERROR.pkce_code_verifier_not_found!;
  if (/rate limit|too many/i.test(message)) return AUTH_ERROR.over_request_rate_limit!;
  if (/unable to validate email|invalid.*email/i.test(message)) return AUTH_ERROR.email_address_invalid!;
  return message || 'Nie udało się zalogować.';
}

/**
 * Napis chipu rozpoznanego fragmentu szybkiego dodawania: „Termin: jutro”, „Lista: Dom › Remont
 * kuchni”, „Powtarzanie: co tydzień w środę”. Wartość z pól wyniku, a gdy fragmentów jednego
 * rodzaju jest kilka (tagi, przypomnienia) — z tekstu fragmentu.
 */
export function quickAddChip(token: QuickAddToken, { fields }: QuickAddResult, today: LocalDate): string {
  if (token.overridden) return `${QUICK_ADD_KIND[token.kind]}: ${token.text} — ${QUICK_ADD_FIELD.overridden}`;
  const value = (() => {
    switch (token.kind) {
      case 'date':
        return fields.dueDate ? relativeDay(fields.dueDate, today) : token.text;
      case 'time':
        return fields.dueTime ?? token.text;
      case 'duration':
        return fields.durationMin ? formatMinutes(fields.durationMin) : token.text;
      case 'priority':
        return fields.priority ? PRIORITY[fields.priority].label : token.text;
      case 'target':
        return fields.target ? (fields.target.kind === 'workspace' ? `${fields.target.name} (Inbox)` : `${fields.target.workspace} › ${fields.target.name}`) : token.text;
      case 'recurrence':
        return fields.recurrence ? describeRecurrence(fields.recurrence) : token.text;
      case 'tag':
        return token.text.replace(/^[@#]/, '');
      default:
        return token.text;
    }
  })();
  return `${QUICK_ADD_KIND[token.kind]}: ${value}`;
}

/** Przypomnienie względne: „w chwili terminu”, „15 min przed”, „1 dzień przed”. */
export function reminderOffset(minutes: number): string {
  if (minutes === 0) return 'w chwili terminu';
  if (minutes % 1440 === 0) return `${plural(minutes / 1440, ['dzień', 'dni', 'dni'])} przed`;
  return `${formatMinutes(minutes)} przed`;
}

/** Rozmiar pliku: „830 B”, „12 kB”, „3,4 MB” (Etap 10, załączniki). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Pominięte serie (godzina zmieniłaby każde wystąpienie). */
export const seriesNote = (count: number): string =>
  `${plural(count, ['zadanie z powtarzaniem', 'zadania z powtarzaniem', 'zadań z powtarzaniem'])} bez zmian — godzina dotyczyłaby każdego wystąpienia.`;

/** Godziny z odpowiedzi AI poprawione albo odrzucone przez `validateDayPlan`. */
export const aiPlanFixedNote = (count: number): string => `${plural(count, ['propozycja AI była', 'propozycje AI były', 'propozycji AI było'])} poza wolnym oknem, w kolizji albo przed poprzednikiem — poprawione.`;
