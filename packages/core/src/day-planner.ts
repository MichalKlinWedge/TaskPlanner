/**
 * Ułożenie dnia (v1.x): zadania na dziś i zaległe → bloki w wolnych oknach godzin pracy. Działa offline
 * i bez konta AI; „✨ Ułóż z AI” (`ai-day-plan.ts`) daje tylko inną propozycję godzin, którą sprawdza
 * `validateDayPlan`. Wynik to szkic — zapis dopiero po „Zastosuj” (`dayPlanOps`, jedna transakcja z „Cofnij”).
 *
 * Minuty jak w `Block` (od północy dnia, czas upływający), `start` / `end` — zegar ścienny.
 */
import { addDays, isoWeekday, localDateTimeAt, zonedInstant } from './dates.ts';
import type { Dependency } from './dependencies.ts';
import { compareCode } from './format.ts';
import type { LocalDate, LocalTime } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';
import { DEFAULT_BLOCK_MIN, freeSlots, scheduleBlockPatch, type Block, type DayPlan, type FreeSlot, type WorkHours } from './time-blocking.ts';
import { isOpen, type ViewTask } from './views.ts';

/** Przerwa między blokami, gdy użytkownik nie wybrał innej. */
export const DEFAULT_BUFFER_MIN = 10;
/** Przerwy do wyboru (minuty). */
export const BUFFER_CHOICES = [0, 5, 10, 15, 30] as const;
/** Siatka początków bloków. */
export const PLAN_STEP_MIN = 5;

export interface PlanCandidatesOptions {
  /** Układany dzień. */
  date: LocalDate;
  /** Dziś (zaległe = termin przed dziś); przy układaniu jutra inne niż `date`. */
  today: LocalDate;
  workspaceId?: string | null;
  /** Zadania z list tylko do odczytu nie dostają godziny. */
  canEdit?: (task: ViewTask) => boolean;
}

/**
 * Zadania do ułożenia: do zrobienia albo w trakcie, z terminem w tym dniu bez godziny albo zaległe (godzina
 * zaległego już minęła, więc nie wiąże). Bez nawyków, „Oczekuje” i list tylko do odczytu; rodzic odpada, gdy
 * do ułożenia są jego podzadania (czas liczyłby się dwa razy). Serie są pominięte (`series` = ile) — godzina
 * zmieniłaby każde następne wystąpienie.
 */
export function planCandidates(tasks: readonly ViewTask[], { date, today, workspaceId, canEdit = () => true }: PlanCandidatesOptions): { tasks: ViewTask[]; series: number } {
  const list = tasks.filter(
    (t) =>
      t.kind === 'task' &&
      (t.status === 'todo' || t.status === 'in_progress') &&
      (!workspaceId || t.workspaceId === workspaceId) &&
      t.dueDate !== null &&
      ((t.dueDate === date && !t.dueTime) || t.dueDate < today) &&
      canEdit(t),
  );
  const single = list.filter((t) => !t.recurrence);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const parents = new Set<string>();
  for (const t of single) for (let p = t.parentId; p && !parents.has(p); p = byId.get(p)?.parentId ?? null) parents.add(p);
  return { tasks: single.filter((t) => !parents.has(t.id)), series: list.length - single.length };
}

export interface PlannedBlock {
  taskId: string;
  startMin: number;
  endMin: number;
  start: LocalTime;
  end: LocalTime;
}

/** `no_slot` — brak wolnego okna; `dependency` — poprzednik nie skończy się na czas (albo następnik ma już godzinę);
 * `omitted` — brak w propozycji (AI). */
export type UnplacedReason = 'no_slot' | 'dependency' | 'omitted';

export interface DayPlanDraft {
  date: LocalDate;
  /** Od najwcześniejszego. */
  blocks: PlannedBlock[];
  /** „Nie zmieściło się”, w kolejności ważności. */
  unplaced: { taskId: string; reason: UnplacedReason }[];
  /** Pominięte serie. */
  series: number;
  /** `false` = dzień wolny od pracy (brak okien). */
  workday: boolean;
}

