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
import { reschedulePatch } from './review.ts';
import { compareText } from './format.ts';
import { keyBetween, renumber } from './sort-key.ts';
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
  board_sort_key?: string | null;
  postpone_count: number | null;
  assignee_id?: string | null;
  board_column_id?: string | null;
  canvas_pos?: unknown;
  derived_from?: unknown;
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

/** `canvas_pos` z lokalnego wiersza (tekst JSON albo obiekt) → komórka; brak / zły zapis → `null` (bez Zod — gorąca ścieżka). */
export function canvasPosOf(raw: unknown): { col: number; row: number } | null {
  if (raw === null || raw === undefined) return null;
  const value = json(raw) as { col?: unknown; row?: unknown } | null;
  return value && Number.isInteger(value.col) && Number.isInteger(value.row) ? { col: value.col as number, row: value.row as number } : null;
}

/** `derived_from` z lokalnego wiersza (tekst JSON albo tablica) → id źródeł; brak / zły zapis / pusta → `null` (bez Zod — gorąca ścieżka). */
export function derivedFromOf(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  const value = json(raw);
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === 'string');
  return ids.length ? ids : null;
}

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
  // Puste pola bez Zod: nieudany `safeParse(null)` buduje błąd — przy 10 000 zadań ~30 ms na odświeżenie widoków.
  const recurrence = row.recurrence === null || row.recurrence === undefined ? null : Recurrence.safeParse(json(row.recurrence));
  const habit = row.habit === null || row.habit === undefined ? null : HabitSettings.safeParse(json(row.habit));
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
    recurrence: recurrence?.success ? recurrence.data : null,
    habit: habit?.success ? habit.data : null,
    completedAt: row.completed_at,
    // Wiersz utworzony offline nie ma jeszcze `created_at` z serwera.
    createdAt: row.created_at ?? new Date(0).toISOString(),
    sortKey: row.sort_key,
    boardSortKey: row.board_sort_key ?? null,
    tagIds,
    postponeCount: Number(row.postpone_count ?? 0),
    statusChangedAt: fieldChangedAt(row.field_clock, 'status'),
    assigneeId: row.assignee_id ?? null,
    boardColumnId: row.board_column_id ?? null,
    canvasPos: canvasPosOf(row.canvas_pos),
    derivedFrom: derivedFromOf(row.derived_from),
  };
}

