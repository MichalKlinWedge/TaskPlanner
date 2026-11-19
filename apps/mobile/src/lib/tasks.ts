/**
 * Operacje na zadaniach używane przez ekrany PoC-4, widżet i akcje z powiadomień. Wszystko idzie
 * przez lokalną bazę (`mutate` → wiersz + outbox). Pełne widoki i reguły — MVP-2/MVP-3 w `packages/core`.
 */
import {
  addDays,
  completionId,
  keyBetween,
  nextDue,
  parseQuickAdd,
  uuidv7,
  type QuickAddResult,
  type Recurrence,
} from '@taskplanner/core';
import { decodeRow, type SqlRow } from '@taskplanner/sync';

import { localEngine, mutate } from './sync';
import { localNow, localToday, startOfDayIso } from './time';

export const DEMO_LIST = 'PoC-4';
/** Zadania z serii przypomnień (pomiar opóźnień) — poza widokiem „Dziś”, żeby go nie zaśmiecać. */
export const REMINDER_LIST = 'PoC-4 przypomnienia';

export interface TaskRow {
  id: string;
  list_id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  recurrence: Recurrence | null;
  completed_at: string | null;
  postpone_count: number;
  description_md: string | null;
}

const nowIso = () => new Date().toISOString();

async function listByName(name: string): Promise<string> {
  const engine = await localEngine();
  const row = (await engine.db.all<{ id: string }>('select id from lists where name = ? and deleted_at is null order by id limit 1', [name]))[0];
  if (row) return row.id;
  const id = uuidv7();
  await mutate('lists', id, { scope_id: engine.userId, kind: 'list', name, sort_key: 'n' });
  return id;
}

export const demoListId = () => listByName(DEMO_LIST);
export const reminderListId = () => listByName(REMINDER_LIST);

async function nextSortKey(listId: string): Promise<string> {
  const engine = await localEngine();
  const last = (await engine.db.all<{ k: string | null }>('select max(sort_key) as k from tasks where list_id = ? and parent_id is null', [listId]))[0]?.k;
  return keyBetween(last ?? undefined);
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const engine = await localEngine();
  const row = await engine.get('tasks', id);
  return row ? decodeRow<TaskRow>('tasks', row) : null;
}

export async function createTask(fields: Partial<Omit<TaskRow, 'id'>> & { list_id: string; title: string; source?: unknown }): Promise<string> {
  const id = uuidv7();
  await mutate('tasks', id, { kind: 'task', status: 'todo', priority: 4, sort_key: await nextSortKey(fields.list_id), ...fields });
  return id;
}

/** Widok „Dziś”: niezrobione z terminem do dziś + zrobione dziś (odhaczone zostają na liście). */
export async function todayTasks(today = localToday()): Promise<TaskRow[]> {
  const engine = await localEngine();
  const rows = await engine.db.all<SqlRow>(
    `select t.* from tasks t join lists l on l.id = t.list_id
     where t.deleted_at is null and t.parent_id is null and t.kind = 'task' and l.name <> ?
       and ((t.status not in ('done', 'cancelled') and t.due_date is not null and t.due_date <= ?)
         or (t.status = 'done' and t.completed_at >= ?))
     order by t.status = 'done', t.due_date, coalesce(t.due_time, '99:99'), t.sort_key`,
    [REMINDER_LIST, today, startOfDayIso(today)],
  );
  return rows.map((r) => decodeRow<TaskRow>('tasks', r));
}

/** Ukończenie: cykliczne → wpis w `task_completions` (UUIDv5, „to samo” z dwóch urządzeń) + następny termin. */
export async function completeTask(id: string, today = localToday()): Promise<void> {
  const task = await getTask(id);
  if (!task || task.status === 'done') return;
  if (task.recurrence) {
    const occurrence = task.due_date ?? today;
    await mutate('task_completions', completionId(id, occurrence), { task_id: id, occurrence_date: occurrence, kind: 'done', completed_at: nowIso() });
    const next = nextDue(task.recurrence, { occurrence, completedOn: today });
    if (next) {
      await mutate('tasks', id, { due_date: next });
      return;
    }
  }
  await mutate('tasks', id, { status: 'done', completed_at: nowIso() });
}

export async function reopenTask(id: string): Promise<void> {
  await mutate('tasks', id, { status: 'todo', completed_at: null });
}

export async function toggleTask(id: string): Promise<void> {
  const task = await getTask(id);
  if (!task) return;
  if (task.status === 'done') await reopenTask(id);
  else await completeTask(id);
}

