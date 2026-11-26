/**
 * Oś czasu (M12, Etap 6): wiersze projektów → zadań → podzadań z paskami i postępem, zależności
 * koniec→początek widoczne na osi, naruszenia, a także operacje z osi — przesunięcie i rozciągnięcie
 * paska („Przesuń zależne” / „Tylko to zadanie”), pasek projektu przesuwa cały projekt, dodanie
 * zależności (z blokadą cyklu — SVAR Gantt cykle przyjmuje), usunięcie i opóźnienie zależności.
 * Każda operacja wraca z „Cofnij”. Ścieżka krytyczna (zapas zadań, łańcuch wyznaczający koniec projektu) liczy się
 * przy każdym modelu. Reguły (`taskSpan`, `detectCycle`, `violations`, `shiftSuccessors`, `projectSpan`,
 * `criticalPath`) są w `dependencies.ts`.
 */
import { addDays, addMonths, daysBetween, isoWeekday, weekStart } from './dates.ts';
import { criticalPath, detectCycle, projectSpan, shiftSuccessors, taskSpan, violations, type Dependency, type ScheduledTask, type Span, type Violation } from './dependencies.ts';
import { plural } from './format.ts';
import { uuidv7 } from './ids.ts';
import { MONTH_NAME, PRIORITY, TASK_STATUS } from './labels.ts';
import type { LocalDate, Priority, TaskStatus } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';
import { columnName, type XlsxCell, type XlsxSheet } from './xlsx.ts';

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
  /** Na ścieżce krytycznej (otwarte zadanie z paskiem bez zapasu). */
  critical: boolean;
  /** Zapas w dniach (roboczych z `workdays`; otwarte zadanie z paskiem); `null` — ukończone, bez paska, projekt. */
  float: number | null;
}

/** Ścieżka krytyczna projektu: zadania w kolejności początku i koniec projektu, który wyznaczają. */
export interface CriticalChain {
  projectId: string;
  end: LocalDate;
  taskIds: string[];
}

export interface TimelineModel {
  rows: TimelineRow[];
  /** Zależności między zadaniami z paskiem na osi. */
  links: Dependency[];
  violations: Violation[];
  /** Zależności na ścieżce krytycznej (id). */
  criticalLinks: string[];
  /** Ścieżki krytyczne projektów (w kolejności projektów; bez otwartych zadań z paskiem — brak). */
  criticalChains: CriticalChain[];
  /** Zadania projektów bez terminu (bez paska i bez podzadań z terminem): poza osią, a z `withUndated` — wiersze bez paska. */
  undated: number;
}

export interface TimelineOptions {
  /** Pokaż też zadania bez terminu (wiersze bez paska, na końcu rodzeństwa), żeby było widać całe drzewo projektu. */
  withUndated?: boolean;
  /** Dni robocze (ISO, `settings.workHours.days`): zapas ścieżki krytycznej liczony w nich. */
  workdays?: readonly number[];
}

const isDone = (t: Pick<TimelineTask, 'status'>) => t.status === 'done';
const bySortKey = (a: TimelineTask, b: TimelineTask) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Wiersze osi: projekty w podanej kolejności, pod nimi zadania i podzadania (bez nawyków i anulowanych)
 * po dacie początku paska (zadanie bez paska — najwcześniejszy początek potomków; bez dat na końcu),
 * przy równej dacie w kolejności ręcznej. Zadanie bez terminu zostaje tylko wtedy, gdy ma potomka z paskiem
 * — albo zawsze z `withUndated`.
 */