export interface TaskOp {
  table:
    | 'tasks' | 'task_completions' | 'tags' | 'task_tags' | 'reminders' | 'saved_filters' | 'task_dependencies' | 'lists' | 'time_entries' | 'profiles'
    | 'review_sessions' | 'attachments' | 'collaborators' | 'task_participants' | 'task_comments' | 'workspaces' | 'plugin_rules' | 'plugin_requests'
    | 'project_templates';
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

/** Podzadanie serii — przy następnym wystąpieniu wraca do „Do zrobienia” (M7). */
export type SeriesSubtask = Pick<ViewTask, 'id' | 'status' | 'completedAt'>;

export interface CompleteOptions {
  now: Date | string;
  timeZone?: string;
  /** Podzadania serii (`descendants`): zamknięte wracają do „Do zrobienia”, gdy seria idzie dalej. */
  subtasks?: readonly SeriesSubtask[];
}

/**
 * Ukończenie zadania w chwili `now`. Zwykłe zadanie → `done`. Seria → wpis w `task_completions`
 * (id deterministyczne: dwa urządzenia ukończą to samo wystąpienie jednym wierszem) i termin
 * przesunięty na `nextDue` razem z początkiem zakresu; licznik przesunięć się zeruje, bo to nowe
 * wystąpienie, a podzadania wracają do „Do zrobienia”. Koniec serii (`COUNT`/`UNTIL`) zamyka
 * zadanie. Nawyk → tylko wpis na dziś.
 */
export function completeTaskOps(task: CompletableTask, options: CompleteOptions): CompleteResult {
  return advanceSeries(task, options, 'done');
}

/**
 * „Pomiń to wystąpienie” (M7): wpis `skipped` w `task_completions` i termin na następne
 * wystąpienie — jak ukończenie, ale bez zaliczenia. Ostatnie wystąpienie zamyka serię jako
 * anulowaną. Zadanie bez cyklu nie ma czego pomijać (pusty wynik).
 */
export function skipOccurrenceOps(task: CompletableTask, options: CompleteOptions): CompleteResult {
  if (!task.recurrence || task.kind !== 'task') return { ops: [], undo: [], nextDue: null };
  return advanceSeries(task, options, 'skipped');
}

/**
 * „Zakończ serię” (M7): seria zamyka się jako anulowana bez zaliczenia bieżącego wystąpienia;
 * reguła zostaje w wierszu (historia, ponowne otwarcie). Samo „przestań powtarzać” to
 * `recurrence: null` w panelu zadania.
 */
export function endSeriesOps(task: CompletableTask, now: Date | string): CompleteResult {
  if (!task.recurrence) return { ops: [], undo: [], nextDue: null };
  return {
    ops: [{ table: 'tasks', id: task.id, patch: { status: 'cancelled', completed_at: new Date(now).toISOString() } }],
    undo: [{ table: 'tasks', id: task.id, patch: { status: task.status, completed_at: task.completedAt } }],
    nextDue: null,
  };
}

function advanceSeries(task: CompletableTask, { now, timeZone, subtasks = [] }: CompleteOptions, kind: 'done' | 'skipped'): CompleteResult {
  const at = new Date(now).toISOString();
  const today = localDateAt(at, timeZone);
  const completion = (date: LocalDate): TaskOp => ({
    table: 'task_completions',
    id: completionId(task.id, date),
    patch: { task_id: task.id, occurrence_date: date, kind, value: null, completed_at: at, deleted_at: null },
  });
  const removed = (op: TaskOp): TaskOp => ({ table: op.table, id: op.id, patch: { deleted_at: at } });
  const close: TaskOp = { table: 'tasks', id: task.id, patch: { status: kind === 'done' ? 'done' : 'cancelled', completed_at: at } };
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
  const reset = subtasks.filter((s) => s.status !== 'todo');
  return {
    ops: [
      done,
      { table: 'tasks', id: task.id, patch: { due_date: next, start_date: task.startDate ? addDays(task.startDate, shift) : null, postpone_count: 0 } },
      ...reset.map((s): TaskOp => ({ table: 'tasks', id: s.id, patch: { status: 'todo', completed_at: null } })),
    ],
    undo: [
      removed(done),
      { table: 'tasks', id: task.id, patch: { due_date: task.dueDate, start_date: task.startDate, postpone_count: task.postponeCount } },
      ...reset.map((s): TaskOp => ({ table: 'tasks', id: s.id, patch: { status: s.status, completed_at: s.completedAt } })),
    ],
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
  /** Tagi do dopasowania po nazwie; `shared` (kopie z przestrzeni) — tylko w przestrzeni z `workspaceIds`. */
  tags: readonly { id: string; name: string; sortKey: string; shared?: boolean; workspaceIds?: readonly string[] | null }[];
  /** Lista, gdy wpis nie wskazuje innej (Inbox bieżącej przestrzeni albo lista, z której wywołano). */
  defaultListId: string;
  /** Termin, gdy wpis go nie podaje (np. „Dziś”, dzień w „Nadchodzących”). */
  defaultDueDate?: string | null;
  /** Ostatni klucz kolejności wśród rodzeństwa (id listy — zadania główne, id rodzica — podzadania). */
  lastSortKey: (listOrParentId: string) => string | undefined;
  /** Generator id (testy); domyślnie UUIDv7. */
  newId?: () => string;
  /** Podzadanie: lista rodzica, wskazanie listy we wpisie jest pomijane. */
  parent?: { id: string; listId: string };
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

  let listId = scope.parent?.listId ?? scope.defaultListId;
  const target = scope.parent ? undefined : fields.target;
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
      parent_id: scope.parent?.id ?? null,
      kind: 'task',
      title: title.slice(0, 500),
      status: 'todo',
      priority: fields.priority ?? 4,
      due_date: dueDate,
      due_time: dueDate ? (fields.dueTime ?? null) : null,
      duration_min: fields.durationMin ?? null,
      recurrence: fields.recurrence ?? null,
      sort_key: keyBetween(scope.lastSortKey(scope.parent?.id ?? listId)),
      source: { kind: 'quick_add', text: text.slice(0, 1000) },
      postpone_count: 0,
    },
  });

  ops.push(...taskTagOps(scope, taskId, fields.tags ?? [], scope.lists.find((l) => l.id === listId)?.workspaceId));

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

