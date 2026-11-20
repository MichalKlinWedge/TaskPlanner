/**
 * Oś czasu (M12, Etap 6): wiersze projektów → zadań → podzadań z paskami i postępem, zależności
 * koniec→początek widoczne na osi, naruszenia, a także operacje z osi — przesunięcie i rozciągnięcie
 * paska („Przesuń zależne” / „Tylko to zadanie”), pasek projektu przesuwa cały projekt, dodanie
 * zależności (z blokadą cyklu — SVAR Gantt cykle przyjmuje), usunięcie i opóźnienie zależności.
 * Każda operacja wraca z „Cofnij”. Reguły (`taskSpan`, `detectCycle`, `violations`, `shiftSuccessors`,
 * `projectSpan`) są w `dependencies.ts`.
 */
import { addDays, daysBetween } from './dates.ts';
import { detectCycle, projectSpan, shiftSuccessors, taskSpan, violations, type Dependency, type ScheduledTask, type Span, type Violation } from './dependencies.ts';
import { uuidv7 } from './ids.ts';
import type { LocalDate, TaskStatus } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';

export interface TimelineTask extends ScheduledTask {
  listId: string;
  parentId: string | null;
  /** Przestrzeń — zależność łączy tylko zadania z jednej przestrzeni (`TP004`). */
  workspaceId: string;
  kind: 'task' | 'habit';
  title: string;
  status: TaskStatus;
  sortKey: string;
}

export interface TimelineProject {
  id: string;
  name: string;
  startDate: LocalDate | null;
  endDate: LocalDate | null;
}

export interface TimelineRow {
  /** Id zadania albo listy (projektu). */
  id: string;
  kind: 'project' | 'task';
  /** Rodzic na osi: projekt (id listy) albo zadanie nadrzędne; projekt — `null`. */
  parentId: string | null;
  projectId: string;
  title: string;
  /** Brak — wiersz bez paska (zadanie bez terminu z podzadaniami z terminem, pusty projekt). */
  span: Span | null;
  /** 0–100: zadanie ukończone = 100, z podzadaniami — udział ukończonych; projekt — udział ukończonych zadań. */
  progress: number;
  done: boolean;
  /** Zaczyna się za wcześnie względem poprzednika. */
  violated: boolean;
  hasChildren: boolean;
}

export interface TimelineModel {
  rows: TimelineRow[];
  /** Zależności między zadaniami z paskiem na osi. */
  links: Dependency[];
  violations: Violation[];
  /** Zadania projektów bez terminu (bez paska i bez podzadań z terminem) — tylko licznik. */
  undated: number;
}

const isDone = (t: Pick<TimelineTask, 'status'>) => t.status === 'done';
const bySortKey = (a: TimelineTask, b: TimelineTask) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Wiersze osi: projekty w podanej kolejności, pod nimi zadania i podzadania (bez nawyków i anulowanych)
 * po dacie początku paska (zadanie bez paska — najwcześniejszy początek potomków; bez dat na końcu),
 * przy równej dacie w kolejności ręcznej. Zadanie bez terminu zostaje tylko wtedy, gdy ma potomka z paskiem.
 */
