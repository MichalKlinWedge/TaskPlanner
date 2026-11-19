/**
 * Kanban (SPECYFIKACJA M10): kolumny według statusu, priorytetu, dnia bieżącego tygodnia, tagu albo
 * listy; kolejność kart z `board_sort_key` (D15 — wspólna dla kart z wielu list; bez klucza —
 * automatycznie: priorytet, termin) i operacje przeciągnięcia karty (zmiana atrybutu kolumny +
 * miejsce w kolumnie). Web i telefon (uproszczony) liczą to samo.
 */
import { addDays, weekStart } from './dates.ts';
import { dayChip } from './format.ts';
import { PRIORITY, TASK_STATUS, VIEW_SECTION } from './labels.ts';
import { taskTagId } from './ids.ts';
import { reschedulePatch } from './review.ts';
import type { LocalDate, Priority, TaskStatus } from './schemas/primitives.ts';
import { keyBetween } from './sort-key.ts';
import { completeTaskOps, datesPatch, moveTaskOps, reopenTaskPatch, type TaskOp } from './tasks.ts';
import type { ViewTask } from './views.ts';

export type BoardBy = 'status' | 'priority' | 'weekday' | 'tag' | 'list';

export const BOARD_BY: Record<BoardBy, string> = {
  status: 'Status',
  priority: 'Priorytet',
  weekday: 'Dzień tygodnia',
  tag: 'Tag',
  list: 'Lista',
};

/** Kolumny statusu (anulowane nie są na tablicy). */
export const BOARD_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'waiting', 'done'];
/** „Gotowe” starsze niż tyle dni są ukryte (M10). */
export const BOARD_DONE_DAYS = 7;

export interface BoardColumn {
  /** Wartość kolumny: status, priorytet, data, id tagu / listy albo `none`. */
  key: string;
  label: string;
  tasks: ViewTask[];
}