/**
 * Tagi zadania po nazwach: istniejący tag (bez wielkości liter i polskich znaków) albo nowy
 * z id deterministycznym z nazwy (dwa urządzenia tworzą ten sam tag jednym wierszem).
 * `workspaceId` — przestrzeń zadania: nowy tag jest widoczny tylko w niej (`tags.workspace_ids`);
 * istniejącego tagu nie zmienia. Bez własnego tagu o tej nazwie — tag innego członka z kopii
 * w tej przestrzeni (`shared`, `withSharedTags`), żeby przestrzeń miała jeden tag na nazwę.
 */
export function taskTagOps(scope: Pick<QuickAddScope, 'userId' | 'tags'>, taskId: string, names: readonly string[], workspaceId?: string | null): TaskOp[] {
  const ops: TaskOp[] = [];
  const own = scope.tags.filter((t) => !t.shared);
  let lastTagKey = own.reduce<string | undefined>((max, t) => (!max || t.sortKey > max ? t.sortKey : max), undefined);
  for (const name of new Set(names.map((n) => n.trim()).filter(Boolean))) {
    let id =
      own.find((t) => same(t.name, name))?.id ??
      (workspaceId ? scope.tags.find((t) => t.shared && t.workspaceIds?.includes(workspaceId) && same(t.name, name))?.id : undefined);
    if (!id) {
      id = tagId(scope.userId, name);
      lastTagKey = keyBetween(lastTagKey);
      ops.push({ table: 'tags', id, patch: { name: name.slice(0, 60), color: null, sort_key: lastTagKey, workspace_ids: workspaceId ? [workspaceId] : null } });
    }
    ops.push({ table: 'task_tags', id: taskTagId(taskId, id), patch: { task_id: taskId, tag_id: id, deleted_at: null } });
  }
  return ops;
}

/**
 * Zmiana kolejności tagów zadania (`task_tags.sort_key`, przeciąganie w panelu zadania): tag z pozycji
 * `from` na `to`. Klucze dostają wszystkie tagi zadania (zwykle kilka) — tagi bez klucza (`null` =
 * kolejność dodania) i tak trzeba by ułożyć względem siebie. Pierwszy kolorowy tag = kolor karteczki.
 */
export function reorderTaskTagOps(taskId: string, tagIds: readonly string[], from: number, to: number): TaskOp[] {
  if (from === to || from < 0 || to < 0 || from >= tagIds.length || to >= tagIds.length) return [];
  const order = [...tagIds];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  const keys = renumber(order.length);
  // `task_id` / `tag_id` z tymi samymi wartościami: łatka sama w sobie jest poprawnym wierszem.
  return order.map((tag, i) => ({ table: 'task_tags', id: taskTagId(taskId, tag), patch: { task_id: taskId, tag_id: tag, sort_key: keys[i]! } }));
}

// ── Widoczność tagów w przestrzeniach (`tags.workspace_ids`) ─────────────────────────────────

/**
 * Tag widoczny w przestrzeni: bez przypisania (`null` / `[]`) — wszędzie; widok „Wszystkie
 * przestrzenie” (`workspaceId` = `null`) — każdy tag. Tylko filtr widoku: tag nadal jest jeden na nazwę.
 */
export function tagVisibleIn(tag: { workspaceIds: readonly string[] | null }, workspaceId: string | null): boolean {
  return !workspaceId || !tag.workspaceIds?.length || tag.workspaceIds.includes(workspaceId);
}

/**
 * Tagi do pokazania w przestrzeni (pasek boczny, chipy filtra, podpowiedzi, kolumny tablicy);
 * `keep` — ukryte, ale już przypięte do zadania albo zaznaczone w filtrze (nie mogą zniknąć).
 */
export function tagsForWorkspace<T extends { id: string; workspaceIds: readonly string[] | null }>(tags: readonly T[], workspaceId: string | null, keep: Iterable<string> = []): T[] {
  const kept = new Set(keep);
  return tags.filter((t) => kept.has(t.id) || tagVisibleIn(t, workspaceId));
}

/** `workspace_ids` z lokalnego wiersza (tekst JSON albo tablica) → lista id; brak / błąd / pusta = `null`. */
export function tagWorkspaceIds(raw: unknown): string[] | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return ids.length ? ids : null;
}

