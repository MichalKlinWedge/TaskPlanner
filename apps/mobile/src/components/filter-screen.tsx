/**
 * Widok tagu i zapisanego filtra (M4): zadania z `selectFiltered` (core) po terminie, nagłówek
 * z opisem warunków (`filterChips`) i akcjami (zmiana nazwy, kolor, usunięcie).
 */
import { filterChips, plural, selectFiltered, sortTasks, type FilterQuery } from '@taskplanner/core';
import { useMemo, type ReactNode } from 'react';

import { useView } from '@/lib/app-data';
import { rowMaker } from '@/lib/rows';

import { ScreenHeader } from './sync-banner';
import { TaskSections } from './task-list';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export function FilterResults({ query, header }: { query: FilterQuery; header?: ReactNode }) {
  const { data, today, ctx } = useView();
  const tasks = useMemo(() => sortTasks(selectFiltered(data.tasks, query, ctx), 'due'), [data.tasks, query, ctx]);
  const row = rowMaker(data, today);
  const chips = filterChips(query, {
    lists: new Map(data.lists.map((l) => [l.id, l.name])),
    workspaces: new Map(data.workspaces.map((w) => [w.id, w.name])),
    tags: new Map(data.tags.map((t) => [t.id, t.name])),
  });
  return (
    <TaskSections
      sections={[{ key: 'results', data: tasks.map((t) => row(t, { withList: true })) }]}
      header={
        <ScreenHeader subtitle={`${plural(tasks.length, TASKS)}${chips.length ? ` · ${chips.map((c) => c.label).join(' · ')}` : ''}`}>{header}</ScreenHeader>
      }
      empty="Żadne zadanie nie pasuje."
      quickAdd={null}
    />
  );
}

/** Nazwa (i opcjonalnie kolor) z usunięciem — nagłówek widoku tagu i filtra. */
export { EditNameBar } from './edit-name-bar';