export function timelineModel(projects: readonly TimelineProject[], tasks: readonly TimelineTask[], deps: readonly Dependency[], options: TimelineOptions = {}): TimelineModel {
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
    let shown = !!spans.get(t.id) || !!options.withUndated;
    for (const c of children.get(t.id) ?? []) if (mark(c)) shown = true;
    if (shown) visible.add(t.id);
    return shown;
  };
  for (const p of projects) for (const t of children.get(`list:${p.id}`) ?? []) mark(t);

  const linked = deps.filter((d) => spans.get(d.predecessorId) && spans.get(d.successorId));
  const found = violations(all.filter((t) => visible.has(t.id)), linked);
  const late = new Set(found.map((v) => v.dependency.successorId));
  // Ścieżka krytyczna: otwarte zadania z paskiem; ukończone nie mogą się już spóźnić.
  const open = all.filter((t) => visible.has(t.id) && !isDone(t) && spans.get(t.id));
  const cp = criticalPath(open.map((t) => ({ ...t, group: t.listId })), linked, { workdays: options.workdays });

  const rows: TimelineRow[] = [];
  const walk = (t: TimelineTask, parentId: string, projectId: string) => {
    const kids = (children.get(t.id) ?? []).filter((c) => visible.has(c.id));
    const sub = children.get(t.id) ?? [];
    const progress = isDone(t) ? 100 : sub.length ? Math.round((sub.filter(isDone).length / sub.length) * 100) : 0;
    rows.push({ id: t.id, kind: 'task', parentId, projectId, title: t.title, span: spans.get(t.id) ?? null, progress, done: isDone(t), violated: late.has(t.id), hasChildren: kids.length > 0, critical: cp.tasks.has(t.id), float: cp.float.get(t.id) ?? null });
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
      critical: false,
      float: null,
    });
    for (const t of top) walk(t, p.id, p.id);
  }
  const criticalChains = projects.flatMap((p): CriticalChain[] => {
    const end = cp.ends.get(p.id);
    if (!end) return [];
    const taskIds = open
      .filter((t) => t.listId === p.id && cp.tasks.has(t.id))
      .sort((a, b) => {
        const x = spans.get(a.id)!;
        const y = spans.get(b.id)!;
        return x.start === y.start ? (x.end === y.end ? bySortKey(a, b) : x.end < y.end ? -1 : 1) : x.start < y.start ? -1 : 1;
      })
      .map((t) => t.id);
    return [{ projectId: p.id, end, taskIds }];
  });
  const shownLinks = linked.filter((d) => visible.has(d.predecessorId) && visible.has(d.successorId));
  return {
    rows,
    links: shownLinks,
    violations: found,
    criticalLinks: shownLinks.filter((d) => cp.links.has(d.id)).map((d) => d.id),
    criticalChains,
    undated: all.filter((t) => !startOf(t)).length,
  };
}

/**
 * Zakres rysowany dla wiersza: własny pasek, a wiersz bez niego (zadanie bez terminu, projekt bez dat
 * i zadań z terminem) — zakres widocznych potomków. Brak wpisu = wiersz bez paska.
 */
export function timelineRowSpans(rows: readonly TimelineRow[]): Map<string, Span> {
  const own = new Map(rows.map((r) => [r.id, r.span]));
  const shown = new Map<string, Span>();
  for (const r of [...rows].reverse()) {
    const span = r.span ?? shown.get(r.id) ?? null;
    if (!span) continue;
    shown.set(r.id, span);
    if (!r.parentId || own.get(r.parentId)) continue;
    const up = shown.get(r.parentId);
    shown.set(r.parentId, up ? { start: up.start < span.start ? up.start : span.start, end: up.end > span.end ? up.end : span.end } : span);
  }
  return shown;
}

/**
 * Projekty widoczne na osi: wszystkie poza ukrytymi w filtrze (nowy projekt jest więc od razu widoczny).
 * Ukryte id, których już nie ma, nie przeszkadzają.
 */
export function visibleProjects<P extends Pick<TimelineProject, 'id'>>(projects: readonly P[], hidden: ReadonlySet<string>): P[] {
  return hidden.size ? projects.filter((p) => !hidden.has(p.id)) : [...projects];
}

/** Opis filtra projektów na przycisku: „wszystkie”, nazwa jedynego albo „N z M”. */
export function projectFilterLabel(projects: readonly Pick<TimelineProject, 'id' | 'name'>[], hidden: ReadonlySet<string>): string {
  const shown = visibleProjects(projects, hidden);
  if (shown.length === projects.length) return 'wszystkie';
  if (!shown.length) return 'żaden';
  if (shown.length === 1) return shown[0]!.name;
  return `${shown.length} z ${projects.length}`;
}

/**
 * Arkusz eksportu osi (to, co widać po filtrze): wiersz na projekt, zadanie i podzadanie w kolejności
 * osi, z wcięciem poziomu, datami paska, postępem, statusem, priorytetem, poprzednikami, naruszeniem
 * i zapasem (ścieżka krytyczna: „krytyczne”).
 */