export interface BoardLookup {
  lists?: readonly { id: string; name: string; sortKey: string }[];
  tags?: readonly { id: string; name: string; sortKey: string }[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Kolejność kart: najpierw z kluczem tablicy, potem bez — priorytet, termin (brak na końcu), kolejność listy. */
export function boardOrder(a: ViewTask, b: ViewTask): number {
  const ka = a.boardSortKey ?? null;
  const kb = b.boardSortKey ?? null;
  if (ka && kb) return byText(ka, kb) || byText(a.id, b.id);
  if (ka || kb) return ka ? -1 : 1;
  return a.priority - b.priority || (a.dueDate === b.dueDate ? 0 : a.dueDate === null ? 1 : b.dueDate === null ? -1 : byText(a.dueDate, b.dueDate)) || byText(a.sortKey, b.sortKey) || byText(a.id, b.id);
}

/**
 * Kolumny tablicy z zadań-kandydatów (już zawężonych do listy / przestrzeni / filtra). Karty to
 * zadania główne (podzadania liczą się do postępu karty). Poza kolumną statusu — tylko otwarte;
 * „Gotowe” — z ostatnich 7 dni. Dzień tygodnia: bieżący tydzień od `firstDayOfWeek` + „Bez terminu”.
 */
export function boardColumns(
  tasks: readonly ViewTask[],
  by: BoardBy,
  { today, firstDayOfWeek = 1, completedSince }: { today: LocalDate; firstDayOfWeek?: number; completedSince?: string },
  lookup: BoardLookup = {},
): BoardColumn[] {
  const since = completedSince ?? `${addDays(today, -BOARD_DONE_DAYS)}T00:00:00Z`;
  const open = (t: ViewTask) => t.status !== 'done' && t.status !== 'cancelled';
  const cards = tasks.filter((t) => t.kind === 'task' && t.parentId === null && t.status !== 'cancelled' && (open(t) || (by === 'status' && (t.completedAt ?? '') >= since)));
  const columns = new Map<string, BoardColumn>();
  const column = (key: string, label: string) => {
    if (!columns.has(key)) columns.set(key, { key, label, tasks: [] });
    return columns.get(key)!;
  };

  if (by === 'status') {
    for (const s of BOARD_STATUSES) column(s, TASK_STATUS[s]);
    for (const t of cards) columns.get(t.status)?.tasks.push(t);
  } else if (by === 'priority') {
    for (const p of [1, 2, 3, 4] as Priority[]) column(String(p), PRIORITY[p].label);
    for (const t of cards) columns.get(String(t.priority))!.tasks.push(t);
  } else if (by === 'weekday') {
    const start = weekStart(today, firstDayOfWeek);
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      column(d, `${dayChip(d)}${d === today ? ' · dziś' : ''}`);
    }
    column('none', VIEW_SECTION.noDate);
    for (const t of cards) (t.dueDate ? columns.get(t.dueDate) : columns.get('none'))?.tasks.push(t);
  } else if (by === 'tag') {
    for (const tag of [...(lookup.tags ?? [])].sort((a, b) => byText(a.sortKey, b.sortKey))) column(tag.id, tag.name);
    column('none', VIEW_SECTION.noTag);
    for (const t of cards) for (const id of t.tagIds.length ? t.tagIds : ['none']) columns.get(id)?.tasks.push(t);
  } else {
    for (const l of [...(lookup.lists ?? [])].sort((a, b) => byText(a.sortKey, b.sortKey))) column(l.id, l.name);
    for (const t of cards) columns.get(t.listId)?.tasks.push(t);
  }
  for (const c of columns.values()) c.tasks.sort(boardOrder);
  return [...columns.values()];
}

/**
 * Klucze tablicy dla karty wstawionej na pozycję `index` kolumny (po usunięciu jej ze starego miejsca).
 * Karty bez klucza przed miejscem dostają klucze po kolei (zostają przed upuszczoną) — zwykle jedna
 * zmiana, przy upuszczeniu między karty „automatyczne” kilka.
 */
function boardKeyOps(column: readonly ViewTask[], draggedId: string, index: number): { draggedKey: string; ops: TaskOp[] } {
  const rest = column.filter((t) => t.id !== draggedId);
  const before = rest.slice(0, index);
  const next = rest[index];
  const ops: TaskOp[] = [];
  let prev: string | undefined;
  for (const t of before) {
    if (t.boardSortKey) prev = t.boardSortKey;
    else {
      prev = keyBetween(prev);
      ops.push({ table: 'tasks', id: t.id, patch: { board_sort_key: prev } });
    }
  }
  const upper = next?.boardSortKey && (!prev || next.boardSortKey > prev) ? next.boardSortKey : undefined;
  return { draggedKey: keyBetween(prev, upper), ops };
}

/**
 * Przeciągnięcie karty do kolumny `toKey` na pozycję `index`: atrybut kolumny (status — ukończenie /
 * ponowne otwarcie jak przy odhaczeniu, priorytet, termin z zachowaniem godziny, tag, lista) i klucz
 * kolejności. Z `undo` — przywrócenie (bez kluczy kolejności sąsiadów).
 */
export function boardDropOps(
  task: ViewTask,
  all: readonly ViewTask[],
  by: BoardBy,
  fromKey: string,
  toKey: string,
  targetColumn: readonly ViewTask[],
  index: number,
  { today, now, timeZone }: { today: LocalDate; now: Date | string; timeZone?: string },
): { ops: TaskOp[]; undo: TaskOp[] } {
  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const set = (field: string, value: unknown, previous: unknown) => {
    patch[field] = value;
    before[field] = previous;
  };

  if (fromKey !== toKey) {
    if (by === 'status') {
      const to = toKey as TaskStatus;
      if (to === 'done') {
        const result = completeTaskOps(task, { now, timeZone });
        ops.push(...result.ops);
        undo.push(...result.undo);
      } else if (task.status === 'done') {
        Object.assign(patch, reopenTaskPatch(), { status: to });
        Object.assign(before, { status: task.status, completed_at: task.completedAt });
      } else set('status', to, task.status);
    } else if (by === 'priority') set('priority', Number(toKey), task.priority);
    else if (by === 'weekday') {
      if (toKey === 'none') {
        const p = datesPatch(task, { due_date: null });
        for (const [f, v] of Object.entries(p)) set(f, v, f === 'start_date' ? task.startDate : f === 'due_time' ? task.dueTime : task.dueDate);
      } else {
        const p = reschedulePatch(task, { kind: 'date', date: toKey as LocalDate }, { today });
        if (p) {
          set('due_date', p.dueDate, task.dueDate);
          if (p.startDate !== undefined) set('start_date', p.startDate, task.startDate);
          if (p.postponeCount !== undefined) set('postpone_count', p.postponeCount, task.postponeCount);
        }
      }
    } else if (by === 'tag') {
      const at = new Date(now).toISOString();
      if (fromKey !== 'none') {
        ops.push({ table: 'task_tags', id: taskTagId(task.id, fromKey), patch: { deleted_at: at } });
        undo.push({ table: 'task_tags', id: taskTagId(task.id, fromKey), patch: { task_id: task.id, tag_id: fromKey, deleted_at: null } });
      }
      if (toKey !== 'none') {
        ops.push({ table: 'task_tags', id: taskTagId(task.id, toKey), patch: { task_id: task.id, tag_id: toKey, deleted_at: null } });
        undo.push({ table: 'task_tags', id: taskTagId(task.id, toKey), patch: { deleted_at: at } });
      }
    } else {
      const moves = moveTaskOps(all, task.id, toKey);
      ops.push(...moves);
      undo.push(...moves.map((m): TaskOp => ({ table: 'tasks', id: m.id, patch: { list_id: task.listId } })));
    }
  }

  const { draggedKey, ops: neighbours } = boardKeyOps(targetColumn, task.id, index);
  set('board_sort_key', draggedKey, task.boardSortKey ?? null);
  ops.push(...neighbours, { table: 'tasks', id: task.id, patch });
  undo.push({ table: 'tasks', id: task.id, patch: before });
  return { ops, undo };
}
