/**
 * Inbox (M9): otwarte zadania list `inbox` bieżącej przestrzeni albo wszystkich (`selectInbox`),
 * zawężone chipami filtra (jak na webie; filtr pamiętany per widok do zamknięcia aplikacji, nie jest zapisywany — R-06);
 * „Eksport XLSX” widocznych zadań.
 */
import { applyFilter, isEmptyFilter, plural, selectInbox, sortSection } from '@taskplanner/core';
import { useMemo } from 'react';

import { ExportChip } from '@/components/export-button';
import { FilterBar, filterEmptyText } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections } from '@/components/task-list';
import { smartSort, useSmartView } from '@/components/view-options';
import { useAdhocFilter } from '@/lib/adhoc-filters';
import { targetInbox, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function InboxScreen() {
  const { data, today, ctx, workspaceId } = useView();
  usePerfReady('tab:inbox', data.loaded);
  const inboxIds = useMemo(() => new Set(data.lists.filter((l) => l.kind === 'inbox').map((l) => l.id)), [data.lists]);
  const [filter, setFilter] = useAdhocFilter(data.userId, 'inbox');
  const { by, dir } = smartSort(data, 'inbox');
  const tasks = useMemo(() => {
    const inbox = selectInbox(data.tasks, inboxIds, ctx);
    return sortSection(isEmptyFilter(filter) ? inbox : applyFilter(inbox, filter, today), by, dir, (t) => t);
  }, [data.tasks, inboxIds, ctx, filter, today, by, dir]);
  const { row, options, columnsHeader } = useSmartView('inbox', data, today, workspaceId, <ExportChip title="Inbox" rows={() => tasks.map((task) => ({ task }))} />);
  const wsName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const target = targetInbox(data, workspaceId);
  return (
    <TaskSections
      sections={[{ key: 'inbox', data: tasks.map((t) => row(t, { listName: workspaceId ? undefined : wsName.get(t.workspaceId) })) }]}
      header={
        <ScreenHeader subtitle={`${plural(tasks.length, TASKS)}${target && !workspaceId ? ` · nowe do „${wsName.get(target.workspaceId)}”` : ''}`}>
          {options}
          <FilterBar query={filter} onChange={setFilter} hide={['lists']} save />
          {tasks.length ? columnsHeader : null}
        </ScreenHeader>
      }
      empty={data.loaded ? filterEmptyText(filter, 'Inbox jest pusty.') : 'Wczytywanie…'}
      quickAdd={{ listId: target?.id }}
    />
  );
}