/** Patch przypisania tagu do przestrzeni; pusta lista = wszystkie (`null`). */
export const tagWorkspacesPatch = (ids: readonly string[]): { workspace_ids: string[] | null } => ({ workspace_ids: ids.length ? [...new Set(ids)] : null });

// ── Tagi innych członków przestrzeni (`scope_tags`) ──────────────────────────────────────────

/** Wiersz `scope_tags` (kopia tagu w przestrzeni). */
export interface ScopeTag {
  scopeId: string;
  tagId: string;
  name: string;
  color: string | null;
}

/** Lokalny wiersz `scope_tags` → `ScopeTag`. */
export const scopeTag = (row: Record<string, unknown>): ScopeTag => ({
  scopeId: String(row.scope_id),
  tagId: String(row.tag_id),
  name: String(row.name),
  color: (row.color as string | null) ?? null,
});

/** Tag do widoków: własny albo cudzy z kopii (`shared` — tylko do przypinania, bez edycji). */
export interface SharedTagFields {
  id: string;
  name: string;
  color: string | null;
  sortKey: string;
  workspaceIds: string[] | null;
  shared?: boolean;
}

/**
 * Własne tagi i tagi innych członków z kopii w przestrzeniach (`shared`, jeden na tag, `workspaceIds`
 * = przestrzenie z kopią, więc pokazują się tylko tam). Własny wygrywa z kopią; cudze na końcu,
 * alfabetycznie (`sortKey` spoza kluczy kolejności — nigdy nie trafia do zapisu).
 */
export function withSharedTags<T extends SharedTagFields>(own: readonly T[], copies: readonly ScopeTag[]): (T | SharedTagFields)[] {
  const known = new Set(own.map((t) => t.id));
  const shared = new Map<string, SharedTagFields & { workspaceIds: string[] }>();
  for (const copy of copies) {
    if (known.has(copy.tagId)) continue;
    const entry = shared.get(copy.tagId);
    if (entry) entry.workspaceIds.push(copy.scopeId);
    else shared.set(copy.tagId, { id: copy.tagId, name: copy.name, color: copy.color, sortKey: `~${copy.name.toLocaleLowerCase('pl')}`, workspaceIds: [copy.scopeId], shared: true });
  }
  return [...own, ...[...shared.values()].sort((a, b) => compareText(a.name, b.name))];
}

// ── Podzadania, przenoszenie, kosz ───────────────────────────────────────────────────────────

/** Najwięcej poziomów: zadanie + 3 poziomy podzadań (M3; trigger odrzuca głębsze — `TP001`). */
export const MAX_TASK_DEPTH = 4;
/** Ile dni usunięte zadanie leży w koszu (potem serwer usuwa je trwale, §6). */
export const TRASH_DAYS = 30;

type TreeTask = Pick<ViewTask, 'id' | 'parentId'>;

/** Wszystkie podzadania (każdego poziomu), w kolejności przeszukiwania wszerz. */
export function descendants<T extends TreeTask>(tasks: readonly T[], id: string): T[] {
  const children = new Map<string, T[]>();
  for (const t of tasks) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  const out: T[] = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** Poziom zadania: 1 = zadanie główne. */
export function taskDepth(tasks: readonly TreeTask[], id: string): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let depth = 1;
  for (let t = byId.get(id); t?.parentId && depth <= MAX_TASK_DEPTH * 4; t = byId.get(t.parentId)) depth++;
  return depth;
}

/** Czy pod `parentId` można dodać nowe podzadanie (bez przekroczenia 4 poziomów). */
export const canAddSubtask = (tasks: readonly TreeTask[], parentId: string): boolean => taskDepth(tasks, parentId) < MAX_TASK_DEPTH;

type SubtaskTask = TreeTask & Pick<ViewTask, 'listId' | 'sortKey' | 'kind' | 'status'>;

/**
 * Otwarte zadania z listy rodzica, które można podpiąć pod `parentId` jako podzadania (z ich
 * poddrzewem): bez samego rodzica i jego przodków (cykl), bez obecnych bezpośrednich podzadań,
 * bez przekroczenia 4 poziomów.
 */
