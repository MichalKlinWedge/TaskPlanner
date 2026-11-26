/**
 * Ściąga składni szybkiego dodawania (SPECYFIKACJA §4) — rozwijana w oknie „Q” na webie. Każdy
 * przykład jest rozpoznawany przez `parseQuickAdd` jako fragment danego rodzaju (test
 * `quick-add-help.test.ts`), więc ściąga nie rozjedzie się z parserem.
 */
import { QUICK_ADD_KIND } from './labels.ts';
import type { QuickAddTokenKind } from './quick-add.ts';

export interface QuickAddHelpRow {
  kind: QuickAddTokenKind;
  /** Nazwa rodzaju jak na chipie (`QUICK_ADD_KIND`). */
  label: string;
  /** Fragmenty do wpisania — każdy rozpoznawany jako `kind`. */
  examples: readonly string[];
  note?: string;
}

const row = (kind: QuickAddTokenKind, examples: readonly string[], note?: string): QuickAddHelpRow => ({ kind, label: QUICK_ADD_KIND[kind], examples, ...(note && { note }) });

export const QUICK_ADD_HELP: readonly QuickAddHelpRow[] = [
  row('date', ['dziś', 'jutro', 'pojutrze', 'za 3 dni', 'za tydzień', 'pt', 'w przyszły piątek', 'w weekend', '21.11', '21 lis', 'koniec miesiąca']),
  row('time', ['o 10', 'o 10:30', '10:30', 'o 8 wieczorem', 'w południe', '10-11:30', 'od 10 do 12'], 'zakres godzin ustawia też czas trwania'),
  row('duration', ['~30m', '~1h30', '~1,5h', 'przez 45 min']),
  row('priority', ['!1', '!2', '!wysoki', '!niski'], '!1 — krytyczny … !4 — niski'),
  row('target', ['#Praca', '#"Remont kuchni"'], 'lista, projekt albo przestrzeń (wtedy jej Inbox)'),
  row('tag', ['@telefon'], '#nazwa też, gdy nie ma takiej listy ani przestrzeni'),
  row('recurrence', ['codziennie', 'w dni robocze', 'co tydzień', 'co 2 tygodnie', 'w każdy poniedziałek', 'co miesiąc', 'ostatniego dnia miesiąca', 'co roku', 'co 3 dni po ukończeniu']),
  row('reminder', ['^15m', '^9:00', 'przypomnij 30 min przed', 'przypomnij o 9']),
];

/** Zasady pod tabelą ściągi. */
export const QUICK_ADD_HELP_NOTES: readonly string[] = [
  'Wielkość liter i polskie znaki bez znaczenia („sroda” = „środa”).',
  '\\jutro — ukośnik zostawia słowo w tytule; kliknięcie chipa cofa rozpoznanie.',
  'Kilka linii naraz (wklejenie) = kilka zadań.',
];
