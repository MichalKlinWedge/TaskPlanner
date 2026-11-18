/**
 * Etykiety wartości ze schematów (SPECYFIKACJA §7.9). Aplikacje nie definiują własnych.
 */
import type { ListKind, Priority, ProjectStatus, TaskStatus } from './schemas/primitives.ts';

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
