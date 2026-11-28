/**
 * „Bez terminu”: otwarte zadania bez terminu do przejrzenia i zaplanowania, w sekcjach list — reguły
 * z `selectUndated` / `undatedSections` (core). „→ Dziś” przy wierszu, przesunięcie w lewo zmienia termin.
 * Chipy filtra zawężają zadania; filtr pamiętany per widok do zamknięcia aplikacji (R-06), nie jest zapisywany.
 */
import { applyFilter, bulkTaskOps, isEmptyFilter, plural, relativeDay, selectUndated, sortSection, undatedSections, type ViewTask } from '@taskplanner/core';
import { useMemo } from 'react';

import { useTaskActions } from '@/components/actions';
import { FilterBar, filterEmptyText } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { smartSort, useSmartView } from '@/components/view-options';
import { useAdhocFilter } from '@/lib/adhoc-filters';
import { targetInbox, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function UndatedScreen() {
  const { data, today, ctx, workspaceId } = useView();
  usePerfReady('/undated', data.loaded);
  const [filter, setFilter] = useAdhocFilter(data.userId, 'undated');
  const { by, dir } = smartSort(data, 'undated');
  // Wybrane sortowanie działa w obrębie sekcji listy.
  const sections = useMemo(() => {
    const undated = selectUndated(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx);
    return undatedSections(sortSection(undated, by, dir, (t) => t), { lists: data.lists, workspaces: data.workspaces });
  }, [data.tasks, data.lists, data.workspaces, filter, today, ctx, by, dir]);
  const { run } = useTaskActions();
  const { row, options, columnsHeader } = useSmartView('undated', data, today, workspaceId);
  const toToday = (task: ViewTask) => () => {
    const { ops, undo } = bulkTaskOps([task], data.tasks, { kind: 'today' }, { today, now: new Date(), timeZone: ctx.timeZone });
    void run(ops, { text: `„${task.title}” → ${relativeDay(today, today)}`, undo });
  };
  const count = sections.reduce((n, s) => n + s.tasks.length, 0);
  const list: TaskSection[] = sections.map((s) => ({ key: s.key, title: s.title, count: s.tasks.length, data: s.tasks.map((t) => row(t, { onToday: toToday(t) })) }));
  return (
    <TaskSections
      sections={list}
      header={
        <ScreenHeader subtitle={`${plural(count, TASKS)} do zaplanowania · przesuń zadanie w lewo, żeby nadać termin`}>
          {options}
          <FilterBar query={filter} onChange={setFilter} save />
          {count ? columnsHeader : null}
        </ScreenHeader>
      }
      empty={data.loaded ? filterEmptyText(filter, 'Wszystko ma termin.') : 'Wczytywanie…'}
      quickAdd={{ listId: targetInbox(data, workspaceId)?.id }}
    />
  );
}