export interface AutoPlanOptions extends PlanCandidatesOptions {
  deps?: readonly Pick<Dependency, 'predecessorId' | 'successorId' | 'lagDays'>[];
  /** Minuta „teraz” układanego dnia — bloki nie zaczynają się wcześniej; `null` = cały dzień. */
  nowMin?: number | null;
  defaultDurationMin?: number;
  bufferMin?: number;
  timeZone?: string;
}

const clockMin = (time: LocalTime) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Minuta dnia → zegar ścienny. */
export function wallTimeAt(date: LocalDate, min: number, timeZone?: string): LocalTime {
  const start = zonedInstant(date, '00:00', timeZone).getTime();
  return localDateTimeAt(new Date(start + min * 60_000), timeZone).slice(11) as LocalTime;
}

/** Zegar ścienny → minuta dnia; `null`, gdy takiej godziny tego dnia nie ma (zmiana czasu). */
function minuteAt(date: LocalDate, time: LocalTime, timeZone?: string): number | null {
  const start = zonedInstant(date, '00:00', timeZone).getTime();
  const min = Math.round((zonedInstant(date, time, timeZone).getTime() - start) / 60_000);
  return wallTimeAt(date, min, timeZone) === time ? min : null;
}

const blockLength = (task: Pick<ViewTask, 'durationMin'>, defaultDurationMin = DEFAULT_BLOCK_MIN) => Math.max(5, Math.round(task.durationMin ?? defaultDurationMin));

/**
 * Okna, w których można układać: wolne w godzinach pracy, po „teraz”, z przerwą od zajętych bloków. Zajęte są
 * też wystąpienia serii i nawyki dni następnych (`virtual`) — przy układaniu jutra to one zajmą czas.
 */
export function planSlots(
  plan: Pick<DayPlan, 'date' | 'timed'>,
  work: WorkHours,
  { nowMin, bufferMin = DEFAULT_BUFFER_MIN, timeZone }: Pick<AutoPlanOptions, 'nowMin' | 'bufferMin' | 'timeZone'> = {},
): FreeSlot[] {
  const timed = plan.timed.filter((b) => !b.passive).map((b) => ({ ...b, virtual: false, startMin: b.startMin - bufferMin, endMin: b.endMin + bufferMin }));
  const from = nowMin == null ? -Infinity : Math.ceil(nowMin / PLAN_STEP_MIN) * PLAN_STEP_MIN;
  return freeSlots({ date: plan.date, timed }, work, { timeZone, minMinutes: PLAN_STEP_MIN })
    .map((s) => ({ startMin: Math.max(s.startMin, from), endMin: s.endMin }))
    .filter((s) => s.endMin - s.startMin >= PLAN_STEP_MIN);
}

interface Constraints {
  /** Następnik → poprzednicy też do ułożenia. */
  before: Map<string, Set<string>>;
  /** Poprzednik → następnicy też do ułożenia. */
  after: Map<string, Set<string>>;
  /** Koniec poprzednika, który ma już godzinę w tym dniu. */
  notBefore: Map<string, number>;
  /** Początek następnika, który ma już godzinę w tym dniu. */
  endBefore: Map<string, number>;
  /** Poprzednik kończy się po tym dniu (albo opóźnienie przesuwa początek dalej). */
  blocked: Set<string>;
}