export function subtaskCandidates<T extends SubtaskTask>(tasks: readonly T[], parentId: string): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const parent = byId.get(parentId);
  if (!parent) return [];
  const room = MAX_TASK_DEPTH - taskDepth(tasks, parentId);
  if (room < 1) return [];
  const banned = new Set<string>();
  for (let t: T | undefined = parent; t && !banned.has(t.id); t = t.parentId ? byId.get(t.parentId) : undefined) banned.add(t.id);
  const children = new Map<string, string[]>();
  for (const t of tasks) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t.id]);
  const heights = new Map<string, number>();
  const height = (id: string, seen = new Set<string>()): number => {
    const known = heights.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return Infinity;
    seen.add(id);
    const h = 1 + Math.max(0, ...(children.get(id) ?? []).map((c) => height(c, seen)));
    heights.set(id, h);
    return h;
  };
  return tasks.filter((t) => t.listId === parent.listId && t.kind === 'task' && t.status !== 'done' && t.status !== 'cancelled' && t.parentId !== parentId && !banned.has(t.id) && height(t.id) <= room);
}

/**
 * Podpięcie istniejącego zadania (z jego podzadaniami) pod `parentId` — na koniec podzadań, z
 * cofnięciem. `null`, gdy się nie da (`subtaskCandidates`).
 */
export function attachSubtaskOps(tasks: readonly SubtaskTask[], parentId: string, childId: string): { ops: TaskOp[]; undo: TaskOp[] } | null {
  const child = subtaskCandidates(tasks, parentId).find((t) => t.id === childId);
  if (!child) return null;
  const last = tasks
    .filter((t) => t.parentId === parentId)
    .map((t) => t.sortKey)
    .sort()
    .at(-1);
  return {
    ops: [{ table: 'tasks', id: childId, patch: { parent_id: parentId, sort_key: keyBetween(last) } }],
    undo: [{ table: 'tasks', id: childId, patch: { parent_id: child.parentId, sort_key: child.sortKey } }],
  };
}

/**
 * Otwarte zadania z listy `childId`, pod które można je przepiąć (z poddrzewem): bez niego samego i
 * jego podzadań (cykl), bez obecnego rodzica, bez przekroczenia 4 poziomów.
 */
export function parentCandidates<T extends SubtaskTask>(tasks: readonly T[], childId: string): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const child = byId.get(childId);
  if (!child) return [];
  const below = new Set([childId, ...descendants(tasks, childId).map((d) => d.id)]);
  const room = MAX_TASK_DEPTH - subtreeHeight(tasks, childId);
  const depths = new Map<string, number>();
  const depth = (t: T, guard = 0): number => {
    const known = depths.get(t.id);
    if (known !== undefined) return known;
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    const d = parent && guard <= MAX_TASK_DEPTH * 4 ? depth(parent, guard + 1) + 1 : 1;
    depths.set(t.id, d);
    return d;
  };
  return tasks.filter((t) => t.listId === child.listId && t.kind === 'task' && t.status !== 'done' && t.status !== 'cancelled' && t.id !== child.parentId && !below.has(t.id) && depth(t) <= room);
}

/**
 * Przepięcie zadania (z podzadaniami) pod `parentId` albo odpięcie do zadań głównych listy (`null`) —
 * na koniec nowego rodzeństwa, z cofnięciem. `null`, gdy się nie da (ten sam rodzic, cykl, inna
 * lista, ponad 4 poziomy — `parentCandidates`).
 */
export function reparentTaskOps(tasks: readonly SubtaskTask[], childId: string, parentId: string | null): { ops: TaskOp[]; undo: TaskOp[] } | null {
  const child = tasks.find((t) => t.id === childId);
  if (!child || child.parentId === parentId) return null;
  if (parentId !== null && !parentCandidates(tasks, childId).some((t) => t.id === parentId)) return null;
  const last = tasks
    .filter((t) => t.id !== childId && t.parentId === parentId && (parentId !== null || t.listId === child.listId))
    .map((t) => t.sortKey)
    .sort()
    .at(-1);
  return {
    ops: [{ table: 'tasks', id: childId, patch: { parent_id: parentId, sort_key: keyBetween(last) } }],
    undo: [{ table: 'tasks', id: childId, patch: { parent_id: child.parentId, sort_key: child.sortKey } }],
  };
}

