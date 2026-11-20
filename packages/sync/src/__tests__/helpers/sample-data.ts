/**
 * Dane jak z aplikacji do testów kopii (Etap 13): onboarding, szybkie dodawanie (tagi,
 * przypomnienia, cykl), podzadania do 3 poziomów, kosz, ukończenie serii, wpis czasu, filtr, przegląd,
 * współpracownik (odpowiedzialny i uczestnik), komentarz.
 */
import { addCommentOps, addParticipantOps, collaboratorId, completeTaskOps, inboxId, keyBetween, onboardingOps, parseQuickAdd, quickAddTaskOps, uuidv7 } from '@taskplanner/core';

import type { SyncEngine } from '../../engine.ts';

export async function fillSample(engine: SyncEngine, userId: string) {
  const ops = onboardingOps(userId, { displayName: 'Ja', settings: { timeZone: 'Europe/Warsaw' } });
  await engine.mutateMany(ops);
  const workspace = ops[1]!.id;
  const inbox = inboxId(workspace);
  const scope = {
    userId,
    workspaces: [{ id: workspace, name: 'Osobiste' }],
    lists: [{ id: inbox, workspaceId: workspace, kind: 'inbox', name: 'Inbox' }],
    tags: [] as { id: string; name: string; sortKey: string }[],
    defaultListId: inbox,
    lastSortKey: () => undefined,
  };
  const ctx = { now: '2026-11-18T12:00', workspaces: ['Osobiste'], lists: [], tags: [] };
  const ids: string[] = [];
  for (const text of ['Zadzwonić do mamy jutro o 18 @telefon !1 ^30m', 'Podlać kwiaty co tydzień w sobotę', 'Raport ~45m za 3 dni @komputer']) {
    const { taskId, ops: taskOps } = quickAddTaskOps(parseQuickAdd(text, ctx), text, { ...scope, tags: [] });
    await engine.mutateMany(taskOps);
    ids.push(taskId);
  }
  const sub = uuidv7();
  const subsub = uuidv7();
  await engine.mutateMany([
    { table: 'tasks', id: sub, patch: { list_id: inbox, parent_id: ids[2], title: 'Zebrać liczby', sort_key: keyBetween(undefined), status: 'todo', priority: 4, kind: 'task', postpone_count: 0 } },
    { table: 'tasks', id: subsub, patch: { list_id: inbox, parent_id: sub, title: 'Arkusz', sort_key: keyBetween(undefined) } },
    { table: 'time_entries', id: uuidv7(), patch: { task_id: ids[2], kind: 'manual', started_at: '2026-11-18T09:00:00.000Z', ended_at: '2026-11-18T09:30:00.000Z', pomodoro_index: null } },
    { table: 'saved_filters', id: uuidv7(), patch: { name: 'Pilne', icon: null, query: { priorities: [1] }, sort_key: 'a' } },
    { table: 'review_sessions', id: uuidv7(), patch: { kind: 'daily', started_at: '2026-11-18T20:00:00.000Z', finished_at: null, stats: null } },
  ]);
  const anna = collaboratorId(userId, 'Anna');
  const comment = addCommentOps(ids[2]!, 'Liczby od Anny w piątek.', '2026-11-18T10:00:00.000Z');
  if (!comment.ok) throw new Error(comment.error);
  await engine.mutateMany([
    { table: 'collaborators', id: anna, patch: { scope_id: userId, name: 'Anna', email: 'anna@example.com' } },
    { table: 'tasks', id: ids[2]!, patch: { assignee_id: anna } },
    ...addParticipantOps(ids[2]!, anna),
    ...comment.ops,
  ]);
  const series = (await engine.get('tasks', ids[1]!))!;
  const { ops: done } = completeTaskOps(
    { id: ids[1]!, kind: 'task', status: 'todo', dueDate: series.due_date as string, recurrence: JSON.parse(series.recurrence as string), completedAt: null, startDate: null, postponeCount: 0 },
    { now: '2026-11-18T12:00:00.000Z', timeZone: 'Europe/Warsaw' },
  );
  await engine.mutateMany(done);
  await engine.remove('tasks', ids[0]!);
  return { ids };
}

