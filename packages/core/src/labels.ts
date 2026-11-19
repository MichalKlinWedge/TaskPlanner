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
