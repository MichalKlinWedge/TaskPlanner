/** Inbox (M9): otwarte zadania list `inbox` bieżącej przestrzeni albo wszystkich (`selectInbox`). */
import { plural, selectInbox } from '@taskplanner/core';
import { useMemo } from 'react';

import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections } from '@/components/task-list';
import { targetInbox, useView } from '@/lib/app-data';
import { rowMaker } from '@/lib/rows';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function InboxScreen() {
  const { data, today, ctx, workspaceId } = useView();
  const inboxIds = useMemo(() => new Set(data.lists.filter((l) => l.kind === 'inbox').map((l) => l.id)), [data.lists]);
  const tasks = useMemo(() => selectInbox(data.tasks, inboxIds, ctx), [data.tasks, inboxIds, ctx]);
  const row = rowMaker(data, today);
  const wsName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const target = targetInbox(data, workspaceId);
  return (
    <TaskSections
      sections={[{ key: 'inbox', data: tasks.map((t) => row(t, { listName: workspaceId ? undefined : wsName.get(t.workspaceId) })) }]}
      header={<ScreenHeader subtitle={`${plural(tasks.length, TASKS)}${target && !workspaceId ? ` · nowe do „${wsName.get(target.workspaceId)}”` : ''}`} />}
      empty={data.loaded ? 'Inbox jest pusty.' : 'Wczytywanie…'}
      quickAdd={{ listId: target?.id }}
    />
  );
}
