/**
 * Inbox (M9): otwarte zadania list `inbox` bieżącej przestrzeni albo wszystkich (`selectInbox`),
 * zawężone chipami filtra (jak na webie; filtr trwa do zamknięcia aplikacji, nie jest zapisywany).
 */
import { applyFilter, isEmptyFilter, plural, selectInbox, type FilterQuery } from '@taskplanner/core';
import { useMemo, useState } from 'react';

import { FilterBar } from '@/components/filter-bar';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections } from '@/components/task-list';
import { targetInbox, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';
import { rowMaker } from '@/lib/rows';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function InboxScreen() {
  const { data, today, ctx, workspaceId } = useView();
  usePerfReady('tab:inbox', data.loaded);
  const inboxIds = useMemo(() => new Set(data.lists.filter((l) => l.kind === 'inbox').map((l) => l.id)), [data.lists]);
  const [filter, setFilter] = useState<FilterQuery>({});
  const tasks = useMemo(() => {
    const inbox = selectInbox(data.tasks, inboxIds, ctx);
    return isEmptyFilter(filter) ? inbox : applyFilter(inbox, filter, today);
  }, [data.tasks, inboxIds, ctx, filter, today]);
  const row = rowMaker(data, today);
  const wsName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const target = targetInbox(data, workspaceId);
  return (
    <TaskSections
      sections={[{ key: 'inbox', data: tasks.map((t) => row(t, { listName: workspaceId ? undefined : wsName.get(t.workspaceId) })) }]}
      header={
        <ScreenHeader subtitle={`${plural(tasks.length, TASKS)}${target && !workspaceId ? ` · nowe do „${wsName.get(target.workspaceId)}”` : ''}`}>
          <FilterBar query={filter} onChange={setFilter} hide={['lists']} />
        </ScreenHeader>
      }
      empty={data.loaded ? 'Inbox jest pusty.' : 'Wczytywanie…'}
      quickAdd={{ listId: target?.id }}
    />
  );
}
