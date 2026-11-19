/** „Dziś” (M9): zaległe, dziś, trwające, nawyki, ukończone dziś — reguły z `selectToday` (core). */
import { capitalized, dayLabel, plural, selectToday, VIEW_SECTION } from '@taskplanner/core';
import { useMemo } from 'react';

import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { targetInbox, useView } from '@/lib/app-data';
import { rowMaker } from '@/lib/rows';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function TodayScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const view = useMemo(() => selectToday(data.tasks, ctx), [data.tasks, ctx]);
  const row = rowMaker(data, today);
  const open = view.overdue.length + view.today.length;
  const sections: TaskSection[] = [
    { key: 'overdue', title: VIEW_SECTION.overdue, count: view.overdue.length, tone: 'bad', data: view.overdue.map((t) => row(t, { withList: true })) },
    { key: 'today', title: VIEW_SECTION.today, count: view.today.length, data: view.today.map((t) => row(t, { showDate: false, withList: true })) },
    { key: 'ongoing', title: VIEW_SECTION.ongoing, count: view.ongoing.length, data: view.ongoing.map((t) => row(t, { withList: true })) },
    { key: 'habits', title: VIEW_SECTION.habits, count: view.habits.length, data: view.habits.map((t) => row(t, { showDate: false, habitDone: data.habitsDoneToday.has(t.id) })) },
    { key: 'done', title: VIEW_SECTION.done, count: view.done.length, data: view.done.map((t) => row(t, { showDate: false, withList: true })) },
  ];
  return (
    <TaskSections
      sections={sections}
      header={<ScreenHeader subtitle={`${capitalized(dayLabel(today))} · ${plural(open, TASKS)}`} />}
      empty={data.loaded ? 'Na dziś nic nie ma.' : 'Wczytywanie…'}
      quickAdd={{ listId: targetInbox(data, workspaceId)?.id, dueDate: today }}
    />
  );
}
