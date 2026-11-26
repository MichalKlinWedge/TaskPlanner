/**
 * „Zaległe” (M9): otwarte zadania po terminie — dzisiejsze, których godzina minęła (na górze), i z
 * wcześniejszych dni; reguły z `selectOverdue` (core), lista odświeża się co minutę. Chipy filtra
 * zawężają zadania; filtr pamiętany per widok do zamknięcia aplikacji (R-06), nie jest zapisywany.
 */
import { applyFilter, isEmptyFilter, minutesLate, overdueToTodayOps, plural, selectOverdue, VIEW_SECTION, type ViewTask } from '@taskplanner/core';
import { useMemo } from 'react';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { useSmartView } from '@/components/view-options';
import { useAdhocFilter } from '@/lib/adhoc-filters';
import { targetInbox, useLocalMinute, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function OverdueScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const now = useLocalMinute(ctx.timeZone);
  usePerfReady('/overdue', data.loaded);
  const [filter, setFilter] = useAdhocFilter(data.userId, 'overdue');
  const view = useMemo(() => selectOverdue(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx, now), [data.tasks, filter, today, ctx, now]);
  const { run } = useTaskActions();
  const { row, options, columnsHeader } = useSmartView('overdue', data, today, workspaceId);
  // „→ Dziś” przy wierszu; `undefined` = nie ma czego przenieść (dzisiejsza seria).
  const toToday = (task: ViewTask) => {
    const move = overdueToTodayOps(task, { today, now });
    return move ? () => void run(move.ops, { text: move.text, undo: move.undo }) : undefined;
  };
  const sections: TaskSection[] = [
    { key: 'today', title: VIEW_SECTION.lateToday, count: view.today.length, tone: 'bad', data: view.today.map((t) => row(t, { showDate: false, withList: true, lateMin: minutesLate(t, now), onToday: toToday(t) })) },
    { key: 'earlier', title: VIEW_SECTION.earlier, count: view.earlier.length, tone: 'bad', data: view.earlier.map((t) => row(t, { withList: true, onToday: toToday(t) })) },
  ];
  return (
    <TaskSections
      sections={sections}
      header={
        <ScreenHeader subtitle={`${plural(view.today.length + view.earlier.length, TASKS)} · przesuń zadanie w lewo, żeby zmienić termin`}>
          {options}
          <FilterBar query={filter} onChange={setFilter} save />
          {view.today.length || view.earlier.length ? columnsHeader : null}
        </ScreenHeader>
      }
      empty={data.loaded ? 'Nic nie zalega.' : 'Wczytywanie…'}
      quickAdd={{ listId: targetInbox(data, workspaceId)?.id }}
    />
  );
}