/** Zależności przełożone na układany dzień; zależność rodzica obejmuje jego podzadania do ułożenia. */
function planConstraints(candidates: readonly ViewTask[], all: readonly ViewTask[], plan: Pick<DayPlan, 'date' | 'timed'>, deps: AutoPlanOptions['deps'] = []): Constraints {
  const out: Constraints = { before: new Map(), after: new Map(), notBefore: new Map(), endBefore: new Map(), blocked: new Set() };
  if (!deps.length || !candidates.length) return out;
  const byId = new Map(all.map((t) => [t.id, t]));
  const ids = new Set(candidates.map((t) => t.id));
  const under = new Map<string, string[]>();
  for (const t of candidates) for (let p = t.parentId; p; p = byId.get(p)?.parentId ?? null) under.set(p, [...(under.get(p) ?? []), t.id]);
  const expand = (id: string) => (ids.has(id) ? [id] : (under.get(id) ?? []));
  const fixed = new Map<string, Block>();
  for (const b of plan.timed) if (b.kind === 'task' && !b.passive && !b.virtual) fixed.set(b.id, b);
  const link = (map: Map<string, Set<string>>, key: string, value: string) => map.set(key, (map.get(key) ?? new Set()).add(value));

  for (const { predecessorId, successorId, lagDays } of deps) {
    // Ujemne opóźnienie = następnik może zacząć się wcześniej.
    if (lagDays < 0) continue;
    const predecessor = byId.get(predecessorId);
    const from = expand(predecessorId);
    const to = expand(successorId);
    for (const s of to) {
      for (const p of from) {
        if (p === s) continue;
        if (lagDays > 0) out.blocked.add(s);
        else {
          link(out.before, s, p);
          link(out.after, p, s);
        }
      }
      const block = fixed.get(predecessorId);
      if (!predecessor || !isOpen(predecessor) || (from.length && !block)) continue;
      if (block && lagDays === 0) out.notBefore.set(s, Math.max(out.notBefore.get(s) ?? -Infinity, block.endMin));
      else if (block || (predecessor.dueDate && addDays(predecessor.dueDate, lagDays) > plan.date)) out.blocked.add(s);
    }
    const successor = fixed.get(successorId);
    if (successor && lagDays === 0) for (const p of from) out.endBefore.set(p, Math.min(out.endBefore.get(p) ?? Infinity, successor.startMin));
  }
  return out;
}

/** Priorytet → termin → najczęściej przekładane → kolejność ręczna (remis: id). */
const byImportance = (a: ViewTask, b: ViewTask) =>
  a.priority - b.priority || compareCode(a.dueDate ?? '9', b.dueDate ?? '9') || b.postponeCount - a.postponeCount || compareCode(a.sortKey, b.sortKey) || compareCode(a.id, b.id);

/**
 * Kolejność układania: poprzednik przed następnikami, a wśród gotowych najważniejszy. Poprzednik liczy się
 * jak najważniejsze z zadań, które na niego czekają.
 */
function planOrder(candidates: readonly ViewTask[], { before, after }: Constraints): ViewTask[] {
  const byId = new Map(candidates.map((t) => [t.id, t]));
  const weight = new Map<string, ViewTask>();
  const strongest = (id: string, path: Set<string>): ViewTask => {
    const known = weight.get(id);
    if (known) return known;
    let best = byId.get(id)!;
    path.add(id);
    for (const s of after.get(id) ?? []) {
      if (path.has(s)) continue;
      const other = strongest(s, path);
      if (byImportance(other, best) < 0) best = other;
    }
    path.delete(id);
    weight.set(id, best);
    return best;
  };
  for (const t of candidates) strongest(t.id, new Set());
  const rest = [...candidates].sort((a, b) => byImportance(weight.get(a.id)!, weight.get(b.id)!) || byImportance(a, b));
  const out: ViewTask[] = [];
  const done = new Set<string>();
  while (rest.length) {
    const ready = rest.findIndex((t) => [...(before.get(t.id) ?? [])].every((p) => done.has(p)));
    // Cykl (zależności z dwóch urządzeń): byle jaka kolejność — i tak żadne z nich się nie ułoży.
    const [next] = rest.splice(Math.max(0, ready), 1);
    out.push(next!);
    done.add(next!.id);
  }
  return out;
}

const planned = (taskId: string, date: LocalDate, startMin: number, length: number, timeZone?: string): PlannedBlock => ({
  taskId,
  startMin,
  endMin: startMin + length,
  start: wallTimeAt(date, startMin, timeZone),
  end: wallTimeAt(date, startMin + length, timeZone),
});

const byStart = (a: PlannedBlock, b: PlannedBlock) => a.startMin - b.startMin || compareCode(a.taskId, b.taskId);

