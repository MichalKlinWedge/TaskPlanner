/**
 * Etykiety wartości ze schematów (SPECYFIKACJA §7.9). Aplikacje nie definiują własnych.
 */
import type { BackupTable } from './backup.ts';
import type { FocusPhase } from './focus.ts';
import type { PluginEvent } from './plugins/events.ts';
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

/** Znaczenie statusów — podpowiedź (np. dymek nad kolumną tablicy). */
export const TASK_STATUS_HINT: Record<TaskStatus, string> = {
  todo: 'Otwarte, jeszcze nie zaczęte — domyślny status nowego zadania.',
  in_progress: 'Zaczęte, właśnie nad nim pracujesz. Działa jak „Do zrobienia”, tylko informuje.',
  waiting: 'Zablokowane przez kogoś lub coś z zewnątrz (odpowiedź, dostawa, decyzja). Nadal otwarte; przegląd tygodnia pokazuje czekające dłużej niż 7 dni.',
  done: 'Ukończone (to samo co odhaczenie; w serii przesuwa termin na następne wystąpienie). Na tablicy — z ostatnich 7 dni.',
  cancelled: 'Zamknięte bez wykonania — znika z widoków i nie liczy się do ukończonych.',
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

/** Dodatkowe kolumny widoku listy, w kolejności wyświetlania. */
export const LIST_COLUMN: Record<'assignee' | 'start' | 'due' | 'tags', string> = {
  assignee: 'Odpowiedzialny',
  start: 'Początek',
  due: 'Koniec',
  tags: 'Tagi',
};

/** Wybrane kolumny listy w stałej kolejności `LIST_COLUMN`, bez powtórzeń i nieznanych. */
export const orderedColumns = <C extends keyof typeof LIST_COLUMN>(columns: readonly C[] | undefined): C[] =>
  (Object.keys(LIST_COLUMN) as C[]).filter((c) => columns?.includes(c));

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

/** Pola zadania w historii zmian (`activity_log.changes`). */
export const TASK_FIELD: Record<string, string> = {
  title: 'Tytuł',
  description_md: 'Opis',
  status: 'Status',
  priority: 'Priorytet',
  start_date: 'Początek',
  due_date: 'Termin',
  due_time: 'Godzina',
  duration_min: 'Czas',
  time_zone: 'Strefa',
  recurrence: 'Powtarzanie',
  habit: 'Nawyk',
  kind: 'Rodzaj',
  list_id: 'Lista',
  parent_id: 'Zadanie nadrzędne',
  completed_at: 'Ukończono',
  deleted_at: 'Kosz',
  sort_key: 'Kolejność',
  board_sort_key: 'Kolejność na tablicy',
  postpone_count: 'Przesunięcia terminu',
  source: 'Źródło',
  assignee_id: 'Odpowiedzialny',
  board_column_id: 'Kolumna tablicy',
};

/** Gotowe przypomnienia względne (minuty przed terminem). */
export const REMINDER_PRESETS = [0, 15, 30, 60, 120, 1440] as const;

/** Rodzaje rozpoznanych fragmentów szybkiego dodawania (chipy). */
export const QUICK_ADD_KIND: Record<'date' | 'time' | 'duration' | 'priority' | 'target' | 'tag' | 'recurrence' | 'reminder', string> = {
  date: 'Termin',
  time: 'Godzina',
  duration: 'Czas',
  priority: 'Priorytet',
  target: 'Lista',
  tag: 'Tag',
  recurrence: 'Powtarzanie',
  reminder: 'Przypomnienie',
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
export const MONTH_NAME = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'] as const;

/**
 * Błędy Supabase Auth po polsku (kody `ErrorCode` z GoTrue i `error_code` z adresu powrotu).
 * Tekst do pokazania wybiera `authErrorMessage` (`format.ts`); kod spoza listy = komunikat serwera.
 */
/**
 * Znacznik odmowy rejestracji spoza listy zaproszonych: hook Supabase Auth „Before User Created”
 * zwraca go na początku komunikatu błędu (mail z linkiem i powrót z Google), `authErrorMessage`
 * rozpoznaje go po treści, bo GoTrue nie przenosi własnego kodu błędu z hooka.
 */
export const SIGNUP_NOT_INVITED = 'signup_not_invited';

/** Podpis ekranu logowania (web i telefon): kto może się zalogować. */
export const LOGIN_INVITE_NOTE = 'Dostęp na zaproszenie — zaloguj się adresem e-mail, który dostał zaproszenie od właściciela aplikacji.';

/** Ustawienia → „Usuń konto” (web i telefon, Edge Function `account-delete`). */
export const ACCOUNT_DELETE_NOTE =
  'Usuwa konto i wszystkie dane na serwerze: zadania, listy, nawyki, załączniki i połączone kalendarze. Przestrzenie, które udostępniasz innym, znikną także u nich; z cudzych przestrzeni po prostu wychodzisz. Tego nie da się cofnąć — jeśli chcesz zachować dane, najpierw zrób kopię zapasową. Wpisz adres e-mail konta, żeby potwierdzić.';

export const AUTH_ERROR: Record<string, string> = {
  // GoTrue zwraca `otp_expired` także dla błędnie wpisanego kodu („Token has expired or is invalid”).
  otp_expired: 'Kod albo link z maila jest błędny, wygasł lub został już użyty — sprawdź kod albo wyślij nowy.',
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
  signup_disabled: 'Dostęp jest na zaproszenie, a ten adres nie ma konta. Poproś właściciela aplikacji o zaproszenie.',
  signup_not_invited: 'Dostęp jest na zaproszenie, a tego adresu nie ma na liście. Poproś właściciela aplikacji o zaproszenie.',
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

/** Etapy timera skupienia (M14). */
export const FOCUS_PHASE: Record<FocusPhase, string> = {
  idle: 'Bez timera',
  focus: 'Praca',
  short_break: 'Krótka przerwa',
  long_break: 'Długa przerwa',
  ready: 'Przerwa skończona',
  stopwatch: 'Stoper',
};

/** Decyzje przeglądu (M16) z klawiszami 1–6 na webie. */
export const REVIEW_ACTION = {
  done: { key: '1', label: 'Ukończ' },
  today: { key: '2', label: 'Dziś' },
  tomorrow: { key: '3', label: 'Jutro' },
  date: { key: '4', label: 'Wybierz datę' },
  someday: { key: '5', label: 'Kiedyś' },
  delete: { key: '6', label: 'Usuń' },
} as const;

/** Tabele kopii JSON (Etap 13) — podsumowanie importu w Ustawieniach. */
export const BACKUP_TABLE: Record<BackupTable, string> = {
  profiles: 'Profil',
  workspaces: 'Przestrzenie',
  lists: 'Listy i projekty',
  collaborators: 'Współpracownicy',
  tasks: 'Zadania i nawyki',
  tags: 'Tagi',
  task_tags: 'Tagi zadań',
  task_completions: 'Ukończenia i wpisy nawyków',
  reminders: 'Przypomnienia',
  task_dependencies: 'Zależności',
  time_entries: 'Wpisy czasu',
  attachments: 'Załączniki (opis)',
  saved_filters: 'Zapisane filtry',
  review_sessions: 'Przeglądy',
  task_participants: 'Uczestnicy zadań',
  task_comments: 'Komentarze',
};

/** Rodzaje wpisów dziennika błędów (Ustawienia → „Błędy aplikacji”, `core/errors.ts`). */
export const ERROR_KIND: Record<'error' | 'unhandled' | 'render' | 'sync' | 'rejected', string> = {
  error: 'Błąd',
  unhandled: 'Nieobsłużony błąd',
  render: 'Błąd widoku',
  sync: 'Synchronizacja',
  rejected: 'Odrzucona zmiana',
};

/**
 * Ikony sekcji panelu zadania (web) i ekranu zadania (telefon) — klucz = id sekcji (`PanelSection`),
 * ten sam co w `settings.taskPanel.collapsed`.
 */
export const TASK_SECTION_ICON: Record<string, string> = {
  details: '📋',
  'Zadanie nadrzędne': '🗂️',
  Osoby: '👥',
  Nawyk: '🌱',
  Powtarzanie: '🔁',
  Tagi: '🏷️',
  Przypomnienia: '🔔',
  Opis: '📝',
  Podzadania: '☑️',
  attachments: '📎',
  time: '⏱️',
  Zależności: '🔗',
  Komentarze: '💬',
  history: '🕘',
};

// ── Integracje wychodzące (pluginy, M21) ─────────────────────────────────────────────────────

export const PLUGIN_EVENT: Record<PluginEvent, string> = {
  'task.created': 'Dodane zadanie',
  'task.completed': 'Ukończone',
  'task.reopened': 'Przywrócone do pracy',
  'task.deleted': 'Przeniesione do kosza',
  'task.restored': 'Przywrócone z kosza',
  'task.moved': 'Przeniesione',
  'task.tagged': 'Dodany tag',
  'task.untagged': 'Usunięty tag',
  'task.due_changed': 'Zmiana terminu',
  'task.assigned': 'Zmiana odpowiedzialnego',
  'task.commented': 'Nowy komentarz',
  'task.sent': 'Wysłane ręcznie',
};

/** Stan wysyłki (`plugin_deliveries.status`). */
export const DELIVERY_STATUS: Record<'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'dead', { label: string; tone: 'muted' | 'ok' | 'error' }> = {
  pending: { label: 'Czeka', tone: 'muted' },
  sending: { label: 'Wysyłanie', tone: 'muted' },
  sent: { label: 'Wysłane', tone: 'ok' },
  skipped: { label: 'Pominięte', tone: 'muted' },
  failed: { label: 'Błąd', tone: 'error' },
  dead: { label: 'Porzucone po ponowieniach', tone: 'error' },
};

/** Stan połączenia (`plugin_connections.status`). */
export const PLUGIN_CONNECTION_STATUS: Record<'active' | 'disabled' | 'error', string> = {
  active: 'aktywne',
  disabled: 'wyłączone',
  error: 'wyłączone po błędzie',
};

/** Rodzaj wyzwalacza reguły. */
export const PLUGIN_TRIGGER: Record<'manual' | 'event', string> = {
  manual: 'Ręcznie — „Wyślij do…”',
  event: 'Zmiana zadania',
};

/** Wysyłki wymagają serwera — tekst dla „Wyślij do…” offline. */
export const PLUGIN_SEND_NOTE = 'Wysyłka wyjdzie z serwera po synchronizacji — także gdy teraz nie ma sieci.';
