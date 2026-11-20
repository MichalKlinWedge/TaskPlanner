/**
 * „Dziś” (M9): zaległe, dziś, trwające, nawyki, ukończone dziś — reguły z `selectToday` (core).
 * Nawyki jako blok (Etap 8): `habitsForDay` z odhaczeniem, celem ilościowym, dniem wolnym i passą;
 * o porze przeglądu (`reviewsDue`) — odnośnik do przeglądu dnia / tygodnia (Etap 9).
 */
import { capitalized, dayLabel, habitsForDay, plural, selectToday, VIEW_SECTION } from '@taskplanner/core';
import { useMemo } from 'react';
import { View } from 'react-native';

import { HabitTodayItem } from '@/components/habits';
import { ReviewNudge } from '@/components/review';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { targetInbox, useView } from '@/lib/app-data';
import { rowMaker } from '@/lib/rows';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function TodayScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const view = useMemo(() => selectToday(data.tasks, ctx), [data.tasks, ctx]);
  const habits = useMemo(() => habitsForDay(data.tasks, data.habitCompletions, today, today, workspaceId), [data.tasks, data.habitCompletions, today, workspaceId]);
  const row = rowMaker(data, today);
  const open = view.overdue.length + view.today.length;
  const habitsLeft = habits.filter((h) => !h.settled).length;
  const sections: TaskSection[] = [
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
        </ScreenHeader>
      }
      empty={data.loaded ? 'Na dziś nic nie ma.' : 'Wczytywanie…'}
      quickAdd={{ listId: targetInbox(data, workspaceId)?.id, dueDate: today }}
    />
  );
}
