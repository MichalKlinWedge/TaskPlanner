/**
 * Kanban (SPECYFIKACJA M10): kolumny według statusu, priorytetu, dnia bieżącego tygodnia, tagu,
 * listy albo własnych kolumn listy (`lists.board_columns`, v1.x); kolejność kart z `board_sort_key` (D15 — wspólna dla kart z wielu list; bez klucza —
 * automatycznie: priorytet, termin) i operacje przeciągnięcia karty (zmiana atrybutu kolumny +
 * miejsce w kolumnie). Web i telefon (uproszczony) liczą to samo.
 */
import { addDays, weekStart } from './dates.ts';
import { dayChip } from './format.ts';
import { PRIORITY, TASK_STATUS, TASK_STATUS_HINT, VIEW_SECTION } from './labels.ts';
import { taskTagId, uuidv7 } from './ids.ts';
import { reschedulePatch } from './review.ts';
import { BoardColumns, type BoardColumnDef } from './schemas/model.ts';
import type { LocalDate, Priority, TaskStatus } from './schemas/primitives.ts';
import { keyBetween } from './sort-key.ts';
import { completeTaskOps, datesPatch, moveTaskOps, reopenTaskPatch, type TaskOp } from './tasks.ts';
import type { ViewTask } from './views.ts';

export type BoardBy = 'status' | 'priority' | 'weekday' | 'tag' | 'list' | 'custom';

export const BOARD_BY: Record<BoardBy, string> = {
  status: 'Status',
  priority: 'Priorytet',
  weekday: 'Dzień tygodnia',
  tag: 'Tag',
  list: 'Lista',
  custom: 'Własne',
};

/** Pierwsza kolumna trybu „Własne”: zadania bez kolumny albo z kolumną spoza listy. */
export const BOARD_UNASSIGNED = 'Do przypisania';

/** Kolumna zadań z terminem przed pierwszym dniem tablicy (`BoardOptions.outside`). */
export const BOARD_BEFORE = 'Wcześniej';

/** Kolumny statusu (anulowane nie są na tablicy). */
export const BOARD_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'waiting', 'done'];
/** „Gotowe” starsze niż tyle dni są ukryte (M10). */
export const BOARD_DONE_DAYS = 7;

export interface BoardColumn {
  /** Wartość kolumny: status, priorytet, data, id tagu / listy / własnej kolumny albo `none`. */
  key: string;
  label: string;
  /** Opis wartości kolumny (dymek) — przy kolumnach statusów. */
  hint?: string;
  /** Kolumna tylko do pokazania (dni poza zakresem): nie przyjmuje kart z innych kolumn ani nowych zadań. */
  fixed?: true;
  tasks: ViewTask[];
}