/** Deterministyczne układanie podanych zadań w oknach dnia. */
function place(candidates: readonly ViewTask[], tasks: readonly ViewTask[], plan: DayPlan, work: WorkHours, options: AutoPlanOptions): Pick<DayPlanDraft, 'blocks' | 'unplaced'> {
  const { bufferMin = DEFAULT_BUFFER_MIN, defaultDurationMin, timeZone } = options;
  const limits = planConstraints(candidates, tasks, plan, options.deps);
  const order = planOrder(candidates, limits);
  const byId = new Map(order.map((t) => [t.id, t]));
  const length = (id: string) => blockLength(byId.get(id)!, defaultDurationMin);

  // Najpóźniejszy koniec także dla poprzedników pośrednich (A → B → spotkanie o 14:00).
  const latest = new Map<string, number>();
  for (const task of [...order].reverse()) {
    let end = limits.endBefore.get(task.id) ?? Infinity;
    for (const s of limits.after.get(task.id) ?? []) end = Math.min(end, (latest.get(s) ?? Infinity) - length(s) - bufferMin);
    latest.set(task.id, end);
  }

  let free = planSlots(plan, work, options);
  const find = (size: number, from: number, to: number): number | null => {
    for (const slot of free) {
      for (let start = Math.ceil(Math.max(slot.startMin, from) / PLAN_STEP_MIN) * PLAN_STEP_MIN; start + size <= Math.min(slot.endMin, to); start += PLAN_STEP_MIN) {
        // Godzina powtórzona przy zmianie czasu wskazuje inną minutę — nie da się jej zapisać zegarem ściennym.
        if (minuteAt(plan.date, wallTimeAt(plan.date, start, timeZone), timeZone) === start) return start;
      }
    }
    return null;
  };

  const blocks = new Map<string, PlannedBlock>();
  const unplaced: DayPlanDraft['unplaced'] = [];
  for (const task of order) {
    const predecessors = [...(limits.before.get(task.id) ?? [])];
    if (limits.blocked.has(task.id) || predecessors.some((p) => !blocks.has(p))) {
      unplaced.push({ taskId: task.id, reason: 'dependency' });
      continue;
    }
    const size = length(task.id);
    const from = Math.max(limits.notBefore.get(task.id) ?? -Infinity, ...predecessors.map((p) => blocks.get(p)!.endMin + bufferMin));
    const start = find(size, from, latest.get(task.id)!);
    if (start === null) {
      unplaced.push({ taskId: task.id, reason: find(size, -Infinity, Infinity) === null ? 'no_slot' : 'dependency' });
      continue;
    }
    const block = planned(task.id, plan.date, start, size, timeZone);
    blocks.set(task.id, block);
    free = free
      .flatMap((s) => (block.startMin >= s.endMin || block.endMin <= s.startMin ? [s] : [{ startMin: s.startMin, endMin: block.startMin - bufferMin }, { startMin: block.endMin + bufferMin, endMin: s.endMin }]))
      .filter((s) => s.endMin - s.startMin >= PLAN_STEP_MIN);
  }
  return { blocks: [...blocks.values()].sort(byStart), unplaced };
}

/**
 * Ułożenie dnia bez AI: zadania z `planCandidates` od najważniejszego w najwcześniejsze pasujące okno, całe
 * (bez dzielenia), z przerwą między blokami; poprzednik zawsze przed następnikiem. `plan` = `blocksForDay`
 * tego dnia (zadania z godziną, wydarzenia, nawyki z porą).
 */
export function autoPlanDay(tasks: readonly ViewTask[], plan: DayPlan, work: WorkHours, options: AutoPlanOptions): DayPlanDraft {
  const { tasks: candidates, series } = planCandidates(tasks, options);
  return { date: plan.date, series, workday: work.days.includes(isoWeekday(plan.date)), ...place(candidates, tasks, plan, work, options) };
}

// ── Sprawdzenie propozycji (AI) ──────────────────────────────────────────────────────────────

/** Propozycja godziny (od AI). */
export interface PlanProposal {
  taskId: string;
  start: string;
}

export type PlanRejection = 'unknown' | 'duplicate' | 'time' | 'slot' | 'collision' | 'dependency';

export interface ValidatedDayPlan extends DayPlanDraft {
  rejected: { taskId: string; start: string; reason: PlanRejection }[];
}

/**
 * Sprawdzenie propozycji godzin: odpada zadanie spoza `planCandidates`, powtórzone, ze złą godziną (nie
 * `GG:MM` co 5 min, nieistniejącą w dniu zmiany czasu), poza wolnym oknem godzin pracy (albo przed „teraz”),
 * kolidujące z wcześniejszym blokiem i łamiące zależność. Kto odpadł za godzinę, kolizję albo zależność, jest
 * układany deterministycznie w tym, co zostało; zadania pominięte w propozycji zostają nieułożone.
 */