export function timelineModel(projects: readonly TimelineProject[], tasks: readonly TimelineTask[], deps: readonly Dependency[]): TimelineModel {
  const projectIds = new Set(projects.map((p) => p.id));
  const all = tasks.filter((t) => t.kind === 'task' && t.status !== 'cancelled' && projectIds.has(t.listId));
  const byId = new Map(all.map((t) => [t.id, t]));
  const spans = new Map(all.map((t) => [t.id, taskSpan(t)]));
  const children = new Map<string | null, TimelineTask[]>();
  for (const t of all) {
    // Rodzic spoza osi (anulowany) — zadanie wisi bezpośrednio pod projektem.
    const parent = t.parentId && byId.has(t.parentId) ? t.parentId : null;
    const key = parent ?? `list:${t.listId}`;
    children.set(key, [...(children.get(key) ?? []), t]);
  }
  // Początek do sortowania: własny pasek albo najwcześniejszy potomek (wiersz zadania bez terminu).
  const starts = new Map<string, LocalDate | null>();
  const startOf = (t: TimelineTask): LocalDate | null => {
    if (starts.has(t.id)) return starts.get(t.id)!;
    let start = spans.get(t.id)?.start ?? null;
    for (const c of children.get(t.id) ?? []) {
      const s = startOf(c);
      if (s && (!start || s < start)) start = s;
    }
    starts.set(t.id, start);
    return start;
  };
  const byStart = (a: TimelineTask, b: TimelineTask) => {
    const x = startOf(a);
    const y = startOf(b);
    return x === y ? bySortKey(a, b) : !x ? 1 : !y ? -1 : x < y ? -1 : 1;
  };
  for (const list of children.values()) list.sort(byStart);

  // Widoczne: z paskiem albo z widocznym potomkiem.
  const visible = new Set<string>();
  const mark = (t: TimelineTask): boolean => {
    let shown = !!spans.get(t.id);
    for (const c of children.get(t.id) ?? []) if (mark(c)) shown = true;
    if (shown) visible.add(t.id);
    return shown;
  };
  for (const p of projects) for (const t of children.get(`list:${p.id}`) ?? []) mark(t);

  const linked = deps.filter((d) => spans.get(d.predecessorId) && spans.get(d.successorId));
  const found = violations(all.filter((t) => visible.has(t.id)), linked);
  const late = new Set(found.map((v) => v.dependency.successorId));

  const rows: TimelineRow[] = [];
  const walk = (t: TimelineTask, parentId: string, projectId: string) => {
    const kids = (children.get(t.id) ?? []).filter((c) => visible.has(c.id));
    const sub = children.get(t.id) ?? [];
    const progress = isDone(t) ? 100 : sub.length ? Math.round((sub.filter(isDone).length / sub.length) * 100) : 0;
    rows.push({ id: t.id, kind: 'task', parentId, projectId, title: t.title, span: spans.get(t.id) ?? null, progress, done: isDone(t), violated: late.has(t.id), hasChildren: kids.length > 0 });
    for (const c of kids) walk(c, t.id, projectId);
  };
  for (const p of projects) {
    const own = all.filter((t) => t.listId === p.id);
    const top = (children.get(`list:${p.id}`) ?? []).filter((t) => visible.has(t.id));
    rows.push({
      id: p.id,
      kind: 'project',
      parentId: null,
      projectId: p.id,
      title: p.name,
      span: projectSpan(p, own),
      progress: own.length ? Math.round((own.filter(isDone).length / own.length) * 100) : 0,
      done: false,
      violated: false,
      hasChildren: top.length > 0,
    });
    for (const t of top) walk(t, p.id, p.id);
  }
  return { rows, links: linked.filter((d) => visible.has(d.predecessorId) && visible.has(d.successorId)), violations: found, undated: all.filter((t) => !visible.has(t.id)).length };
}

export interface TimelineResult {
  ops: TaskOp[];
  undo: TaskOp[];
  /** Ile zadań zmieniło daty (z przesuniętymi zależnymi). */
  changed: number;
}

const EMPTY: TimelineResult = { ops: [], undo: [], changed: 0 };

/** Łatki dat i „Cofnij” dla nowych dat zadań (tylko zmienione pola). */
function dateOps(tasks: ReadonlyMap<string, ScheduledTask>, changes: readonly { id: string; startDate: LocalDate | null; dueDate: LocalDate }[]): TimelineResult {
  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  for (const c of changes) {
    const t = tasks.get(c.id);
    if (!t) continue;
    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    if (c.startDate !== t.startDate) (patch.start_date = c.startDate), (before.start_date = t.startDate);
    if (c.dueDate !== t.dueDate) (patch.due_date = c.dueDate), (before.due_date = t.dueDate);
    if (!Object.keys(patch).length) continue;
    ops.push({ table: 'tasks', id: c.id, patch });
    undo.push({ table: 'tasks', id: c.id, patch: before });
  }
  return { ops, undo, changed: ops.length };
}

/**
 * Nowy zakres paska z osi (dni włącznie). Przesunięcie (oba końce o tyle samo) — z `cascade`
 * przesuwa też następników o tyle samo; rozciągnięcie końca — z `cascade` przesuwa następników
 * o zmianę końca; zmiana początku następników nie rusza. Godzina i czas trwania zostają.
 */
export function timelineChangeOps(
  tasks: readonly ScheduledTask[],
  deps: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  id: string,
  next: Span,
  { cascade = true }: { cascade?: boolean } = {},
): TimelineResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = byId.get(id);
  const span = task && taskSpan(task);
  if (!task?.dueDate || !span || next.end < next.start) return EMPTY;
  const startDelta = daysBetween(span.start, next.start);
  const endDelta = daysBetween(span.end, next.end);
  if (!startDelta && !endDelta) return EMPTY;
  if (startDelta === endDelta) return dateOps(byId, shiftSuccessors(tasks, deps, id, startDelta, { cascade }));
  // Koniec paska to `due_date` plus dni, na które zadanie z godziną przechodzi po północy.
  const spill = daysBetween(task.dueDate, span.end);
  const due = addDays(next.end, -spill);
  const own = { id, startDate: next.start < due ? next.start : null, dueDate: due };
  const rest = cascade && endDelta ? shiftSuccessors(tasks, deps, id, endDelta).filter((c) => c.id !== id) : [];
  return dateOps(byId, [own, ...rest]);
}

/**
 * Pasek projektu przesunięty o `deltaDays`: wszystkie zadania projektu z terminem (z `cascade` — także
 * ich następnicy spoza projektu) i daty projektu, jeśli są ustawione.
 */
