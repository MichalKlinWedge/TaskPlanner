/**
 * Widoki list (SPECYFIKACJA M9, M4, §7.1): funkcje czyste na tablicy zadań-kandydatów. Lokalna baza
 * dostarcza wiersze (bez usuniętych), tu zapadają reguły: sekcje „Dziś”, dni „Nadchodzące”
 * z wirtualnymi wystąpieniami serii, filtry, sortowanie, grupowanie i drzewo podzadań. Te same
 * funkcje liczą liczniki paska bocznego, widżety i kolejkę przeglądu — web i telefon nie mają
 * własnych wersji tych reguł.
 */
import { z } from 'zod';

import { addDays, localDateAt, weekStart } from './dates.ts';
import type { HabitSettings } from './habits.ts';
import { PRIORITY, TASK_STATUS, VIEW_SECTION } from './labels.ts';
import { dayLabel, shortDate } from './format.ts';
import { occurrences, type Recurrence } from './recurrence.ts';
import { LocalDate, Priority, TaskStatus, type LocalTime } from './schemas/primitives.ts';

/** Zadanie w postaci, na której liczą widoki (kolumny `tasks` + identyfikatory tagów). */
export interface ViewTask {
  id: string;
  /** Przestrzeń (`scope_id` zadania). */
  workspaceId: string;
  listId: string;
  parentId: string | null;
  kind: 'task' | 'habit';
  title: string;
  status: TaskStatus;
  priority: Priority;
  startDate: LocalDate | null;
  dueDate: LocalDate | null;
  dueTime: LocalTime | null;
  durationMin: number | null;
  recurrence: Recurrence | null;
  habit: HabitSettings | null;
  /** `timestamptz` (ISO). */
  completedAt: string | null;
  /** `timestamptz` (ISO). */
  createdAt: string;
  sortKey: string;
  /** Kolejność na tablicy kanbanu z kilku list (D15); brak = kolejność automatyczna. */
  boardSortKey?: string | null;
  tagIds: readonly string[];
  /** Ile razy termin przesunięto na później (przegląd oznacza ≥ 3 do decyzji). */
  postponeCount: number;
  /** Ostatnia zmiana statusu (czas z `field_clock.status`) — do „Oczekuje > 7 dni”. */
  statusChangedAt?: string | null;
}

export interface ViewContext {
  today: LocalDate;
  /** Strefa do dnia ukończenia; brak = strefa urządzenia. */
  timeZone?: string;
  /** Tryb jednej przestrzeni (M2); brak / `null` = „Wszystkie”. */
  workspaceId?: string | null;
  /** Pierwszy dzień tygodnia z ustawień (1 = poniedziałek … 7 = niedziela). */
  firstDayOfWeek?: number;
}

/** Pokazywanie ukończonych (M9): ukryte / ukończone dziś / wszystkie. */
export const CompletedMode = z.enum(['hidden', 'today', 'all']);
export type CompletedMode = z.infer<typeof CompletedMode>;

export const isOpen = (task: Pick<ViewTask, 'status'>): boolean => task.status !== 'done' && task.status !== 'cancelled';

const inWorkspace = (ctx: ViewContext) => (task: ViewTask) => !ctx.workspaceId || task.workspaceId === ctx.workspaceId;

const completedOn = (task: ViewTask, ctx: ViewContext): LocalDate | null => (task.completedAt ? localDateAt(task.completedAt, ctx.timeZone) : null);

/** Widoczność zamkniętych zadań; otwarte przechodzą zawsze. */
export function withCompleted(tasks: readonly ViewTask[], mode: CompletedMode, ctx: ViewContext): ViewTask[] {
  if (mode === 'all') return [...tasks];
  return tasks.filter((t) => isOpen(t) || (mode === 'today' && completedOn(t, ctx) === ctx.today));
}