export function validateDayPlan(proposals: readonly PlanProposal[], tasks: readonly ViewTask[], plan: DayPlan, work: WorkHours, options: AutoPlanOptions): ValidatedDayPlan {
  const { defaultDurationMin, timeZone } = options;
  const { tasks: candidates, series } = planCandidates(tasks, options);
  const byId = new Map(candidates.map((t) => [t.id, t]));
  const limits = planConstraints(candidates, tasks, plan, options.deps);
  const slots = planSlots(plan, work, { ...options, bufferMin: 0 });
  const rejected: ValidatedDayPlan['rejected'] = [];
  const seen = new Set<string>();

  const proposed: PlannedBlock[] = [];
  for (const { taskId, start } of proposals) {
    const reject = (reason: PlanRejection) => void rejected.push({ taskId, start, reason });
    const task = byId.get(taskId);
    if (!task) reject('unknown');
    else if (seen.has(taskId)) reject('duplicate');
    else {
      seen.add(taskId);
      const min = /^([01]\d|2[0-3]):[0-5]\d$/.test(start) ? minuteAt(plan.date, start as LocalTime, timeZone) : null;
      if (min === null || min % PLAN_STEP_MIN) {
        reject('time');
        continue;
      }
      const block = planned(taskId, plan.date, min, blockLength(task, defaultDurationMin), timeZone);
      if (slots.some((s) => block.startMin >= s.startMin && block.endMin <= s.endMin)) proposed.push(block);
      else reject('slot');
    }
  }

  const accepted = new Map<string, PlannedBlock>();
  let cursor = -Infinity;
  for (const block of proposed.sort(byStart)) {
    if (block.startMin < cursor) rejected.push({ taskId: block.taskId, start: block.start, reason: 'collision' });
    else {
      accepted.set(block.taskId, block);
      cursor = block.endMin;
    }
  }

  const broken = (b: PlannedBlock, all: ReadonlyMap<string, PlannedBlock>) =>
    limits.blocked.has(b.taskId) ||
    b.startMin < (limits.notBefore.get(b.taskId) ?? -Infinity) ||
    b.endMin > (limits.endBefore.get(b.taskId) ?? Infinity) ||
    [...(limits.before.get(b.taskId) ?? [])].some((p) => (all.get(p)?.endMin ?? Infinity) > b.startMin);
  /** Usuwa bloki łamiące zależności; odrzucony poprzednik pociąga następników, więc do skutku. */
  const prune = (all: Map<string, PlannedBlock>, onDrop: (b: PlannedBlock) => void) => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const block of [...all.values()]) {
        if (!broken(block, all)) continue;
        all.delete(block.taskId);
        onDrop(block);
        changed = true;
      }
    }
  };
  prune(accepted, (b) => rejected.push({ taskId: b.taskId, start: b.start, reason: 'dependency' }));

  // Odrzucone za godzinę układamy w tym, co zostało; przyjęte bloki są już zajętością.
  const retry = candidates.filter((t) => seen.has(t.id) && !accepted.has(t.id) && !limits.blocked.has(t.id));
  const placed = place(retry, tasks, withDraft(plan, accepted.values(), byId, timeZone), work, options);
  const all = new Map([...accepted, ...placed.blocks.map((b) => [b.taskId, b] as const)]);
  const dropped = new Set<string>();
  prune(all, (b) => dropped.add(b.taskId));

  const reasons = new Map(placed.unplaced.map((u) => [u.taskId, u.reason]));
  const unplaced = planOrder(candidates, limits)
    .filter((t) => !all.has(t.id))
    .map((t) => ({ taskId: t.id, reason: limits.blocked.has(t.id) || dropped.has(t.id) ? ('dependency' as const) : seen.has(t.id) ? (reasons.get(t.id) ?? ('no_slot' as const)) : ('omitted' as const) }));
  return { date: plan.date, series, workday: work.days.includes(isoWeekday(plan.date)), blocks: [...all.values()].sort(byStart), unplaced, rejected };
}

// ── Podgląd i zapis ──────────────────────────────────────────────────────────────────────────

