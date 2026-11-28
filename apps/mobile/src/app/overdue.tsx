/**
 * „Zaległe” (M9): otwarte zadania po terminie — dzisiejsze, których godzina minęła (na górze), i z
 * wcześniejszych dni; reguły z `selectOverdue` (core), lista odświeża się co minutę. Chipy filtra
 * zawężają zadania; filtr pamiętany per widok do zamknięcia aplikacji (R-06), nie jest zapisywany.
 */
import { applyFilter, isEmptyFilter, minutesLate, OVERDUE_LATER_OPTIONS, overdueLaterLabel, overdueLaterOps, overdueToTodayOps, plural, selectOverdue, sortSection, VIEW_SECTION, type ViewTask } from '@taskplanner/core';
import { useMemo } from 'react';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { pickOption } from '@/components/pickers';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { smartSort, useSmartView } from '@/components/view-options';
import { useAdhocFilter } from '@/lib/adhoc-filters';
import { targetInbox, useLocalMinute, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function OverdueScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const now = useLocalMinute(ctx.timeZone);
  usePerfReady('/overdue', data.loaded);
  const [filter, setFilter] = useAdhocFilter(data.userId, 'overdue');
  const { by, dir } = smartSort(data, 'overdue');
  // Wybrane sortowanie działa w obrębie sekcji („dziś po godzinie” / „wcześniej”).
  const view = useMemo(() => {
    const overdue = selectOverdue(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx, now);
    return { today: sortSection(overdue.today, by, dir, (t) => t), earlier: sortSection(overdue.earlier, by, dir, (t) => t) };
  }, [data.tasks, filter, today, ctx, now, by, dir]);
  const { run } = useTaskActions();
  const { row, options, columnsHeader } = useSmartView('overdue', data, today, workspaceId);
  // „→ Dziś” przy wierszu; `undefined` = nie ma czego przenieść (dzisiejsza seria).
  const toToday = (task: ViewTask) => {
    const move = overdueToTodayOps(task, { today, now });
    return move ? () => void run(move.ops, { text: move.text, undo: move.undo }) : undefined;
  };
  // „⏱” przy wierszu: termin za 15 min / 30 min / 1 h od teraz; seria — bez przycisku.
  const later = (task: ViewTask) =>
    task.recurrence
      ? undefined
      : async () => {
          const minutes = await pickOption(`Przesuń: ${task.title}`, OVERDUE_LATER_OPTIONS.map((m) => ({ label: overdueLaterLabel(m), hint: 'od teraz', value: m })));
          const move = minutes ? overdueLaterOps(task, minutes, { today, now }) : null;
          if (move) await run(move.ops, { text: move.text, undo: move.undo });
        };
  const sections: TaskSection[] = [
    { key: 'today', title: VIEW_SECTION.lateToday, count: view.today.length, tone: 'bad', data: view.today.map((t) => row(t, { showDate: false, withList: true, lateMin: minutesLate(t, now), onLater: later(t), onToday: toToday(t) })) },
    { key: 'earlier', title: VIEW_SECTION.earlier, count: view.earlier.length, tone: 'bad', data: view.earlier.map((t) => row(t, { withList: true, onLater: later(t), onToday: toToday(t) })) },
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