// ── Kolejność ────────────────────────────────────────────────────────────────────────────────

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byManual = (a: ViewTask, b: ViewTask) => byText(a.sortKey, b.sortKey) || byText(a.id, b.id);
/** Brak wartości na końcu. */
const nullsLast = <T extends string>(a: T | null, b: T | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : byText(a, b));

/** Kolejność w obrębie dnia (M9): najpierw z godziną według godziny, potem bez godziny według kolejności ręcznej. */
export const byDayOrder = (a: ViewTask, b: ViewTask): number => nullsLast(a.dueTime, b.dueTime) || byManual(a, b);

export const SortBy = z.enum(['manual', 'priority', 'due', 'created']);
export type SortBy = z.infer<typeof SortBy>;

const COMPARE: Record<SortBy, (a: ViewTask, b: ViewTask) => number> = {
  manual: byManual,
  priority: (a, b) => a.priority - b.priority || nullsLast(a.dueDate, b.dueDate) || byDayOrder(a, b),
  due: (a, b) => nullsLast(a.dueDate, b.dueDate) || nullsLast(a.dueTime, b.dueTime) || a.priority - b.priority || byManual(a, b),
  // Najnowsze na górze.
  created: (a, b) => byText(b.createdAt, a.createdAt) || byManual(a, b),
};

/** Sortowanie widoku listy (M9): ręczne / priorytet / termin / data dodania. Nie zmienia wejścia. */
export const sortTasks = (tasks: readonly ViewTask[], by: SortBy): ViewTask[] => [...tasks].sort(COMPARE[by]);

// ── Inbox i Dziś ─────────────────────────────────────────────────────────────────────────────

/** Otwarte zadania list `inbox` (bieżącej przestrzeni albo wszystkich), w kolejności ręcznej. */
export function selectInbox(tasks: readonly ViewTask[], inboxListIds: ReadonlySet<string>, ctx: ViewContext): ViewTask[] {
  return tasks.filter((t) => t.kind === 'task' && isOpen(t) && inboxListIds.has(t.listId) && inWorkspace(ctx)(t)).sort(byManual);
}

/** Czy nawyk ma dziś okres do odhaczenia: wystąpienie reguły albo trwająca seria z celem „N razy”. */
export function habitDueOn(task: Pick<ViewTask, 'recurrence' | 'habit'>, date: LocalDate): boolean {
  const rec = task.recurrence;
  if (rec?.mode !== 'schedule' || rec.anchor > date) return false;
  if (task.habit?.goal) return occurrences(rec, { from: date, limit: 1 }).length > 0;
  return occurrences(rec, { from: date, to: date, limit: 1 }).length > 0;
}

export interface TodayView {
  /** `due_date` < dziś, od najstarszego. */
  overdue: ViewTask[];
  /** `due_date` = dziś: z godziną według godziny, potem bez godziny według kolejności ręcznej. */
  today: ViewTask[];
  /** Zakres `start_date`–`due_date` obejmuje dziś, a termin jest później. */
  ongoing: ViewTask[];
  /** Nawyki z okresem na dziś (stan odhaczenia liczy `habits.ts`). */
  habits: ViewTask[];
  /** Zamknięte dziś (gdy `completed` ≠ `hidden`). */
  done: ViewTask[];
}

/** „Dziś” (M9). Seria cykliczna ma jeden wiersz — zaległa seria jest jednym zaległym zadaniem. */
export function selectToday(tasks: readonly ViewTask[], ctx: ViewContext, { completed = 'today' }: { completed?: CompletedMode } = {}): TodayView {
  const view: TodayView = { overdue: [], today: [], ongoing: [], habits: [], done: [] };
  const { today } = ctx;
  for (const t of tasks) {
    if (!inWorkspace(ctx)(t)) continue;
    if (t.kind === 'habit') {
      if (isOpen(t) && habitDueOn(t, today)) view.habits.push(t);
      continue;
    }
    if (!isOpen(t)) {
      if (completed !== 'hidden' && completedOn(t, ctx) === today) view.done.push(t);
      continue;
    }
    if (!t.dueDate) continue;
    if (t.dueDate < today) view.overdue.push(t);
    else if (t.dueDate === today) view.today.push(t);
    else if (t.startDate && t.startDate <= today) view.ongoing.push(t);
  }
  view.overdue.sort((a, b) => byText(a.dueDate!, b.dueDate!) || a.priority - b.priority || byDayOrder(a, b));
  view.today.sort(byDayOrder);
  view.ongoing.sort((a, b) => byText(a.dueDate!, b.dueDate!) || byManual(a, b));
  view.habits.sort(byDayOrder);
  view.done.sort((a, b) => byText(b.completedAt ?? '', a.completedAt ?? ''));
  return view;
}