/**
 * Zmiana dat zadania z zachowaniem reguł wiersza (`TaskRow`): bez terminu nie ma godziny ani
 * początku; początek po terminie przesuwa się na termin.
 */
export function datesPatch(
  current: Pick<ViewTask, 'startDate' | 'dueDate' | 'dueTime'>,
  change: Partial<{ start_date: LocalDate | null; due_date: LocalDate | null; due_time: LocalTime | null }>,
): Record<string, unknown> {
  const next = { start_date: current.startDate, due_date: current.dueDate, due_time: current.dueTime, ...change };
  if (!next.due_date) {
    next.due_time = null;
    next.start_date = null;
  } else if (next.start_date && next.start_date > next.due_date) next.start_date = next.due_date;
  const patch: Record<string, unknown> = {};
  if (next.start_date !== current.startDate) patch.start_date = next.start_date;
  if (next.due_date !== current.dueDate) patch.due_date = next.due_date;
  if (next.due_time !== current.dueTime) patch.due_time = next.due_time;
  return patch;
}

/**
 * Przeniesienie na inną listę: zadanie i jego podzadania (serwer robi to samo w triggerze —
 * lokalnie od razu, także offline). Podzadanie przeniesione na inną listę staje się zadaniem głównym.
 */
export function moveTaskOps(tasks: readonly (TreeTask & Pick<ViewTask, 'listId'>)[], id: string, listId: string): TaskOp[] {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.listId === listId) return [];
  return [
    // Miejsce karteczki dotyczy listy — na nowej liście zadanie trafia do paska „Do ułożenia”.
    { table: 'tasks', id, patch: task.parentId ? { list_id: listId, parent_id: null, canvas_pos: null } : { list_id: listId, canvas_pos: null } },
    ...descendants(tasks, id).map((d): TaskOp => ({ table: 'tasks', id: d.id, patch: { list_id: listId } })),
  ];
}

/** Do kosza: zadanie i podzadania z tym samym `deleted_at` (przywrócenie bierze je razem). */
export function deleteTaskOps(tasks: readonly TreeTask[], id: string, now: Date | string): TaskOp[] {
  const at = new Date(now).toISOString();
  return [id, ...descendants(tasks, id).map((d) => d.id)].map((taskId) => ({ table: 'tasks', id: taskId, patch: { deleted_at: at } }));
}

/** Usunięte razem: ten sam moment (lokalnie `…000Z`, po powrocie z serwera `…+00:00`). */
export const sameDeletion = (a: string | null, b: string | null): boolean => a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

/** Z kosza: zadanie i podzadania usunięte razem z nim; rodzic wciąż w koszu → zadanie główne. */
export function restoreTaskOps(
  trashed: readonly (TreeTask & { deletedAt: string | null })[],
  id: string,
  { parentAlive }: { parentAlive: boolean },
): TaskOp[] {
  const task = trashed.find((t) => t.id === id);
  if (!task?.deletedAt) return [];
  return [
    { table: 'tasks', id, patch: task.parentId && !parentAlive ? { deleted_at: null, parent_id: null } : { deleted_at: null } },
    ...descendants(trashed, id)
      .filter((d) => sameDeletion(d.deletedAt, task.deletedAt))
      .map((d): TaskOp => ({ table: 'tasks', id: d.id, patch: { deleted_at: null } })),
  ];
}

/** Otwarte podzadania (pytanie „Ukończyć też podzadania?” przy ukończeniu rodzica). */
export const openDescendants = <T extends TreeTask & Pick<ViewTask, 'status'>>(tasks: readonly T[], id: string): T[] =>
  descendants(tasks, id).filter((t) => t.status !== 'done' && t.status !== 'cancelled');

// ── Operacje na zaznaczonych zadaniach (paleta, skróty, operacje grupowe M3) ───────────────

export type BulkAction =
  | { kind: 'complete' }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'today' }
  | { kind: 'tomorrow' }
  | { kind: 'date'; date: LocalDate }
  /** Bez terminu (przegląd: „Kiedyś”); seria zostaje bez zmian. */
  | { kind: 'someday' }
  | { kind: 'move'; listId: string }
  | { kind: 'delete' };

