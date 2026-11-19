/**
 * Zadanie z lokalnej bazy w postaci dla widoków (`ViewTask`) oraz ukończenie i cofnięcie
 * ukończenia jako operacje `mutate` (M3, §7.2). Web i telefon wołają te same funkcje — reguła
 * „seria przesuwa termin, zamiast się zamykać” jest tylko tutaj.
 */
import { addDays, daysBetween, localDateAt } from './dates.ts';
import { HabitSettings } from './habits.ts';
import { isHlc, parseHlc } from './hlc.ts';
import { completionId, tagId, taskTagId, uuidv7 } from './ids.ts';
import { normalizeWord, type QuickAddResult } from './quick-add.ts';
import { nextDue, Recurrence } from './recurrence.ts';
import { keyBetween } from './sort-key.ts';
import type { LocalDate, LocalTime, Priority, TaskStatus } from './schemas/primitives.ts';
import type { ViewTask } from './views.ts';

/** Wiersz `tasks` z lokalnej bazy: kolumny `jsonb` jako tekst JSON albo już obiekt. */
export interface LocalTaskRow {
  id: string;
  scope_id: string | null;
  list_id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  status: string;
  priority: number;
  start_date: string | null;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  recurrence: unknown;
  habit: unknown;
  completed_at: string | null;
  created_at: string | null;
  sort_key: string;
  postpone_count: number | null;
  field_clock?: unknown;
}

const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** Czas z HLC pola (`field_clock`) jako ISO; brak / zły zapis → `null`. */
function fieldChangedAt(fieldClock: unknown, field: string): string | null {
  const clock = json(fieldClock);
  const hlc = clock && typeof clock === 'object' ? (clock as Record<string, unknown>)[field] : undefined;
  return isHlc(hlc) ? new Date(parseHlc(hlc).wall).toISOString() : null;
}

/**
 * Wiersz lokalnej bazy → `ViewTask`. Niepoprawna reguła cyklu lub ustawienia nawyku (np. z nowszej
 * wersji aplikacji) dają `null` — zadanie zostaje widoczne jako zwykłe.
 */
export function toViewTask(row: LocalTaskRow, tagIds: readonly string[] = []): ViewTask {
  const recurrence = Recurrence.safeParse(json(row.recurrence));
  const habit = HabitSettings.safeParse(json(row.habit));
  return {
    id: row.id,
    workspaceId: row.scope_id ?? '',
    listId: row.list_id,
    parentId: row.parent_id,
    kind: row.kind === 'habit' ? 'habit' : 'task',
    title: row.title,
    status: row.status as TaskStatus,
    priority: Number(row.priority) as Priority,
    startDate: row.start_date as LocalDate | null,
    dueDate: row.due_date as LocalDate | null,
    dueTime: row.due_time as LocalTime | null,
    durationMin: row.duration_min === null ? null : Number(row.duration_min),
    recurrence: recurrence.success && row.recurrence !== null ? recurrence.data : null,
    habit: habit.success && row.habit !== null ? habit.data : null,
    completedAt: row.completed_at,
    // Wiersz utworzony offline nie ma jeszcze `created_at` z serwera.
    createdAt: row.created_at ?? new Date(0).toISOString(),
    sortKey: row.sort_key,
    tagIds,
    postponeCount: Number(row.postpone_count ?? 0),
    statusChangedAt: fieldChangedAt(row.field_clock, 'status'),
  };
}

export interface TaskOp {
  table: 'tasks' | 'task_completions' | 'tags' | 'task_tags' | 'reminders';
  id: string;
  patch: Record<string, unknown>;
}

export interface CompleteResult {
  ops: TaskOp[];
  /** Operacje przywracające stan sprzed ukończenia („Cofnij”). */
  undo: TaskOp[];
  /** Nowy termin serii; `null` = zadanie zamknięte (zwykłe albo koniec serii). */
  nextDue: LocalDate | null;
}

type CompletableTask = Pick<ViewTask, 'id' | 'kind' | 'status' | 'startDate' | 'dueDate' | 'recurrence' | 'completedAt' | 'postponeCount'>;

/**
 * Ukończenie zadania w chwili `now`. Zwykłe zadanie → `done`. Seria → wpis w `task_completions`
 * (id deterministyczne: dwa urządzenia ukończą to samo wystąpienie jednym wierszem) i termin
 * przesunięty na `nextDue` razem z początkiem zakresu; licznik przesunięć się zeruje, bo to nowe
 * wystąpienie. Koniec serii (`COUNT`/`UNTIL`) zamyka zadanie. Nawyk → tylko wpis na dziś.
 */