// ── Nadchodzące ──────────────────────────────────────────────────────────────────────────────

export interface UpcomingItem {
  task: ViewTask;
  date: LocalDate;
  /** Przyszłe wystąpienie serii: tylko do odczytu, klik otwiera serię (M7). */
  virtual: boolean;
}

export interface UpcomingView {
  days: { date: LocalDate; items: UpcomingItem[] }[];
  /** Po oknie dni — tygodniami (od pierwszego dnia tygodnia z ustawień), bez wirtualnych wystąpień. */
  later: { weekStart: LocalDate; items: UpcomingItem[] }[];
}

const byItem = (a: UpcomingItem, b: UpcomingItem) => byText(a.date, b.date) || byDayOrder(a.task, b.task) || Number(a.virtual) - Number(b.virtual);

/**
 * „Nadchodzące” (M9): `days` dni od dziś, każdy dzień osobno (także pusty), potem „Później”.
 * Zaległe są w „Dziś”, nie tutaj. Wirtualne wystąpienia serii według harmonogramu zaczynają się
 * po późniejszej z dat: bieżący termin, dziś — tak jak `nextDue` przesuwa serię po ukończeniu.
 */
export function selectUpcoming(tasks: readonly ViewTask[], ctx: ViewContext, { days = 14 }: { days?: number } = {}): UpcomingView {
  const { today } = ctx;
  const last = addDays(today, days - 1);
  const byDay = new Map<LocalDate, UpcomingItem[]>();
  for (let d = today; d <= last; d = addDays(d, 1)) byDay.set(d, []);
  const later = new Map<LocalDate, UpcomingItem[]>();

  for (const task of tasks) {
    if (task.kind !== 'task' || !isOpen(task) || !task.dueDate || !inWorkspace(ctx)(task)) continue;
    if (task.dueDate >= today) {
      const item = { task, date: task.dueDate, virtual: false };
      if (task.dueDate <= last) byDay.get(task.dueDate)!.push(item);
      else {
        const week = weekStart(task.dueDate, ctx.firstDayOfWeek);
        later.set(week, [...(later.get(week) ?? []), item]);
      }
    }
    if (task.recurrence?.mode === 'schedule') {
      const from = addDays(task.dueDate > today ? task.dueDate : today, 1);
      for (const date of occurrences(task.recurrence, { from, to: last, limit: days })) byDay.get(date)!.push({ task, date, virtual: true });
    }
  }
  return {
    days: [...byDay].map(([date, items]) => ({ date, items: items.sort(byItem) })),
    later: [...later].sort(([a], [b]) => byText(a, b)).map(([weekStart, items]) => ({ weekStart, items: items.sort(byItem) })),
  };
}

// ── Filtry ───────────────────────────────────────────────────────────────────────────────────

/** Data w filtrze zapisanym: konkretna albo względem dnia oglądania (0 = dziś, 1 = jutro). */
export const RelativeDate = z.union([LocalDate, z.object({ offsetDays: z.number().int().min(-3660).max(3660) })]);
export type RelativeDate = z.infer<typeof RelativeDate>;

const ids = z.array(z.uuid()).min(1);