/** „Odłóż do jutra”: termin +1 dzień od dziś, licznik odłożeń (przegląd tygodnia). */
export async function postponeToTomorrow(id: string, today = localToday()): Promise<void> {
  const task = await getTask(id);
  if (!task || task.status === 'done') return;
  await mutate('tasks', id, { due_date: addDays(today, 1), postpone_count: (task.postpone_count ?? 0) + 1 });
}

/** Zmiana bloku czasu z widoku dnia (przeciągnięcie / rozciągnięcie). */
export async function moveTaskBlock(id: string, dueDate: string, dueTime: string, durationMin: number): Promise<void> {
  await mutate('tasks', id, { due_date: dueDate, due_time: dueTime, duration_min: Math.max(5, Math.round(durationMin)) });
}

/** Dane przykładowe: kilka zadań na dziś (z godziną, bez, zaległe, cykliczne). */
export async function seedDemoTasks(): Promise<number> {
  const listId = await demoListId();
  const today = localToday();
  const demo: Partial<TaskRow>[] = [
    { title: 'Zaległy: odpisać na maila', due_date: addDays(today, -1) },
    { title: 'Kupić mleko', due_date: today },
    { title: 'Spotkanie zespołu', due_date: today, due_time: '10:00', duration_min: 60 },
    { title: 'Przegląd PR', due_date: today, due_time: '13:30', duration_min: 45 },
    { title: 'Trening', due_date: today, due_time: '18:00', duration_min: 60, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: today } },
    { title: 'Podlać kwiaty (co 3 dni po ukończeniu)', due_date: today, recurrence: { mode: 'after_completion', every: { unit: 'day', n: 3 } } },
  ];
  for (const fields of demo) await createTask({ list_id: listId, title: fields.title!, ...fields });
  return demo.length;
}

// ── Szybkie dodawanie (udostępnianie z innej aplikacji) ───────────────────────────────────────

async function quickAddContext() {
  const engine = await localEngine();
  const workspaces = await engine.db.all<{ id: string; name: string }>('select id, name from workspaces where deleted_at is null');
  const lists = await engine.db.all<{ id: string; name: string; kind: string; scope_id: string }>('select id, name, kind, scope_id from lists where deleted_at is null');
  const tags = await engine.db.all<{ name: string }>('select name from tags where deleted_at is null');
  const wsName = (scope: string) => workspaces.find((w) => w.id === scope)?.name ?? 'Osobiste';
  return {
    ctx: {
      now: localNow(),
      workspaces: workspaces.length ? workspaces.map((w) => w.name) : ['Osobiste'],
      lists: lists.map((l) => ({ workspace: wsName(l.scope_id), name: l.name, kind: l.kind })),
      tags: tags.map((t) => t.name),
    },
    lists,
    userId: engine.userId,
    wsName,
  };
}

export async function previewQuickAdd(text: string): Promise<QuickAddResult> {
  const { ctx } = await quickAddContext();
  return parseQuickAdd(text, ctx);
}

/** Zadanie z udostępnionego tekstu: pola z parsera, link w opisie, `source` = link. */
export async function createFromQuickAdd(text: string, link: { url: string | null; title?: string | null }): Promise<{ id: string; listName: string; result: QuickAddResult }> {
  const { ctx, lists, userId, wsName } = await quickAddContext();
  const result = parseQuickAdd(text, ctx);
  const { fields } = result;
  const target = fields.target
    ? lists.find((l) =>
        fields.target!.kind === 'list'
          ? l.name === fields.target!.name && wsName(l.scope_id) === fields.target!.workspace
          : l.kind === 'inbox' && wsName(l.scope_id) === fields.target!.name,
      )
    : undefined;
  const inbox = lists.find((l) => l.kind === 'inbox' && l.scope_id === userId);
  const listId = target?.id ?? inbox?.id ?? (await demoListId());
  const id = await createTask({
    list_id: listId,
    title: result.title || link.title || link.url || 'Udostępniony link',
    due_date: fields.dueDate ?? null,
    due_time: fields.dueTime ?? null,
    duration_min: fields.durationMin ?? null,
    recurrence: (fields.recurrence as Recurrence | undefined) ?? null,
    description_md: link.url ? `[${link.title || link.url}](${link.url})` : null,
    source: link.url ? { kind: 'link', url: link.url, title: link.title ?? null } : { kind: 'quick_add' },
    ...(fields.priority && { priority: fields.priority }),
  } as Parameters<typeof createTask>[0]);
  const listName = lists.find((l) => l.id === listId)?.name ?? DEMO_LIST;
  return { id, listName, result };
}