export function timelineSheet(
  model: TimelineModel,
  tasks: readonly (Pick<TimelineTask, 'id' | 'title' | 'status'> & { priority?: Priority })[],
  name = 'Oś czasu',
): XlsxSheet {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const projectName = new Map(model.rows.filter((r) => r.kind === 'project').map((r) => [r.id, r.title]));
  const depth = new Map<string, number>();
  const late = new Map(model.violations.map((v) => [v.dependency.successorId, v]));
  const predecessors = new Map<string, Dependency[]>();
  for (const d of model.links) predecessors.set(d.successorId, [...(predecessors.get(d.successorId) ?? []), d]);
  const titleOf = (id: string) => byId.get(id)?.title ?? '?';
  const days = (n: number) => plural(n, ['dzień', 'dni', 'dni']);

  const rows: XlsxCell[][] = [];
  const indents: number[] = [];
  for (const r of model.rows) {
    const level = r.kind === 'project' ? 0 : (depth.get(r.parentId ?? '') ?? 0) + 1;
    depth.set(r.id, level);
    const task = r.kind === 'task' ? byId.get(r.id) : undefined;
    const v = late.get(r.id);
    rows.push([
      projectName.get(r.projectId) ?? '',
      r.title,
      r.kind === 'project' ? 'Projekt' : level === 1 ? 'Zadanie' : 'Podzadanie',
      r.span ? { date: r.span.start } : null,
      r.span ? { date: r.span.end } : null,
      r.span ? daysBetween(r.span.start, r.span.end) + 1 : null,
      { percent: r.progress / 100 },
      task ? TASK_STATUS[task.status] : '',
      task?.priority ? PRIORITY[task.priority].label : '',
      (predecessors.get(r.id) ?? []).map((d) => `${titleOf(d.predecessorId)}${d.lagDays ? ` (${d.lagDays > 0 ? '+' : '−'}${days(Math.abs(d.lagDays))})` : ''}`).join('; '),
      v ? `${days(v.days)} za wcześnie po „${titleOf(v.dependency.predecessorId)}”` : '',
      r.float === null ? '' : r.critical ? 'krytyczne' : r.float,
    ]);
    indents.push(level);
  }
  return {
    name,
    columns: [
      { header: 'Projekt', width: 24 },
      { header: 'Zadanie', width: 44 },
      { header: 'Typ', width: 11 },
      { header: 'Początek', width: 11 },
      { header: 'Koniec', width: 11 },
      { header: 'Dni', width: 6 },
      { header: 'Postęp', width: 8 },
      { header: 'Status', width: 13 },
      { header: 'Priorytet', width: 10 },
      { header: 'Poprzednicy', width: 32 },
      { header: 'Naruszenie', width: 32 },
      { header: 'Zapas (dni)', width: 14 },
    ],
    rows,
    indents,
    indentColumn: 1,
  };
}

/** Nazwa pliku eksportu osi z dniem. */
export const timelineFileName = (today: LocalDate): string => `os-czasu-${today}.xlsx`;

// ── Eksport osi jako siatka okresów ─────────────────────────────────────────────────────────

/** Skala osi: kolumna = dzień, tydzień albo miesiąc. */
export type TimelineScale = 'day' | 'week' | 'month';

export interface TimelinePeriod {
  start: LocalDate;
  /** Ostatni dzień okresu (włącznie). */
  end: LocalDate;
  /** Etykieta kolumny: dzień miesiąca, „16.11” (początek tygodnia) albo nazwa miesiąca. */
  label: string;
  /** Grupa nad kolumną: „listopad 2026” (dni, tygodnie) albo rok (miesiące). */
  group: string;
}

/** Najwięcej kolumn okresów (limit Excela to 16 384 kolumny). */
export const MAX_TIMELINE_PERIODS = 4000;

const firstOfMonth = (date: LocalDate) => `${date.slice(0, 7)}-01` as LocalDate;
const monthGroup = (date: LocalDate) => `${MONTH_NAME[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

/** Okresy skali od okresu z `from` do okresu z `to` (tydzień od `firstDayOfWeek`, 1 = poniedziałek). */
export function timelinePeriods(from: LocalDate, to: LocalDate, scale: TimelineScale, firstDayOfWeek = 1): TimelinePeriod[] {
  const periods: TimelinePeriod[] = [];
  let start = scale === 'day' ? from : scale === 'week' ? weekStart(from, firstDayOfWeek) : firstOfMonth(from);
  while (start <= to && periods.length < MAX_TIMELINE_PERIODS) {
    const next = scale === 'day' ? addDays(start, 1) : scale === 'week' ? addDays(start, 7) : addMonths(start, 1);
    periods.push({
      start,
      end: addDays(next, -1),
      label: scale === 'day' ? String(Number(start.slice(8, 10))) : scale === 'week' ? `${start.slice(8, 10)}.${start.slice(5, 7)}` : MONTH_NAME[Number(start.slice(5, 7)) - 1]!,
      group: scale === 'month' ? start.slice(0, 4) : monthGroup(start),
    });
    start = next;
  }
  return periods;
}

const BAR_DEFAULT = '#6366f1';
const BAR_DONE = '#d1d5db';
const BAR_LATE = '#f87171';
const HEADER_TODAY = '#fde68a';
const HEADER_WEEKEND = '#e5e7eb';

/** Kolor rozjaśniony w stronę bieli (`amount` 0–1) — paski zadań jaśniejsze od paska projektu. */
export function lighten(color: string, amount: number): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const mix = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) + (255 - parseInt(hex.slice(i, i + 2), 16)) * amount);
  return `#${[0, 2, 4].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Arkusz osi jak na ekranie: wiersz na projekt / zadanie / podzadanie (wcięcie poziomu), po lewej daty
 * i postęp, dalej jedna kolumna na okres skali (dzień / tydzień / miesiąc) — pasek to komórki z tłem
 * w kolorze projektu (zadania jaśniej, ukończone szaro, naruszenie zależności na czerwono). Nad
 * kolumnami okresów scalone miesiące (albo lata); dzisiejszy okres w nagłówku na żółto, weekendy szaro.
 */
