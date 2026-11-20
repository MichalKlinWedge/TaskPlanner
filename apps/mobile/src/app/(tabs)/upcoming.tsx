/**
 * „Nadchodzące” (M9): 14 dni (także puste, z „+ Dodaj” na dzień), potem tygodniami; wirtualne
 * wystąpienia serii tylko do odczytu — wszystko z `selectUpcoming` (core). Chipy filtra (jak na
 * webie) zawężają zadania; filtr trwa do zamknięcia aplikacji, nie jest zapisywany.
 */
import { addDays, applyFilter, capitalized, dayLabel, isEmptyFilter, relativeDay, selectUpcoming, VIEW_SECTION, type FilterQuery } from '@taskplanner/core';
import { useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { FilterBar } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { openQuickAdd, TaskSections, type TaskSection } from '@/components/task-list';
import { usePalette } from '@/components/ui';
import { targetInbox, useView } from '@/lib/app-data';
import { rowMaker } from '@/lib/rows';

function AddOnDay({ date, listId }: { date: string; listId?: string }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Dodaj zadanie na ${dayLabel(date)}`} onPress={() => openQuickAdd({ listId, dueDate: date })} style={{ paddingHorizontal: 44, paddingVertical: 8 }}>
      <Text style={{ color: p.muted, fontSize: 13 }}>+ Dodaj</Text>
    </Pressable>
  );
}

export default function UpcomingScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const [filter, setFilter] = useState<FilterQuery>({});
  const view = useMemo(() => selectUpcoming(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx), [data.tasks, filter, today, ctx]);
  const row = rowMaker(data, today);
  const inbox = targetInbox(data, workspaceId)?.id;
  const sections: TaskSection[] = [
    ...view.days.map(({ date, items }) => ({
      key: date,
      title: `${capitalized(relativeDay(date, today))}${date === today || date === addDays(today, 1) ? ` · ${dayLabel(date)}` : ''}`,
      count: items.length || undefined,
      data: items.map((item) => row(item.task, { key: `${item.task.id}:${item.date}`, showDate: false, withList: true, ...(item.virtual && { virtualDate: item.date }) })),
      footer: <AddOnDay date={date} listId={inbox} />,
    })),
    ...view.later.map(({ weekStart, items }) => ({
      key: `later:${weekStart}`,
      title: `${VIEW_SECTION.later} · tydzień od ${relativeDay(weekStart, today)}`,
      count: items.length,
      data: items.map((item) => row(item.task, { key: `${item.task.id}:later`, withList: true })),
    })),
  ];
  return (
    <TaskSections
      sections={sections}
      header={
        <ScreenHeader subtitle="14 dni, dalej tygodniami · przesuń zadanie w lewo, żeby zmienić termin">
          <FilterBar query={filter} onChange={setFilter} />
        </ScreenHeader>
      }
      quickAdd={{ listId: inbox, dueDate: today }}
    />
  );
}