/** Definicja filtra (M4, `saved_filters.query`): warunki łączone przez „i”; brak pola = bez warunku. */
export const FilterQuery = z.object({
  tags: z.object({ ids, match: z.enum(['all', 'any']) }).optional(),
  priorities: z.array(Priority).min(1).optional(),
  lists: ids.optional(),
  workspaces: ids.optional(),
  statuses: z.array(TaskStatus).min(1).optional(),
  due: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('any') }),
      z.object({ kind: z.literal('range'), from: RelativeDate.optional(), to: RelativeDate.optional() }),
    ])
    .optional(),
  /** `true` = tylko z godziną, `false` = tylko całodniowe. */
  hasTime: z.boolean().optional(),
});
export type FilterQuery = z.infer<typeof FilterQuery>;

export const resolveDate = (date: RelativeDate, today: LocalDate): LocalDate => (typeof date === 'string' ? date : addDays(today, date.offsetDays));

/** Predykat filtra — do `tasks.filter(...)` i liczników zapisanych filtrów. */
export function matchesFilter(query: FilterQuery, today: LocalDate): (task: ViewTask) => boolean {
  const tagIds = query.tags && new Set(query.tags.ids);
  const due = query.due;
  const from = due?.kind === 'range' && due.from ? resolveDate(due.from, today) : null;
  const to = due?.kind === 'range' && due.to ? resolveDate(due.to, today) : null;
  return (t) => {
    if (tagIds && query.tags) {
      const hits = t.tagIds.filter((id) => tagIds.has(id)).length;
      if (query.tags.match === 'all' ? hits < tagIds.size : hits === 0) return false;
    }
    if (query.priorities && !query.priorities.includes(t.priority)) return false;
    if (query.lists && !query.lists.includes(t.listId)) return false;
    if (query.workspaces && !query.workspaces.includes(t.workspaceId)) return false;
    if (query.statuses && !query.statuses.includes(t.status)) return false;
    if (due?.kind === 'none' && t.dueDate) return false;
    if (due?.kind === 'any' && !t.dueDate) return false;
    if (due?.kind === 'range' && (!t.dueDate || (from && t.dueDate < from) || (to && t.dueDate > to))) return false;
    if (query.hasTime !== undefined && (t.dueTime !== null) !== query.hasTime) return false;
    return true;
  };
}

export const applyFilter = (tasks: readonly ViewTask[], query: FilterQuery, today: LocalDate): ViewTask[] => tasks.filter(matchesFilter(query, today));

/**
 * Widok tagu / zapisanego filtra (M4): zadania (bez nawyków) bieżącej przestrzeni pasujące do filtra;
 * bez warunku statusu — tylko otwarte. Te same wyniki liczą liczniki paska bocznego.
 */
export function selectFiltered(tasks: readonly ViewTask[], query: FilterQuery, ctx: ViewContext): ViewTask[] {
  const scoped = tasks.filter((t) => t.kind === 'task' && inWorkspace(ctx)(t));
  return applyFilter(query.statuses ? scoped : scoped.filter(isOpen), query, ctx.today);
}

/** Gotowe zakresy terminu w chipie „Termin” (daty względne — filtr zapisany działa każdego dnia). */
export const DUE_PRESETS = {
  overdue: { label: 'Zaległe', due: { kind: 'range', to: { offsetDays: -1 } } },
  today: { label: 'Do dziś', due: { kind: 'range', to: { offsetDays: 0 } } },
  tomorrow: { label: 'Jutro', due: { kind: 'range', from: { offsetDays: 1 }, to: { offsetDays: 1 } } },
  week: { label: 'Najbliższe 7 dni', due: { kind: 'range', from: { offsetDays: 0 }, to: { offsetDays: 6 } } },
  any: { label: 'Z terminem', due: { kind: 'any' } },
  none: { label: 'Bez terminu', due: { kind: 'none' } },
} as const satisfies Record<string, { label: string; due: NonNullable<FilterQuery['due']> }>;
export type DuePreset = keyof typeof DUE_PRESETS;