export function completeTaskOps(task: CompletableTask, { now, timeZone }: { now: Date | string; timeZone?: string }): CompleteResult {
  const at = new Date(now).toISOString();
  const today = localDateAt(at, timeZone);
  const completion = (date: LocalDate): TaskOp => ({
    table: 'task_completions',
    id: completionId(task.id, date),
    patch: { task_id: task.id, occurrence_date: date, kind: 'done', value: null, completed_at: at, deleted_at: null },
  });
  const removed = (op: TaskOp): TaskOp => ({ table: op.table, id: op.id, patch: { deleted_at: at } });
  const close: TaskOp = { table: 'tasks', id: task.id, patch: { status: 'done', completed_at: at } };
  const before: TaskOp = { table: 'tasks', id: task.id, patch: { status: task.status, completed_at: task.completedAt } };

  if (task.kind === 'habit') {
    const done = completion(today);
    return { ops: [done], undo: [removed(done)], nextDue: null };
  }
  if (!task.recurrence) return { ops: [close], undo: [before], nextDue: null };

  const occurrence = task.dueDate ?? today;
  const done = completion(occurrence);
  const next = nextDue(task.recurrence, { occurrence, completedOn: today });
  if (!next) return { ops: [done, close], undo: [removed(done), before], nextDue: null };
  const shift = daysBetween(occurrence, next);
  return {
    ops: [done, { table: 'tasks', id: task.id, patch: { due_date: next, start_date: task.startDate ? addDays(task.startDate, shift) : null, postpone_count: 0 } }],
    undo: [removed(done), { table: 'tasks', id: task.id, patch: { due_date: task.dueDate, start_date: task.startDate, postpone_count: task.postponeCount } }],
    nextDue: next,
  };
}

/** Ponowne otwarcie zamkniętego zadania (odhaczenie w widoku ukończonych). */
export const reopenTaskPatch = (): Record<string, unknown> => ({ status: 'todo', completed_at: null });

// ── Szybkie dodawanie ────────────────────────────────────────────────────────────────────────

/** Przestrzenie, listy i tagi z lokalnej bazy — do rozwiązania `#lista`, `#przestrzeń` i `@tag`. */
export interface QuickAddScope {
  userId: string;
  workspaces: readonly { id: string; name: string }[];
  lists: readonly { id: string; workspaceId: string; kind: string; name: string }[];
  tags: readonly { id: string; name: string; sortKey: string }[];
  /** Lista, gdy wpis nie wskazuje innej (Inbox bieżącej przestrzeni albo lista, z której wywołano). */
  defaultListId: string;
  /** Termin, gdy wpis go nie podaje (np. „Dziś”, dzień w „Nadchodzących”). */
  defaultDueDate?: string | null;
  /** Ostatni klucz kolejności zadań głównych listy — nowe zadanie idzie na koniec. */
  lastSortKey: (listId: string) => string | undefined;
  /** Generator id (testy); domyślnie UUIDv7. */
  newId?: () => string;
}

export interface QuickAddOps {
  taskId: string;
  listId: string;
  ops: TaskOp[];
}

const same = (a: string, b: string) => normalizeWord(a) === normalizeWord(b);

/**
 * Wynik `parseQuickAdd` → operacje `mutate`: zadanie (z `source`), nowe tagi (id deterministyczne
 * z nazwy — dwa urządzenia tworzą ten sam tag jednym wierszem), powiązania z tagami i przypomnienia.
 * Wskazana przestrzeń = jej Inbox; nieznana lista / przestrzeń (parser zna tylko istniejące) — lista domyślna.
 */
export function quickAddTaskOps(result: QuickAddResult, text: string, scope: QuickAddScope): QuickAddOps {
  const newId = scope.newId ?? (() => uuidv7());
  const { fields } = result;
  const title = result.title.trim();
  if (!title) throw new Error('Zadanie musi mieć tytuł.');

  let listId = scope.defaultListId;
  const target = fields.target;
  if (target) {
    const workspace = scope.workspaces.find((w) => same(w.name, target.workspace));
    const list =
      target.kind === 'workspace'
        ? scope.lists.find((l) => l.kind === 'inbox' && l.workspaceId === workspace?.id)
        : scope.lists.find((l) => l.kind !== 'inbox' && same(l.name, target.name) && (!workspace || l.workspaceId === workspace.id));
    if (list) listId = list.id;
  }

  const taskId = newId();
  const ops: TaskOp[] = [];
  const dueDate = fields.dueDate ?? scope.defaultDueDate ?? null;
  ops.push({
    table: 'tasks',
    id: taskId,
    patch: {
      list_id: listId,
      parent_id: null,
      kind: 'task',
      title: title.slice(0, 500),
      status: 'todo',
      priority: fields.priority ?? 4,
      due_date: dueDate,
      due_time: dueDate ? (fields.dueTime ?? null) : null,
      duration_min: fields.durationMin ?? null,
      recurrence: fields.recurrence ?? null,
      sort_key: keyBetween(scope.lastSortKey(listId)),
      source: { kind: 'quick_add', text: text.slice(0, 1000) },
      postpone_count: 0,
    },
  });

  let lastTagKey = scope.tags.reduce<string | undefined>((max, t) => (!max || t.sortKey > max ? t.sortKey : max), undefined);
  for (const name of new Set(fields.tags ?? [])) {
    let id = scope.tags.find((t) => same(t.name, name))?.id;
    if (!id) {
      id = tagId(scope.userId, name);
      lastTagKey = keyBetween(lastTagKey);
      ops.push({ table: 'tags', id, patch: { name: name.slice(0, 60), color: null, sort_key: lastTagKey } });
    }
    ops.push({ table: 'task_tags', id: taskTagId(taskId, id), patch: { task_id: taskId, tag_id: id, deleted_at: null } });
  }

  for (const reminder of fields.reminders ?? []) {
    ops.push({
      table: 'reminders',
      id: newId(),
      patch:
        reminder.kind === 'relative'
          ? { task_id: taskId, kind: 'relative', offset_min: reminder.offsetMin, at_date: null, at_time: null }
          : { task_id: taskId, kind: 'absolute', offset_min: null, at_date: reminder.atDate, at_time: reminder.atTime },
    });
  }
  return { taskId, listId, ops };
}