const BEFORE: Record<string, (t: ViewTask) => unknown> = {
  list_id: (t) => t.listId,
  parent_id: (t) => t.parentId,
  priority: (t) => t.priority,
  status: (t) => t.status,
  completed_at: (t) => t.completedAt,
  due_date: (t) => t.dueDate,
  due_time: (t) => t.dueTime,
  start_date: (t) => t.startDate,
  postpone_count: (t) => t.postponeCount,
  canvas_pos: (t) => t.canvasPos ?? null,
  derived_from: (t) => t.derivedFrom ?? null,
  deleted_at: () => null,
};

/** Odwrotność łatki zadania: poprzednie wartości tych samych pól. */
const undoOf = (op: TaskOp, task: ViewTask | undefined): TaskOp => ({
  table: op.table,
  id: op.id,
  patch: Object.fromEntries(Object.keys(op.patch).map((field) => [field, task ? (BEFORE[field]?.(task) ?? null) : null])),
});

/**
 * Jedna akcja na wielu zadaniach naraz, z operacjami „Cofnij”. Zadania zamknięte pomija ukończenie;
 * „Dziś / Jutro / data” liczy `reschedulePatch` (godzina zostaje, zakres przesuwa się w całości,
 * przesunięcie na później zwiększa licznik). Podzadania zaznaczone razem z rodzicem przy
 * przeniesieniu i usunięciu idą z nim (bez podwójnych operacji).
 */
export function bulkTaskOps(
  selected: readonly ViewTask[],
  all: readonly ViewTask[],
  action: BulkAction,
  { today, now, timeZone }: { today: LocalDate; now: Date | string; timeZone?: string },
): { ops: TaskOp[]; undo: TaskOp[] } {
  const byId = new Map(all.map((t) => [t.id, t]));
  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  const push = (list: readonly TaskOp[]) => {
    for (const op of list) {
      if (ops.some((o) => o.table === op.table && o.id === op.id)) continue;
      ops.push(op);
      if (op.table === 'tasks') undo.push(undoOf(op, byId.get(op.id)));
    }
  };
  const ids = new Set(selected.map((t) => t.id));
  // Przy przeniesieniu / usunięciu wystarczą zaznaczone „najwyżej w drzewie”.
  const tops = selected.filter((t) => {
    for (let p = t.parentId; p; p = byId.get(p)?.parentId ?? null) if (ids.has(p)) return false;
    return true;
  });

  for (const task of action.kind === 'move' || action.kind === 'delete' ? tops : selected) {
    switch (action.kind) {
      case 'complete': {
        if (task.kind === 'task' && (task.status === 'done' || task.status === 'cancelled')) break;
        const result = completeTaskOps(task, { now, timeZone });
        for (const op of result.ops) if (!ops.some((o) => o.table === op.table && o.id === op.id)) ops.push(op);
        undo.push(...result.undo);
        break;
      }
      case 'priority':
        if (task.priority !== action.priority) push([{ table: 'tasks', id: task.id, patch: { priority: action.priority } }]);
        break;
      case 'today':
      case 'tomorrow':
      case 'date':
      case 'someday': {
        const patch = reschedulePatch(task, action, { today });
        if (!patch) break;
        const snake: Record<string, unknown> = { due_date: patch.dueDate };
        if (patch.dueTime !== undefined) snake.due_time = patch.dueTime;
        if (patch.startDate !== undefined) snake.start_date = patch.startDate;
        if (patch.postponeCount !== undefined) snake.postpone_count = patch.postponeCount;
        push([{ table: 'tasks', id: task.id, patch: snake }]);
        break;
      }
      case 'move':
        push(moveTaskOps(all, task.id, action.listId));
        break;
      case 'delete':
        push(deleteTaskOps(all, task.id, now));
        break;
    }
  }
  return { ops, undo };
}

// ── Przeciąganie w liście (kolejność ręczna, drzewo podzadań) ────────────────────────────────

/** Wysokość poddrzewa: 1 = zadanie bez podzadań. */
function subtreeHeight(tasks: readonly TreeTask[], id: string): number {
  const children = tasks.filter((t) => t.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => subtreeHeight(tasks, c.id)));
}

/**
 * Upuszczenie zadania przed / za innym w widoku listy: zadanie staje się rodzeństwem celu (ten sam
 * rodzic) z kluczem kolejności między sąsiadami. `null` = upuszczenia nie da się wykonać — w samo
 * siebie lub własne podzadanie (cykl) albo za głęboko (> 4 poziomy). Brak zmiany → pusta lista.
 */
