/** Wspólne przygotowanie wierszy dla `TaskSections`: nazwy tagów i list z danych widoków. */
import type { ViewTask } from '@taskplanner/core';

import type { RowItem } from '@/components/task-list';
import type { TaskRowProps } from '@/components/task-row';

import { listLabel, type AppData } from './app-data';

export function rowMaker(data: AppData, today: string) {
  const tagName = new Map(data.tags.map((t) => [t.id, t.name]));
  return (task: ViewTask, extra: Partial<TaskRowProps> & { key?: string; withList?: boolean } = {}): RowItem => {
    const { key, withList, ...props } = extra;
    return {
      key: key ?? task.id,
      task,
      today: today as TaskRowProps['today'],
      tagNames: task.tagIds.map((id) => tagName.get(id) ?? '').filter(Boolean),
      ...(withList && { listName: listLabel(data, task.listId) }),
      ...props,
    };
  };
}
