/**
 * Widok tagu i zapisanego filtra (M4): zadania z `selectFiltered` (core) po terminie, nagłówek
 * z opisem warunków (`filterChips`) i akcjami (zmiana nazwy, kolor, usunięcie). Z `onChange` —
 * warunki jako chipy do zmiany (`FilterBar`) zamiast opisu w podtytule. Z `exportTitle` — chip
 * „Eksport XLSX” wyników (kolejność jak na ekranie).
 */
import { filterChips, plural, selectFiltered, sortTasks, type FilterQuery } from '@taskplanner/core';
import { useMemo, type ReactNode } from 'react';

import { useView } from '@/lib/app-data';

import { ExportChip } from './export-button';
import { FilterBar } from './filter-bar';
import { ScreenHeader } from './sync-banner';
import { TaskSections, type QuickAddParams } from './task-list';
import { OptionRow, useViewColumns } from './view-options';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export function FilterResults({
  query,
  header,
  onChange,
  save,
  quickAdd = null,
  exportTitle,
  columnsKey,
}: {
  /** Ustawienia kolumn w `settings.views` (wspólne dla wszystkich tagów / filtrów). */
  columnsKey: 'tag' | 'filter';
  query: FilterQuery;
  header?: ReactNode;
  onChange?: (query: FilterQuery) => void;
  save?: boolean;
  quickAdd?: QuickAddParams | null;
  /** Tytuł arkusza i pliku eksportu; brak — bez „Eksport XLSX”. */
  exportTitle?: string;
}) {
  const { data, today, ctx, workspaceId } = useView();
  const tasks = useMemo(() => sortTasks(selectFiltered(data.tasks, query, ctx), 'due'), [data.tasks, query, ctx]);
  const { row, chips: columnChips, columnsHeader } = useViewColumns(columnsKey, data, today, workspaceId);
  const chips = filterChips(query, {
    lists: new Map(data.lists.map((l) => [l.id, l.name])),
    workspaces: new Map(data.workspaces.map((w) => [w.id, w.name])),
    tags: new Map(data.tags.map((t) => [t.id, t.name])),
    assignees: new Map(data.collaborators.map((c) => [c.id, c.name])),
  });
  return (
    <TaskSections
      sections={[{ key: 'results', data: tasks.map((t) => row(t, { withList: true })) }]}
      header={
        <ScreenHeader subtitle={`${plural(tasks.length, TASKS)}${chips.length && !onChange ? ` · ${chips.map((c) => c.label).join(' · ')}` : ''}`}>
          {header}
          <OptionRow>
            {columnChips}
            {exportTitle ? <ExportChip title={exportTitle} rows={() => tasks.map((task) => ({ task }))} /> : null}
          </OptionRow>
          {onChange ? <FilterBar query={query} onChange={onChange} save={save} /> : null}
          {tasks.length ? columnsHeader : null}
        </ScreenHeader>
      }
      empty="Żadne zadanie nie pasuje."
      quickAdd={quickAdd}
    />
  );
}

/** Nazwa (i opcjonalnie kolor) z usunięciem — nagłówek widoku tagu i filtra. */
export { EditNameBar } from './edit-name-bar';