export function shiftProjectOps(
  project: TimelineProject,
  tasks: readonly (ScheduledTask & Pick<TimelineTask, 'listId' | 'status'>)[],
  deps: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  deltaDays: number,
  { cascade = true }: { cascade?: boolean } = {},
): TimelineResult {
  if (!deltaDays) return EMPTY;
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const ids = live.filter((t) => t.listId === project.id && t.dueDate).map((t) => t.id);
  const result = dateOps(new Map(live.map((t) => [t.id, t])), shiftSuccessors(live, deps, ids, deltaDays, { cascade }));
  if (project.startDate || project.endDate) {
    const patch: Record<string, unknown> = {};
    if (project.startDate) patch.start_date = addDays(project.startDate, deltaDays);
    if (project.endDate) patch.end_date = addDays(project.endDate, deltaDays);
    result.ops.push({ table: 'lists', id: project.id, patch });
    result.undo.push({ table: 'lists', id: project.id, patch: { start_date: project.startDate, end_date: project.endDate } });
  }
  return result;
}

export type DependencyError =
  | { reason: 'cycle'; cycle: string[] }
  | { reason: 'duplicate' }
  | { reason: 'workspace' }
  | { reason: 'missing' };

/** Komunikat błędu zależności do pokazania użytkownikowi. */
export function dependencyErrorText(error: DependencyError, titleOf: (id: string) => string): string {
  switch (error.reason) {
    case 'cycle':
      return error.cycle.length <= 2 ? 'Zadanie nie może zależeć od siebie.' : `Ta zależność zamknęłaby cykl: ${error.cycle.map(titleOf).join(' → ')}.`;
    case 'duplicate':
      return 'Ta zależność już istnieje.';
    case 'workspace':
      return 'Zależność łączy tylko zadania z jednej przestrzeni.';
    case 'missing':
      return 'Nie ma takiego zadania.';
  }
}

/**
 * Nowa zależność koniec→początek: sprawdza cykl (`detectCycle`), duplikat i przestrzeń — błąd zamiast
 * operacji. `scope_id` wylicza serwer z poprzednika (nie wysyłamy go).
 */
export function addDependencyOps(
  tasks: readonly Pick<TimelineTask, 'id' | 'workspaceId'>[],
  deps: readonly Dependency[],
  next: { predecessorId: string; successorId: string; lagDays?: number },
  id: string = uuidv7(),
): { ops: TaskOp[]; undo: TaskOp[]; id: string } | { error: DependencyError } {
  const a = tasks.find((t) => t.id === next.predecessorId);
  const b = tasks.find((t) => t.id === next.successorId);
  if (!a || !b) return { error: { reason: 'missing' } };
  const cycle = detectCycle(deps, next);
  if (cycle) return { error: { reason: 'cycle', cycle } };
  if (deps.some((d) => d.predecessorId === next.predecessorId && d.successorId === next.successorId)) return { error: { reason: 'duplicate' } };
  if (a.workspaceId !== b.workspaceId) return { error: { reason: 'workspace' } };
  const lagDays = clampLag(next.lagDays ?? 0);
  return {
    id,
    ops: [{ table: 'task_dependencies', id, patch: { predecessor_id: next.predecessorId, successor_id: next.successorId, kind: 'finish_to_start', lag_days: lagDays } }],
    undo: [{ table: 'task_dependencies', id, patch: { deleted_at: new Date().toISOString() } }],
  };
}

/** Opóźnienie w dniach w granicach z bazy (−365…365, całkowite). */
export const clampLag = (days: number): number => (Number.isFinite(days) ? Math.max(-365, Math.min(365, Math.round(days))) : 0);

/** Usunięcie zależności (miękkie) z „Cofnij”. */
export function removeDependencyOps(id: string, now: Date | string = new Date()): { ops: TaskOp[]; undo: TaskOp[] } {
  return { ops: [{ table: 'task_dependencies', id, patch: { deleted_at: new Date(now).toISOString() } }], undo: [{ table: 'task_dependencies', id, patch: { deleted_at: null } }] };
}

export interface TaskLink {
  dependency: Dependency;
  /** Drugie zadanie zależności (poprzednik albo następnik). */
  otherId: string;
  violation: Violation | null;
}

/** Poprzednicy i następnicy zadania (panel zadania), z naruszeniami. */
export function taskLinks(taskId: string, tasks: readonly ScheduledTask[], deps: readonly Dependency[]): { predecessors: TaskLink[]; successors: TaskLink[] } {
  const ids = new Set(tasks.map((t) => t.id));
  const mine = deps.filter((d) => (d.predecessorId === taskId || d.successorId === taskId) && ids.has(d.predecessorId) && ids.has(d.successorId));
  const bad = new Map(violations(tasks, mine).map((v) => [v.dependency.id, v]));
  const link = (d: Dependency, otherId: string): TaskLink => ({ dependency: d, otherId, violation: bad.get(d.id) ?? null });
  return {
    predecessors: mine.filter((d) => d.successorId === taskId).map((d) => link(d, d.predecessorId)),
    successors: mine.filter((d) => d.predecessorId === taskId).map((d) => link(d, d.successorId)),
  };
}
