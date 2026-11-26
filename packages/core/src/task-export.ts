/**
 * Eksport zadań z widoków (Inbox, Dziś, Nadchodzące, lista / projekt, tablica, tag, zapisany filtr)
 * do arkusza .xlsx (`xlsx.ts`): wiersz na zadanie w kolejności widoku, z sekcją widoku (np. „Zaległe”,
 * dzień w „Nadchodzących”, grupa listy), wcięciem podzadań i polami zadania. Oś czasu ma własny
 * arkusz siatki okresów (`timelineGridSheet`).
 */
import { localDateAt } from './dates.ts';
import { formatMinutes } from './format.ts';
import { PRIORITY, TASK_STATUS } from './labels.ts';
import type { LocalDate } from './schemas/primitives.ts';
import { normalizeText } from './search.ts';
import type { ViewTask } from './views.ts';
import type { XlsxCell, XlsxSheet } from './xlsx.ts';

export interface TaskExportRow {
  task: ViewTask;
  /** Sekcja widoku (np. „Zaległe”, „Jutro”, grupa listy). */
  section?: string;
  /** Poziom podzadania (0 = zadanie), na liście w drzewie. */
  depth?: number;
  /** Termin wystąpienia serii w „Nadchodzących” (wystąpienie wirtualne). */
  date?: LocalDate;
}

/** Nazwy do kolumn: listy, przestrzenie, tagi, współpracownicy (id → nazwa). */
export interface TaskExportNames {
  lists: ReadonlyMap<string, string>;
  workspaces: ReadonlyMap<string, string>;
  tags: ReadonlyMap<string, string>;
  collaborators: ReadonlyMap<string, string>;
}

/** Nazwy z danych aplikacji: Inbox z nazwą przestrzeni w nawiasie (jak na webie). */
export function taskExportNames(source: {
  workspaces: readonly { id: string; name: string }[];
  lists: readonly { id: string; name: string; kind: string; workspaceId: string }[];
  tags: readonly { id: string; name: string }[];
  collaborators: readonly { id: string; name: string }[];
}): TaskExportNames {
  const workspaces = new Map(source.workspaces.map((w) => [w.id, w.name]));
  return {
    workspaces,
    lists: new Map(source.lists.map((l) => [l.id, l.kind === 'inbox' ? `Inbox (${workspaces.get(l.workspaceId) ?? ''})` : l.name])),
    tags: new Map(source.tags.map((t) => [t.id, t.name])),
    collaborators: new Map(source.collaborators.map((c) => [c.id, c.name])),
  };
}

/** Arkusz zadań widoku; kolumna „Sekcja” tylko, gdy któryś wiersz ją ma. */
export function tasksSheet(rows: readonly TaskExportRow[], names: TaskExportNames, options: { name?: string; timeZone?: string } = {}): XlsxSheet {
  const sections = rows.some((r) => r.section);
  const out: XlsxCell[][] = [];
  const indents: number[] = [];
  for (const { task: t, section, depth, date } of rows) {
    const cells: XlsxCell[] = [
      t.title,
      names.workspaces.get(t.workspaceId) ?? '',
      names.lists.get(t.listId) ?? '',
      (date ?? t.dueDate) ? { date: (date ?? t.dueDate)! } : null,
      t.dueTime ?? '',
      t.startDate ? { date: t.startDate } : null,
      t.durationMin ? formatMinutes(t.durationMin) : '',
      PRIORITY[t.priority].label,
      TASK_STATUS[t.status],
      t.tagIds.map((id) => names.tags.get(id)).filter(Boolean).join(', '),
      t.assigneeId ? (names.collaborators.get(t.assigneeId) ?? '') : '',
      t.recurrence ? 'tak' : '',
      t.completedAt ? { date: localDateAt(t.completedAt, options.timeZone) } : null,
    ];
    out.push(sections ? [section ?? '', ...cells] : cells);
    indents.push(depth ?? 0);
  }
  return {
    name: options.name ?? 'Zadania',
    columns: [
      ...(sections ? [{ header: 'Sekcja', width: 18 }] : []),
      { header: 'Zadanie', width: 48 },
      { header: 'Przestrzeń', width: 16 },
      { header: 'Lista', width: 22 },
      { header: 'Termin', width: 11 },
      { header: 'Godzina', width: 8 },
      { header: 'Początek', width: 11 },
      { header: 'Czas', width: 9 },
      { header: 'Priorytet', width: 10 },
      { header: 'Status', width: 13 },
      { header: 'Tagi', width: 22 },
      { header: 'Odpowiedzialny', width: 20 },
      { header: 'Powtarza się', width: 12 },
      { header: 'Ukończono', width: 11 },
    ],
    rows: out,
    indents,
    indentColumn: sections ? 1 : 0,
  };
}

/** Nazwa pliku: „Remont kuchni” + dzień → `remont-kuchni-2026-11-20.xlsx` (albo inne rozszerzenie, np. `png`, `pdf`). */
export function exportFileName(title: string, today: LocalDate, extension = 'xlsx'): string {
  const slug = normalizeText(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'zadania'}-${today}.${extension}`;
}
