/**
 * „Nadchodzące” (M9): 14 dni (także puste, z „+ Dodaj” na dzień), potem tygodniami; wirtualne
 * wystąpienia serii tylko do odczytu — wszystko z `selectUpcoming` (core). Chipy filtra (jak na
 * webie) zawężają zadania; filtr pamiętany per widok do zamknięcia aplikacji (R-06), nie jest zapisywany. „+” dodaje
 * zadanie bez terminu (jak Q na webie, R-08); termin wpisany w treści działa jak zawsze. „Eksport XLSX” jak na webie.
 */
import { addDays, applyFilter, capitalized, dayLabel, dayMonth, isEmptyFilter, relativeDay, selectUpcoming, sortSection, VIEW_SECTION, type ViewTask } from '@taskplanner/core';
import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';

import { FilterBar } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { openQuickAdd, TaskSections, type TaskSection } from '@/components/task-list';
import { usePalette } from '@/components/ui';
import { smartSort, useSmartView } from '@/components/view-options';
import { useAdhocFilter } from '@/lib/adhoc-filters';
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
  const [filter, setFilter] = useAdhocFilter(data.userId, 'upcoming');
  const { by, dir } = smartSort(data, 'upcoming');
  // Wybrane sortowanie działa w obrębie dnia / tygodnia; dni zostają po kolei.
  const view = useMemo(() => {
    const upcoming = selectUpcoming(isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today), ctx);
    const sort = <T extends { task: ViewTask }>(items: T[]) => sortSection(items, by, dir, (i) => i.task);
    return { days: upcoming.days.map((d) => ({ ...d, items: sort(d.items) })), later: upcoming.later.map((w) => ({ ...w, items: sort(w.items) })) };
  }, [data.tasks, filter, today, ctx, by, dir]);
  // Eksport jak na webie: dzień jako sekcja, wystąpienie serii z własnym terminem.
  const exportRows = () => [
    ...view.days.flatMap(({ date, items }) => items.map((item) => ({ task: item.task, section: capitalized(dayLabel(date)), date: item.virtual ? item.date : undefined }))),
    ...view.later.flatMap(({ weekStart, items }) => items.map((item) => ({ task: item.task, section: `Tydzień od ${dayMonth(weekStart)}` }))),
  ];
  const { row, options, columnsHeader } = useSmartView('upcoming', data, today, workspaceId, { title: 'Nadchodzące', rows: exportRows });
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
      quickAdd={{ listId: inbox }}
    />
  );
}