export function timelineGridSheet(
  model: TimelineModel,
  options: { scale: TimelineScale; today: LocalDate; colors?: ReadonlyMap<string, string | null>; firstDayOfWeek?: number; name?: string },
): XlsxSheet {
  const spans = model.rows.flatMap((r) => (r.span ? [r.span] : []));
  const from = spans.reduce<LocalDate | null>((m, s) => (!m || s.start < m ? s.start : m), null);
  const to = spans.reduce<LocalDate | null>((m, s) => (!m || s.end > m ? s.end : m), null);
  const periods = from && to ? timelinePeriods(from, to, options.scale, options.firstDayOfWeek) : [];
  const left = [
    { header: 'Zadanie', width: 40 },
    { header: 'Początek', width: 11 },
    { header: 'Koniec', width: 11 },
    { header: 'Postęp', width: 8 },
  ];
  const lead = left.length;
  const width = options.scale === 'day' ? 3.6 : options.scale === 'week' ? 6.5 : 11;
  const columns = [
    ...left,
    ...periods.map((p) => ({
      header: p.label,
      width,
      center: true,
      fill: p.start <= options.today && options.today <= p.end ? HEADER_TODAY : options.scale === 'day' && isoWeekday(p.start) >= 6 ? HEADER_WEEKEND : undefined,
    })),
  ];

  // Wiersz grup nad okresami: jedna scalona komórka na miesiąc (rok).
  const groups: XlsxCell[] = Array.from({ length: lead }, () => null);
  const merges: string[] = [];
  for (let i = 0; i < periods.length; ) {
    let j = i;
    while (j + 1 < periods.length && periods[j + 1]!.group === periods[i]!.group) j++;
    groups[lead + i] = periods[i]!.group;
    for (let k = i + 1; k <= j; k++) groups[lead + k] = null;
    if (j > i) merges.push(`${columnName(lead + i)}1:${columnName(lead + j)}1`);
    i = j + 1;
  }

  const depth = new Map<string, number>();
  const rows: XlsxCell[][] = [];
  const indents: number[] = [];
  for (const r of model.rows) {
    const level = r.kind === 'project' ? 0 : (depth.get(r.parentId ?? '') ?? 0) + 1;
    depth.set(r.id, level);
    const base = options.colors?.get(r.projectId) || BAR_DEFAULT;
    const color = r.kind === 'project' ? base : r.violated ? BAR_LATE : r.done ? BAR_DONE : lighten(base, level === 1 ? 0.35 : 0.55);
    const cells: XlsxCell[] = [r.title, r.span ? { date: r.span.start } : null, r.span ? { date: r.span.end } : null, { percent: r.progress / 100 }];
    for (const p of periods) cells.push(r.span && r.span.start <= p.end && r.span.end >= p.start ? { fill: color } : null);
    rows.push(cells);
    indents.push(level);
  }
  return {
    name: options.name ?? 'Oś czasu',
    columns,
    rows,
    indents,
    indentColumn: 0,
    headerRows: periods.length ? [groups] : undefined,
    merges,
    freezeColumns: lead,
    autoFilter: false,
  };
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

/**
 * Nowa data początku albo końca projektu (`null` = bez daty), bez przesuwania zadań — np. z „Edytuj”
 * listy na telefonie. Koniec przed początkiem łamie regułę modelu, więc druga data idzie za zmienioną
 * (początek po końcu = koniec tego dnia, koniec przed początkiem = początek tego dnia). Bez zmiany — puste.
 */
export function projectDatesOps(
  project: Pick<TimelineProject, 'id' | 'startDate' | 'endDate'>,
  change: { startDate: LocalDate | null } | { endDate: LocalDate | null },
): { ops: TaskOp[]; undo: TaskOp[] } {
  const next = { startDate: project.startDate, endDate: project.endDate, ...change };
  if (next.startDate && next.endDate && next.startDate > next.endDate) {
    if ('startDate' in change) next.endDate = next.startDate;
    else next.startDate = next.endDate;
  }
  const patch: Record<string, unknown> = {};
  const undo: Record<string, unknown> = {};
  if (next.startDate !== project.startDate) [patch.start_date, undo.start_date] = [next.startDate, project.startDate];
  if (next.endDate !== project.endDate) [patch.end_date, undo.end_date] = [next.endDate, project.endDate];
  if (!Object.keys(patch).length) return { ops: [], undo: [] };
  return { ops: [{ table: 'lists', id: project.id, patch }], undo: [{ table: 'lists', id: project.id, patch: undo }] };
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