/** Który gotowy zakres to jest (do zaznaczenia w chipie); `null` — zakres własny. */
export function duePreset(due: FilterQuery['due']): DuePreset | null {
  if (!due) return null;
  const key = JSON.stringify(due);
  return (Object.keys(DUE_PRESETS) as DuePreset[]).find((k) => JSON.stringify(DUE_PRESETS[k].due) === key) ?? null;
}

const dateText = (d: RelativeDate) =>
  typeof d === 'string' ? shortDate(d) : d.offsetDays === 0 ? 'dziś' : d.offsetDays === 1 ? 'jutro' : d.offsetDays === -1 ? 'wczoraj' : d.offsetDays > 0 ? `dziś + ${d.offsetDays}` : `dziś − ${-d.offsetDays}`;

export interface FilterChip {
  /** Pole filtra (klik × usuwa ten warunek). */
  field: keyof FilterQuery;
  label: string;
}

/** Warunki filtra po polsku — chipy nad widokiem i opis zapisanego filtra. */
export function filterChips(query: FilterQuery, names: { lists?: ReadonlyMap<string, string>; workspaces?: ReadonlyMap<string, string>; tags?: ReadonlyMap<string, string> } = {}): FilterChip[] {
  const name = (map: ReadonlyMap<string, string> | undefined, ids: readonly string[]) => ids.map((id) => map?.get(id) ?? '?').join(', ');
  const chips: FilterChip[] = [];
  if (query.tags) chips.push({ field: 'tags', label: `${query.tags.ids.length > 1 ? (query.tags.match === 'all' ? 'Wszystkie tagi' : 'Dowolny tag') : 'Tag'}: ${name(names.tags, query.tags.ids)}` });
  if (query.priorities) chips.push({ field: 'priorities', label: `Priorytet: ${query.priorities.map((p) => PRIORITY[p].label.toLowerCase()).join(', ')}` });
  if (query.lists) chips.push({ field: 'lists', label: `Lista: ${name(names.lists, query.lists)}` });
  if (query.workspaces) chips.push({ field: 'workspaces', label: `Przestrzeń: ${name(names.workspaces, query.workspaces)}` });
  if (query.statuses) chips.push({ field: 'statuses', label: `Status: ${query.statuses.map((s) => TASK_STATUS[s].toLowerCase()).join(', ')}` });
  if (query.due) {
    const preset = duePreset(query.due);
    const label = preset
      ? DUE_PRESETS[preset].label
      : query.due.kind === 'range'
        ? [query.due.from && `od ${dateText(query.due.from)}`, query.due.to && `do ${dateText(query.due.to)}`].filter(Boolean).join(' ')
        : query.due.kind === 'none'
          ? 'Bez terminu'
          : 'Z terminem';
    chips.push({ field: 'due', label: `Termin: ${label}` });
  }
  if (query.hasTime !== undefined) chips.push({ field: 'hasTime', label: query.hasTime ? 'Z godziną' : 'Bez godziny' });
  return chips;
}

/** Filtr bez warunków (pusty obiekt) — widok bez filtrowania. */
export const isEmptyFilter = (query: FilterQuery): boolean => Object.values(query).every((v) => v === undefined);

// ── Grupowanie ───────────────────────────────────────────────────────────────────────────────

export const GroupBy = z.enum(['none', 'priority', 'list', 'date', 'tag', 'status']);
export type GroupBy = z.infer<typeof GroupBy>;

export interface TaskGroup {
  /** Wartość grupy (priorytet, id listy/tagu, data, status) albo `none` dla braku wartości. */
  key: string;
  label: string;
  tasks: ViewTask[];
}

/** Nazwy i kolejność list / tagów do grup; bez nich grupy idą w kolejności pierwszego wystąpienia. */
export interface GroupLookup {
  lists?: readonly { id: string; name: string; sortKey: string }[];
  tags?: readonly { id: string; name: string; sortKey: string }[];
}

