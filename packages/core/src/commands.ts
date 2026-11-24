/**
 * Polecenia palety i skróty klawiszowe (SPECYFIKACJA M17). Tu są etykiety i klawisze; obsługa
 * klawiatury jest w `apps/web`, ekran szukania na telefonie pokazuje te same polecenia.
 */
import type { SearchItem } from './search.ts';

export interface Command {
  id: string;
  kind: 'view' | 'action';
  label: string;
  /** Sekwencja klawiszy: `['G', 'I']` = najpierw G, potem I; `['Ctrl+K']` = razem. */
  keys?: readonly string[];
  /** Dodatkowe słowa do wyszukania („dark”, „motyw”). */
  keywords?: readonly string[];
  /** Działa na zaznaczonych zadaniach — bez zaznaczenia nie ma go w palecie. */
  needsSelection?: boolean;
}

export const COMMANDS: readonly Command[] = [
  { id: 'view.inbox', kind: 'view', label: 'Inbox', keys: ['G', 'I'], keywords: ['skrzynka'] },
  { id: 'view.today', kind: 'view', label: 'Dziś', keys: ['G', 'T'], keywords: ['dzisiaj'] },
  { id: 'view.upcoming', kind: 'view', label: 'Nadchodzące', keys: ['G', 'U'], keywords: ['tydzień', 'plan'] },
  { id: 'view.kanban', kind: 'view', label: 'Kanban', keys: ['G', 'K'], keywords: ['tablica'] },
  { id: 'view.calendar', kind: 'view', label: 'Kalendarz', keys: ['G', 'C'] },
  { id: 'view.timeline', kind: 'view', label: 'Oś czasu', keys: ['G', 'O'], keywords: ['gantt', 'harmonogram'] },
  { id: 'view.habits', kind: 'view', label: 'Cykliczne', keys: ['G', 'H'], keywords: ['nawyki', 'passa', 'statystyki'] },
  { id: 'review.daily', kind: 'action', label: 'Przegląd dnia' },
  { id: 'review.weekly', kind: 'action', label: 'Przegląd tygodnia' },
  { id: 'task.quick_add', kind: 'action', label: 'Szybkie dodawanie', keys: ['Q'], keywords: ['nowe zadanie', 'dodaj'] },
  { id: 'task.complete', kind: 'action', label: 'Ukończ', keys: ['E'], keywords: ['zrobione', 'gotowe'], needsSelection: true },
  { id: 'task.priority', kind: 'action', label: 'Ustaw priorytet…', keys: ['1–4'], needsSelection: true },
  { id: 'task.today', kind: 'action', label: 'Zaplanuj na dziś', keys: ['T'], needsSelection: true },
  { id: 'task.tomorrow', kind: 'action', label: 'Zaplanuj na jutro', keys: ['M'], needsSelection: true },
  { id: 'task.date', kind: 'action', label: 'Wybierz datę…', keys: ['D'], keywords: ['termin'], needsSelection: true },
  { id: 'task.move', kind: 'action', label: 'Przenieś do…', keywords: ['lista', 'projekt'], needsSelection: true },
  { id: 'task.delete', kind: 'action', label: 'Przenieś do kosza', keys: ['Del'], keywords: ['usuń'], needsSelection: true },
  { id: 'plugin.send', kind: 'action', label: 'Wyślij do…', keywords: ['integracja', 'webhook', 'wyślij'], needsSelection: true },
  { id: 'focus.start', kind: 'action', label: 'Tryb skupienia', keys: ['F'], keywords: ['pomodoro', 'timer'] },
  { id: 'list.new_project', kind: 'action', label: 'Nowy projekt' },
  { id: 'workspace.switch', kind: 'action', label: 'Przełącz przestrzeń', keywords: ['kontekst'] },
  { id: 'app.theme', kind: 'action', label: 'Motyw ciemny / jasny', keywords: ['dark', 'light', 'tryb'] },
  { id: 'app.search', kind: 'action', label: 'Szukaj', keys: ['/'] },
  { id: 'app.palette', kind: 'action', label: 'Paleta poleceń', keys: ['Ctrl+K'] },
  { id: 'app.shortcuts', kind: 'action', label: 'Lista skrótów', keys: ['?'] },
];

/** Skróty bez polecenia w palecie (nawigacja po liście). */
export const LIST_SHORTCUTS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: ['J'], label: 'Następne zadanie' },
  { keys: ['K'], label: 'Poprzednie zadanie' },
  { keys: ['Shift+J', 'Shift+K'], label: 'Rozszerz zaznaczenie w dół / w górę' },
];

/** Polecenia jako pozycje wyszukiwarki; bez zaznaczenia — bez poleceń na zadaniach. */
export const commandSearchItems = (selected: number): SearchItem[] =>
  COMMANDS.filter((c) => selected > 0 || !c.needsSelection).map((c) => ({ id: c.id, kind: c.kind, title: c.label, keywords: c.keywords }));