export interface BoardLookup {
  lists?: readonly { id: string; name: string; sortKey: string }[];
  tags?: readonly { id: string; name: string; sortKey: string }[];
  /** Własne kolumny listy tablicy (tryb `custom`). */
  columns?: readonly BoardColumnDef[];
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

/** Dodatki tablicy widoku zbiorczego (`smartBoard`). */
export interface BoardOptions {
  /** Karty także z podzadań (zadania wybiera termin, nie drzewo). */
  subtasks?: boolean;
  /** Kolumny dni od `from` zamiast bieżącego tygodnia. */
  days?: { from: LocalDate; count: number };
  /** Zadania z terminem spoza kolumn dni: kolumny „Wcześniej” / „Później” zamiast pominięcia, bez „Bez terminu”. */
  outside?: boolean;
}

/**
 * Kolumny tablicy z zadań-kandydatów (już zawężonych do listy / przestrzeni / filtra). Karty to
 * zadania główne (podzadania liczą się do postępu karty). Poza kolumną statusu — tylko otwarte;
 * „Gotowe” — z ostatnich 7 dni. Dzień tygodnia: „Bez terminu” + bieżący tydzień od `firstDayOfWeek`.
 * Kolumna bez wartości (`none`: bez terminu / bez tagu / do przypisania) jest zawsze pierwsza.
 */
export function boardColumns(
  tasks: readonly ViewTask[],
  by: BoardBy,
  { today, firstDayOfWeek = 1, completedSince, subtasks = false, days, outside = false }: { today: LocalDate; firstDayOfWeek?: number; completedSince?: string } & BoardOptions,
  lookup: BoardLookup = {},
): BoardColumn[] {
  const since = completedSince ?? `${addDays(today, -BOARD_DONE_DAYS)}T00:00:00Z`;
  const open = (t: ViewTask) => t.status !== 'done' && t.status !== 'cancelled';
  const cards = tasks.filter((t) => t.kind === 'task' && (subtasks || t.parentId === null) && t.status !== 'cancelled' && (open(t) || (by === 'status' && (t.completedAt ?? '') >= since)));
  const columns = new Map<string, BoardColumn>();
  const column = (key: string, label: string) => {
    if (!columns.has(key)) columns.set(key, { key, label, tasks: [] });
    return columns.get(key)!;
  };

  if (by === 'status') {
    for (const s of BOARD_STATUSES) column(s, TASK_STATUS[s]).hint = TASK_STATUS_HINT[s];
    for (const t of cards) columns.get(t.status)?.tasks.push(t);
  } else if (by === 'priority') {
    for (const p of [1, 2, 3, 4] as Priority[]) column(String(p), PRIORITY[p].label);
    for (const t of cards) columns.get(String(t.priority))!.tasks.push(t);
  } else if (by === 'weekday') {
    // Widoki wybierane terminem nie mają zadań bez terminu.
    if (!outside) column('none', VIEW_SECTION.noDate);
    const start = days?.from ?? weekStart(today, firstDayOfWeek);
    const count = days?.count ?? 7;
    const end = addDays(start, count - 1);
    if (outside && cards.some((t) => t.dueDate && t.dueDate < start)) column('before', BOARD_BEFORE).fixed = true;
    for (let i = 0; i < count; i++) {
      const d = addDays(start, i);
      column(d, `${dayChip(d)}${d === today ? ' · dziś' : ''}`);
    }
    if (outside && cards.some((t) => t.dueDate && t.dueDate > end)) column('after', VIEW_SECTION.later).fixed = true;
    for (const t of cards) columns.get(!t.dueDate ? 'none' : t.dueDate < start ? 'before' : t.dueDate > end ? 'after' : t.dueDate)?.tasks.push(t);
  } else if (by === 'tag') {
    column('none', VIEW_SECTION.noTag);
    for (const tag of [...(lookup.tags ?? [])].sort((a, b) => byText(a.sortKey, b.sortKey))) column(tag.id, tag.name);
    for (const t of cards) for (const id of t.tagIds.length ? t.tagIds : ['none']) columns.get(id)?.tasks.push(t);
  } else if (by === 'custom') {
    column('none', BOARD_UNASSIGNED);
    for (const c of lookup.columns ?? []) column(c.id, c.name);
    for (const t of cards) ((t.boardColumnId ? columns.get(t.boardColumnId) : undefined) ?? columns.get('none')!).tasks.push(t);
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
 * ponowne otwarcie jak przy odhaczeniu, priorytet, termin z zachowaniem godziny, tag, lista, własna
 * kolumna) i klucz
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

  // Kolumna tylko do pokazania („Wcześniej” / „Później”) nie ma wartości do ustawienia.
  if (by === 'weekday' && fromKey !== toKey && (toKey === 'before' || toKey === 'after')) return { ops, undo };

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
    } else if (by === 'custom') set('board_column_id', toKey === 'none' ? null : toKey, task.boardColumnId ?? null);
    else {
      const moves = moveTaskOps(all, task.id, toKey);
      ops.push(...moves);
      undo.push(...moves.map((m): TaskOp => ({ table: 'tasks', id: m.id, patch: m.id === task.id && task.parentId ? { list_id: task.listId, parent_id: task.parentId } : { list_id: task.listId } })));
    }
  }

  const { draggedKey, ops: neighbours } = boardKeyOps(targetColumn, task.id, index);
  set('board_sort_key', draggedKey, task.boardSortKey ?? null);
  ops.push(...neighbours, { table: 'tasks', id: task.id, patch });
  undo.push({ table: 'tasks', id: task.id, patch: before });
  return { ops, undo };
}

