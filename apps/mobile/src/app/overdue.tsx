/**
 * „Zaległe” (M9): otwarte zadania po terminie — dzisiejsze, których godzina minęła (na górze), i z
 * wcześniejszych dni; reguły z `selectOverdue` (core), lista odświeża się co minutę. Chipy filtra
 * zawężają zadania; filtr trwa do opuszczenia ekranu, nie jest zapisywany.
 */
import { applyFilter, isEmptyFilter, minutesLate, plural, selectOverdue, VIEW_SECTION, type FilterQuery } from '@taskplanner/core';
import { useMemo, useState } from 'react';

import { FilterBar } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { targetInbox, useLocalMinute, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';
import { rowMaker } from '@/lib/rows';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function OverdueScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const now = useLocalMinute(ctx.timeZone);
  usePerfReady('/overdue', data.loaded);
  const [filter, setFilter] = useState<FilterQuery>({});
  const view = useMemo(() => selectOverdue(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx, now), [data.tasks, filter, today, ctx, now]);
  const row = rowMaker(data, today);
  const sections: TaskSection[] = [
    { key: 'today', title: VIEW_SECTION.lateToday, count: view.today.length, tone: 'bad', data: view.today.map((t) => row(t, { showDate: false, withList: true, lateMin: minutesLate(t, now) })) },
    { key: 'earlier', title: VIEW_SECTION.earlier, count: view.earlier.length, tone: 'bad', data: view.earlier.map((t) => row(t, { withList: true })) },
  ];
  return (
    <TaskSections
      sections={sections}
      header={
        <ScreenHeader subtitle={`${plural(view.today.length + view.earlier.length, TASKS)} · przesuń zadanie w lewo, żeby zmienić termin`}>
          <FilterBar query={filter} onChange={setFilter} save />
        </ScreenHeader>
      }
      empty={data.loaded ? 'Nic nie zalega.' : 'Wczytywanie…'}
      quickAdd={{ listId: targetInbox(data, workspaceId)?.id }}
    />
  );
}