/** Plan dnia ze szkicem jako zwykłymi blokami (kolumny osi podglądu, ponowne układanie). */
export function withDraft(plan: DayPlan, blocks: Iterable<PlannedBlock>, tasks: ReadonlyMap<string, Pick<ViewTask, 'title'>>, timeZone?: string): DayPlan {
  const start = zonedInstant(plan.date, '00:00', timeZone).getTime();
  const iso = (min: number) => new Date(start + min * 60_000).toISOString();
  const added = [...blocks].map(
    (b): Block => ({ kind: 'task', id: b.taskId, title: tasks.get(b.taskId)?.title ?? '', startMin: b.startMin, endMin: b.endMin, startAt: iso(b.startMin), endAt: iso(b.endMin), passive: false }),
  );
  const ids = new Set(added.map((b) => b.id));
  const other = (item: { kind: string; id: string }) => item.kind !== 'task' || !ids.has(item.id);
  return {
    ...plan,
    timed: [...plan.timed.filter(other), ...added].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || compareCode(a.id, b.id)),
    allDay: plan.allDay.filter(other),
  };
}

/** Długość szkicu w minutach. */
export const draftMinutes = (draft: Pick<DayPlanDraft, 'blocks'>): number => draft.blocks.reduce((sum, b) => sum + b.endMin - b.startMin, 0);

/** Szkic bez bloku (✕ w podglądzie) — zadanie zostaje bez zmian. */
export const withoutBlock = <T extends DayPlanDraft>(draft: T, taskId: string): T => ({ ...draft, blocks: draft.blocks.filter((b) => b.taskId !== taskId) });

/**
 * „Zastosuj”: termin, godzina i czas bloków jednym `mutateMany`, z poprzednimi wartościami w `undo`. Zadania
 * zamknięte, usunięte albo zmienione w serię od ułożenia są pomijane.
 */
export function dayPlanOps(draft: Pick<DayPlanDraft, 'date' | 'blocks'>, tasks: readonly ViewTask[]): { ops: TaskOp[]; undo: TaskOp[]; count: number } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  for (const block of draft.blocks) {
    const task = byId.get(block.taskId);
    if (!task || task.kind !== 'task' || !isOpen(task) || task.recurrence) continue;
    const patch = scheduleBlockPatch(task, draft.date, clockMin(block.start), { durationMin: block.endMin - block.startMin });
    ops.push({ table: 'tasks', id: task.id, patch });
    undo.push({
      table: 'tasks',
      id: task.id,
      patch: { due_date: task.dueDate, due_time: task.dueTime, duration_min: task.durationMin, ...('start_date' in patch && { start_date: task.startDate }) },
    });
  }
  return { ops, undo, count: ops.length };
}

// ── Kontekst dla AI ──────────────────────────────────────────────────────────────────────────

/** Okna do układania jako zegar ścienny. */
export const slotTimes = (slots: readonly FreeSlot[], date: LocalDate, timeZone?: string): { start: LocalTime; end: LocalTime }[] =>
  slots.map((s) => ({ start: wallTimeAt(date, s.startMin, timeZone), end: wallTimeAt(date, s.endMin, timeZone) }));

export interface PlanTask {
  task: ViewTask;
  durationMin: number;
  /** Poprzednicy też do ułożenia. */
  after: string[];
  notBefore: LocalTime | null;
  endBefore: LocalTime | null;
}

/** Zadania do ułożenia z ograniczeniami tego dnia, w kolejności ważności; bez zablokowanych zależnością. */
export function planTasks(tasks: readonly ViewTask[], plan: DayPlan, options: AutoPlanOptions): PlanTask[] {
  const { tasks: candidates } = planCandidates(tasks, options);
  const limits = planConstraints(candidates, tasks, plan, options.deps);
  const wall = (min: number | undefined): LocalTime | null =>
    min === undefined ? null : min <= 0 ? ('00:00' as LocalTime) : min >= plan.dayMinutes ? ('23:59' as LocalTime) : wallTimeAt(plan.date, min, options.timeZone);
  return planOrder(candidates, limits)
    .filter((t) => !limits.blocked.has(t.id))
    .map((task) => ({
      task,
      durationMin: blockLength(task, options.defaultDurationMin),
      after: [...(limits.before.get(task.id) ?? [])].sort(compareCode),
      notBefore: wall(limits.notBefore.get(task.id)),
      endBefore: wall(limits.endBefore.get(task.id)),
    }));
}
