/**
 * „Nadchodzące” (M9): 14 dni (także puste, z „+ Dodaj” na dzień), potem tygodniami; wirtualne
 * wystąpienia serii tylko do odczytu — wszystko z `selectUpcoming` (core). Chipy filtra (jak na
 * webie) zawężają zadania; filtr trwa do zamknięcia aplikacji, nie jest zapisywany. „Eksport XLSX” jak na webie.
 */
import { addDays, applyFilter, capitalized, dayLabel, dayMonth, isEmptyFilter, relativeDay, selectUpcoming, VIEW_SECTION, type FilterQuery } from '@taskplanner/core';
import { useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { ExportChip } from '@/components/export-button';
import { FilterBar } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { openQuickAdd, TaskSections, type TaskSection } from '@/components/task-list';
import { usePalette } from '@/components/ui';
import { useSmartView } from '@/components/view-options';
import { targetInbox, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';

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
  usePerfReady('tab:upcoming', data.loaded);
  const [filter, setFilter] = useState<FilterQuery>({});
  const view = useMemo(() => selectUpcoming(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx), [data.tasks, filter, today, ctx]);
  // Eksport jak na webie: dzień jako sekcja, wystąpienie serii z własnym terminem.
  const exportRows = () => [
    ...view.days.flatMap(({ date, items }) => items.map((item) => ({ task: item.task, section: capitalized(dayLabel(date)), date: item.virtual ? item.date : undefined }))),
    ...view.later.flatMap(({ weekStart, items }) => items.map((item) => ({ task: item.task, section: `Tydzień od ${dayMonth(weekStart)}` }))),
  ];
  const { row, options, columnsHeader } = useSmartView('upcoming', data, today, workspaceId, <ExportChip title="Nadchodzące" rows={exportRows} />);
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
          {options}
          <FilterBar query={filter} onChange={setFilter} save />
          {columnsHeader}
        </ScreenHeader>
      }
      quickAdd={{ listId: inbox, dueDate: today }}
    />
  );
}