// ── Własne kolumny listy ────────────────────────────────────────────────────────────────────────

/** Własne kolumny z `lists.board_columns` (tekst JSON z lokalnej bazy albo tablica); uszkodzone → `[]`. */
export function boardColumnDefs(raw: unknown): BoardColumnDef[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const parsed = BoardColumns.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

const columnsOp = (listId: string, next: readonly BoardColumnDef[]): TaskOp => ({
  table: 'lists',
  id: listId,
  patch: { board_columns: next.length ? next.map((c) => ({ id: c.id, name: c.name })) : null },
});

function columnName(name: string): string {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) throw new Error('Nazwa kolumny nie może być pusta.');
  return trimmed;
}

/** Nowa kolumna na końcu tablicy listy. */
export function addBoardColumnOps(listId: string, current: readonly BoardColumnDef[], name: string, newId: () => string = uuidv7): { ops: TaskOp[]; id: string } {
  if (current.length >= 50) throw new Error('Tablica może mieć najwyżej 50 kolumn.');
  const id = newId();
  return { ops: [columnsOp(listId, [...current, { id, name: columnName(name) }])], id };
}

/** Zmiana nazwy kolumny; ta sama nazwa / nieznane id — brak operacji. */
export function renameBoardColumnOps(listId: string, current: readonly BoardColumnDef[], id: string, name: string): TaskOp[] {
  const next = columnName(name);
  if (!current.some((c) => c.id === id && c.name !== next)) return [];
  return [columnsOp(listId, current.map((c) => (c.id === id ? { ...c, name: next } : c)))];
}

/** Przeniesienie kolumny na pozycję `index` (licząc bez niej); to samo miejsce / nieznane id — brak operacji. */
export function moveBoardColumnOps(listId: string, current: readonly BoardColumnDef[], id: string, index: number): TaskOp[] {
  const from = current.findIndex((c) => c.id === id);
  if (from < 0) return [];
  const rest = current.filter((c) => c.id !== id);
  const to = Math.max(0, Math.min(index, rest.length));
  if (to === from) return [];
  return [columnsOp(listId, [...rest.slice(0, to), current[from]!, ...rest.slice(to)])];
}

/**
 * Usunięcie kolumny: jej zadania wracają do „Do przypisania” (`board_column_id = null`). Z `undo` —
 * kolumna na tym samym miejscu i przypisania zadań.
 */
export function removeBoardColumnOps(
  listId: string,
  current: readonly BoardColumnDef[],
  id: string,
  tasks: readonly Pick<ViewTask, 'id' | 'boardColumnId'>[],
): { ops: TaskOp[]; undo: TaskOp[] } {
  if (!current.some((c) => c.id === id)) return { ops: [], undo: [] };
  const assigned = tasks.filter((t) => t.boardColumnId === id);
  return {
    ops: [columnsOp(listId, current.filter((c) => c.id !== id)), ...assigned.map((t): TaskOp => ({ table: 'tasks', id: t.id, patch: { board_column_id: null } }))],
    undo: [columnsOp(listId, current), ...assigned.map((t): TaskOp => ({ table: 'tasks', id: t.id, patch: { board_column_id: id } }))],
  };
}

/** Kolumna zadania na liście — id z `columns` albo `null` („Do przypisania”). */
export const taskBoardColumn = (task: Pick<ViewTask, 'boardColumnId'>, columns: readonly BoardColumnDef[]): string | null =>
  task.boardColumnId && columns.some((c) => c.id === task.boardColumnId) ? task.boardColumnId : null;
