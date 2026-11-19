/**
 * Etykiety wartości ze schematów (SPECYFIKACJA §7.9). Aplikacje nie definiują własnych.
 */
import type { IsoWeekday, ListKind, Priority, ProjectStatus, ReminderKind, TaskStatus } from './schemas/primitives.ts';

export const PRIORITY: Record<Priority, { label: string; short: string; color: string }> = {
  1: { label: 'Krytyczny', short: '!1', color: '#dc2626' },
  2: { label: 'Wysoki', short: '!2', color: '#ea580c' },
  3: { label: 'Średni', short: '!3', color: '#2563eb' },
  4: { label: 'Niski', short: '!4', color: '#71717a' },
};

export const TASK_STATUS: Record<TaskStatus, string> = {
  todo: 'Do zrobienia',
  in_progress: 'W trakcie',
  waiting: 'Oczekuje',
  done: 'Gotowe',
  cancelled: 'Anulowane',
};

export const LIST_KIND: Record<ListKind, string> = {
  inbox: 'Inbox',
  project: 'Projekt',
  list: 'Lista',
};

export const PROJECT_STATUS: Record<ProjectStatus, string> = {
  active: 'Aktywny',
  on_hold: 'Wstrzymany',
  done: 'Zakończony',
};

/** Motyw (`profiles.settings.theme`). */
export const THEME: Record<'system' | 'light' | 'dark', string> = {
  system: 'Jak w systemie',
  light: 'Jasny',
  dark: 'Ciemny',
};

/** Ukończone w widoku (`CompletedMode`), sortowanie (`SortBy`) i grupowanie (`GroupBy`). */
export const COMPLETED_MODE: Record<'hidden' | 'today' | 'all', string> = {
  hidden: 'Ukryj ukończone',
  today: 'Ukończone dziś',
  all: 'Wszystkie ukończone',
};

export const SORT_BY: Record<'manual' | 'priority' | 'due' | 'created', string> = {
  manual: 'Ręcznie',
  priority: 'Priorytet',
  due: 'Termin',
  created: 'Data dodania',
};

export const GROUP_BY: Record<'none' | 'priority' | 'list' | 'date' | 'tag' | 'status', string> = {
  none: 'Bez grupowania',
  priority: 'Priorytet',
  list: 'Lista',
  date: 'Termin',
  tag: 'Tag',
  status: 'Status',
};

/** Nazwy sekcji widoków (`views.ts`) i grup bez wartości. */
export const VIEW_SECTION = {
  overdue: 'Zaległe',
  today: 'Dziś',
  ongoing: 'Trwające',
  habits: 'Nawyki na dziś',
  done: 'Ukończone',
  later: 'Później',
  noDate: 'Bez terminu',
  noTag: 'Bez tagu',
  noList: 'Bez listy',
} as const;

export const REMINDER_KIND: Record<ReminderKind, string> = {
  relative: 'Przed terminem',
  absolute: 'O wybranej porze',
};

/** Dni tygodnia ISO; `short` bez kropki — na chipach i w „pt 21 lis”. */
export const WEEKDAY: Record<IsoWeekday, { label: string; short: string }> = {
  1: { label: 'poniedziałek', short: 'pon' },
  2: { label: 'wtorek', short: 'wt' },
  3: { label: 'środa', short: 'śr' },
  4: { label: 'czwartek', short: 'czw' },
  5: { label: 'piątek', short: 'pt' },
  6: { label: 'sobota', short: 'sob' },
  7: { label: 'niedziela', short: 'ndz' },
};

/** Kolory przestrzeni, list i tagów do wyboru w UI (#RRGGBB, jak `Color` w modelu). */
export const COLORS: readonly { value: string; label: string }[] = [
  { value: '#4F46E5', label: 'indygo' },
  { value: '#2563EB', label: 'niebieski' },
  { value: '#0891B2', label: 'turkusowy' },
  { value: '#16A34A', label: 'zielony' },
  { value: '#CA8A04', label: 'żółty' },
  { value: '#EA580C', label: 'pomarańczowy' },
  { value: '#DC2626', label: 'czerwony' },
  { value: '#DB2777', label: 'różowy' },
  { value: '#9333EA', label: 'fioletowy' },
  { value: '#57534E', label: 'szary' },
];

/** Skróty miesięcy (od stycznia). */
export const MONTH_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'] as const;

/**
 * Błędy Supabase Auth po polsku (kody `ErrorCode` z GoTrue i `error_code` z adresu powrotu).
 * Tekst do pokazania wybiera `authErrorMessage` (`format.ts`); kod spoza listy = komunikat serwera.
 */
export const AUTH_ERROR: Record<string, string> = {
  otp_expired: 'Link albo kod z maila wygasł lub został już użyty — wyślij nowy.',
  flow_state_expired: 'Logowanie trwało za długo — zacznij je od nowa.',
  flow_state_not_found: 'Logowanie wygasło albo zostało już dokończone — zacznij je od nowa.',
  pkce_code_verifier_not_found: 'Link otwarto w innej aplikacji albo na innym urządzeniu niż to, z którego go wysłano — wyślij nowy stąd.',
  bad_code_verifier: 'Link otwarto w innej aplikacji albo na innym urządzeniu niż to, z którego go wysłano — wyślij nowy stąd.',
  over_email_send_rate_limit: 'Za dużo maili logowania — odczekaj chwilę i spróbuj ponownie.',
  over_request_rate_limit: 'Za dużo prób — odczekaj chwilę i spróbuj ponownie.',
  email_address_invalid: 'Niepoprawny adres e-mail.',
  email_address_not_authorized: 'Ten serwer nie wysyła maili na ten adres.',
  email_provider_disabled: 'Logowanie przez e-mail jest wyłączone na tym serwerze.',
  otp_disabled: 'Logowanie linkiem z maila jest wyłączone na tym serwerze.',
  provider_disabled: 'Logowanie Google nie jest włączone na tym serwerze.',
  oauth_provider_not_supported: 'Logowanie Google nie jest włączone na tym serwerze.',
  bad_oauth_state: 'Logowanie Google przerwane — spróbuj ponownie.',
  bad_oauth_callback: 'Logowanie Google przerwane — spróbuj ponownie.',
  signup_disabled: 'Zakładanie nowych kont jest wyłączone na tym serwerze.',
  user_banned: 'To konto jest zablokowane.',
  email_not_confirmed: 'Adres e-mail nie jest jeszcze potwierdzony.',
  session_not_found: 'Sesja wygasła — zaloguj się ponownie.',
  session_expired: 'Sesja wygasła — zaloguj się ponownie.',
  refresh_token_not_found: 'Sesja wygasła — zaloguj się ponownie.',
  refresh_token_already_used: 'Sesja wygasła — zaloguj się ponownie.',
  request_timeout: 'Serwer nie odpowiedział na czas — spróbuj ponownie.',
  access_denied: 'Logowanie odrzucone.',
  network: 'Brak połączenia z serwerem.',
};