export function dropTaskOps(
  tasks: readonly (TreeTask & Pick<ViewTask, 'listId' | 'sortKey'>)[],
  draggedId: string,
  targetId: string,
  place: 'before' | 'after',
): TaskOp[] | null {
  const dragged = tasks.find((t) => t.id === draggedId);
  const target = tasks.find((t) => t.id === targetId);
  if (!dragged || !target || draggedId === targetId) return dragged && target ? [] : null;
  if (descendants(tasks, draggedId).some((d) => d.id === targetId)) return null;
  const parentId = target.parentId;
  const depth = parentId ? taskDepth(tasks, parentId) : 0;
  if (depth + subtreeHeight(tasks, draggedId) > MAX_TASK_DEPTH) return null;

  const byKey = (a: { sortKey: string; id: string }, b: { sortKey: string; id: string }) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);
  const siblings = tasks
    .filter((t) => t.id !== draggedId && t.parentId === parentId && (parentId !== null || t.listId === target.listId))
    .sort(byKey);
  const at = siblings.findIndex((t) => t.id === targetId) + (place === 'after' ? 1 : 0);
  const before = siblings[at - 1]?.sortKey;
  const after = siblings[at]?.sortKey;

  const patch: Record<string, unknown> = {};
  if (dragged.parentId !== parentId) patch.parent_id = parentId;
  if (dragged.listId !== target.listId) patch.list_id = target.listId;
  const current = tasks
    .filter((t) => t.parentId === parentId && (parentId !== null || t.listId === target.listId))
    .sort(byKey)
    .map((t) => t.id);
  const next = [...siblings.slice(0, at).map((t) => t.id), draggedId, ...siblings.slice(at).map((t) => t.id)];
  const unchanged = !Object.keys(patch).length && current.join() === next.join();
  if (unchanged) return [];

  let ops: TaskOp[];
  try {
    ops = [{ table: 'tasks', id: draggedId, patch: { ...patch, sort_key: keyBetween(before, after) } }];
  } catch {
    // Równe klucze sąsiadów — nowa numeracja rodzeństwa z przeciąganym w nowym miejscu.
    const order = [...siblings.slice(0, at), dragged, ...siblings.slice(at)];
    let prev: string | undefined;
    ops = order.map((t) => {
      prev = keyBetween(prev);
      return { table: 'tasks', id: t.id, patch: t.id === draggedId ? { ...patch, sort_key: prev } : { sort_key: prev } };
    });
  }
  if (patch.list_id) ops.push(...descendants(tasks, draggedId).map((d): TaskOp => ({ table: 'tasks', id: d.id, patch: { list_id: target.listId } })));
  return ops;
}

/** Krok w drzewie listy bez przeciągania (telefon): wyżej / niżej wśród rodzeństwa, w głąb poprzedniego, poziom wyżej. */
export type TaskNudge = 'up' | 'down' | 'in' | 'out';

/**
 * Przesunięcie zadania o krok — reguły jak `dropTaskOps`. `visible` — wiersze w kolejności na ekranie
 * (ukryte ukończone się nie liczą). `null` = w tym kierunku się nie da (skraj, 4 poziomy).
 */
export function nudgeTaskOps(tasks: readonly SubtaskTask[], visible: readonly string[], id: string, move: TaskNudge): TaskOp[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = byId.get(id);
  if (!task) return null;
  if (move === 'out') return task.parentId ? dropTaskOps(tasks, id, task.parentId, 'after') : null;
  const siblings = visible.filter((v) => byId.get(v)?.parentId === task.parentId);
  const at = siblings.indexOf(id);
  if (at < 0) return null;
  if (move === 'down') return siblings[at + 1] ? dropTaskOps(tasks, id, siblings[at + 1]!, 'after') : null;
  const previous = siblings[at - 1];
  if (!previous) return null;
  if (move === 'up') return dropTaskOps(tasks, id, previous, 'before');
  // W głąb: na koniec podzadań poprzedniego (też ukrytych), w jego liście.
  const children = tasks.filter((t) => t.parentId === previous).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1));
  const last = children.at(-1);
  return last ? dropTaskOps(tasks, id, last.id, 'after') : (reparentTaskOps(tasks, id, previous)?.ops ?? null);
}