const STATUS_ORDER = TaskStatus.options;

/**
 * Grupowanie (M9). Kolejność zadań w grupie = kolejność wejścia (najpierw `sortTasks`). Zadanie
 * z kilkoma tagami jest w każdej ich grupie; grupa „bez wartości” zawsze na końcu.
 */
export function groupTasks(tasks: readonly ViewTask[], by: GroupBy, lookup: GroupLookup = {}): TaskGroup[] {
  if (by === 'none') return [{ key: 'all', label: '', tasks: [...tasks] }];
  const groups = new Map<string, ViewTask[]>();
  const add = (key: string, task: ViewTask) => groups.set(key, [...(groups.get(key) ?? []), task]);
  for (const t of tasks) {
    if (by === 'priority') add(String(t.priority), t);
    else if (by === 'status') add(t.status, t);
    else if (by === 'list') add(t.listId, t);
    else if (by === 'date') add(t.dueDate ?? 'none', t);
    else if (t.tagIds.length) for (const id of t.tagIds) add(id, t);
    else add('none', t);
  }

  const named = by === 'list' ? lookup.lists : by === 'tag' ? lookup.tags : undefined;
  const meta = new Map(named?.map((n) => [n.id, n]));
  const label = (key: string): string => {
    if (by === 'priority') return PRIORITY[Number(key) as Priority].label;
    if (by === 'status') return TASK_STATUS[key as TaskStatus];
    if (key === 'none') return by === 'date' ? VIEW_SECTION.noDate : by === 'tag' ? VIEW_SECTION.noTag : VIEW_SECTION.noList;
    if (by === 'date') return dayLabel(key);
    return meta.get(key)?.name ?? key;
  };
  const rank = (key: string): string => {
    if (key === 'none') return '￿';
    if (by === 'status') return String(STATUS_ORDER.indexOf(key as TaskStatus));
    if (by === 'priority' || by === 'date') return key;
    return meta.get(key)?.sortKey ?? '￾';
  };
  const keys = [...groups.keys()];
  // Stabilne: listy/tagi bez metadanych zostają w kolejności pierwszego wystąpienia (za znanymi).
  keys.sort((a, b) => byText(rank(a), rank(b)));
  return keys.map((key) => ({ key, label: label(key), tasks: groups.get(key)! }));
}

// ── Drzewo podzadań ──────────────────────────────────────────────────────────────────────────

export interface TaskNode {
  task: ViewTask;
  depth: number;
  children: TaskNode[];
}

/**
 * Drzewo podzadań (M3) w kolejności ręcznej. Zadanie, którego rodzica nie ma na wejściu
 * (odfiltrowany, w innej liście), staje się korzeniem — nic nie znika z widoku.
 */
export function buildTree(tasks: readonly ViewTask[]): TaskNode[] {
  const present = new Set(tasks.map((t) => t.id));
  const children = new Map<string | null, ViewTask[]>();
  for (const t of tasks) {
    const parent = t.parentId && present.has(t.parentId) ? t.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), t]);
  }
  const build = (parent: string | null, depth: number): TaskNode[] =>
    (children.get(parent) ?? []).sort(byManual).map((task) => ({ task, depth, children: build(task.id, depth + 1) }));
  return build(null, 0);
}

/** Postęp rodzica (M3): ukończone / wszystkie bezpośrednie podzadania; anulowane się nie liczą. */
export function progress(node: TaskNode): { done: number; total: number } {
  const counted = node.children.filter((c) => c.task.status !== 'cancelled');
  return { done: counted.filter((c) => c.task.status === 'done').length, total: counted.length };
}

/** Drzewo → wiersze do wyświetlenia; podzadania zwiniętych węzłów są pomijane. */
export function flattenTree(nodes: readonly TaskNode[], collapsed: ReadonlySet<string> = new Set()): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (list: readonly TaskNode[]) => {
    for (const node of list) {
      out.push(node);
      if (!collapsed.has(node.task.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
