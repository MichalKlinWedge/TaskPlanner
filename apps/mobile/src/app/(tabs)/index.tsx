/**
 * „Dziś” (M9): zaległe, dziś, trwające, nawyki, ukończone dziś — reguły z `selectToday` (core).
 * Na górze zwijany „Plan dnia” (Etap 5, `DayPlanCard`: oś godzin z blokami, wolne okna, konflikty).
 * Nawyki jako blok (Etap 8): `habitsForDay` z odhaczeniem, celem ilościowym, dniem wolnym i passą;
 * o porze przeglądu (`reviewsDue`) — odnośnik do przeglądu dnia / tygodnia (Etap 9). Chipy filtra
 * (jak na webie) zawężają zadania, nie nawyki; filtr pamiętany per widok do zamknięcia aplikacji (R-06), nie jest zapisywany.
 * „Eksport XLSX” — zadania z sekcjami (bez nawyków), jak na webie.
 */
import { applyFilter, capitalized, dayLabel, habitsForDay, isEmptyFilter, plural, selectToday, VIEW_SECTION } from '@taskplanner/core';
import { useMemo } from 'react';
import { View } from 'react-native';

import { DayPlanCard } from '@/components/day-plan';
import { ExportChip } from '@/components/export-button';
import { FilterBar } from '@/components/filter-bar';
import { HabitTodayItem } from '@/components/habits';
import { ReviewNudge } from '@/components/review';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { useSmartView } from '@/components/view-options';
import { useAdhocFilter } from '@/lib/adhoc-filters';
import { targetInbox, useView } from '@/lib/app-data';
import { perfOnce, usePerfReady } from '@/lib/perf';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function TodayScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const [filter, setFilter] = useAdhocFilter(data.userId, 'today');
  const view = useMemo(() => selectToday(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx), [data.tasks, filter, today, ctx]);
  const habits = useMemo(() => habitsForDay(data.tasks, data.habitCompletions, today, today, workspaceId), [data.tasks, data.habitCompletions, today, workspaceId]);
  const exportRows = () => (['overdue', 'today', 'ongoing', 'done'] as const).flatMap((key) => view[key].map((task) => ({ task, section: VIEW_SECTION[key] })));
  const { row, options, columnsHeader } = useSmartView('today', data, today, workspaceId, <ExportChip title="Dziś" rows={exportRows} />);
  const open = view.overdue.length + view.today.length;
  const habitsLeft = habits.filter((h) => !h.settled).length;
  usePerfReady('tab:index', data.loaded);
  if (data.loaded) perfOnce('start: Dziś', `${data.tasks.length} zadań`);
  const sections: TaskSection[] = [
    { key: 'plan', data: [], footer: data.loaded ? <><DayPlanCard data={data} today={today} workspaceId={workspaceId} />{columnsHeader}</> : undefined },
    { key: 'overdue', title: VIEW_SECTION.overdue, count: view.overdue.length, tone: 'bad', data: view.overdue.map((t) => row(t, { withList: true })) },
    { key: 'today', title: VIEW_SECTION.today, count: view.today.length, data: view.today.map((t) => row(t, { showDate: false, withList: true })) },
    { key: 'ongoing', title: VIEW_SECTION.ongoing, count: view.ongoing.length, data: view.ongoing.map((t) => row(t, { withList: true })) },
    {
      key: 'habits',
      title: habits.length ? `${VIEW_SECTION.habits}${habitsLeft ? '' : ' · wszystko zrobione'}` : undefined,
      count: habitsLeft,
      data: [],
      footer: habits.length ? (
        <View>
          {habits.map((h) => (
            <HabitTodayItem key={h.task.id} item={h} today={today} />
          ))}
        </View>
      ) : undefined,
    },
    { key: 'done', title: VIEW_SECTION.done, count: view.done.length, data: view.done.map((t) => row(t, { showDate: false, withList: true })) },
  ];
  return (
    <TaskSections
      sections={sections}
      header={
        <ScreenHeader subtitle={`${capitalized(dayLabel(today))} · ${plural(open, TASKS)}`}>
          <ReviewNudge />
          {options}
          <FilterBar query={filter} onChange={setFilter} save />
        </ScreenHeader>
      }
      empty={data.loaded ? 'Na dziś nic nie ma.' : 'Wczytywanie…'}
      quickAdd={{ listId: targetInbox(data, workspaceId)?.id, dueDate: today }}
    />
  );
}
