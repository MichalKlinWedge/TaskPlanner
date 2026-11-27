/**
 * Użycie cudzej osoby w przestrzeniach do „Przejmij” (core `takeOverCollaboratorOps`) — z lokalnej
 * bazy, to samo na webie i telefonie. Tylko zadania na listach, które wolno edytować (`editable`).
 */
import type { TakeOverUsage } from '@taskplanner/core';

import type { BackupQuery } from './backup.ts';

export async function readTakeOverUsage(
  query: BackupQuery,
  sharedId: string,
  targetId: string | null,
  spaces: readonly string[],
  editable: (listId: string) => boolean,
): Promise<TakeOverUsage> {
  if (!spaces.length) return { assignedTaskIds: [], participations: [], targetParticipantTaskIds: [] };
  const inSpaces = `t.scope_id in (${spaces.map(() => '?').join(', ')})`;
  const [assigned, participations, target] = await Promise.all([
    query<{ id: string; list_id: string }>(`select t.id, t.list_id from tasks t where t.assignee_id = ? and ${inSpaces}`, [sharedId, ...spaces]),
    query<{ id: string; task_id: string; list_id: string }>(
      `select p.id, p.task_id, t.list_id from task_participants p join tasks t on t.id = p.task_id where p.collaborator_id = ? and p.deleted_at is null and ${inSpaces}`,
      [sharedId, ...spaces],
    ),
    targetId ? query<{ task_id: string }>('select task_id from task_participants where collaborator_id = ? and deleted_at is null', [targetId]) : Promise.resolve([]),
  ]);
  return {
    assignedTaskIds: assigned.filter((r) => editable(r.list_id)).map((r) => r.id),
    participations: participations.filter((r) => editable(r.list_id)).map((r) => ({ id: r.id, taskId: r.task_id })),
    targetParticipantTaskIds: target.map((r) => r.task_id),
  };
}
