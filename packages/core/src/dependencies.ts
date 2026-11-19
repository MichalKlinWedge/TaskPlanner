/**
 * Zależności i oś czasu (SPECYFIKACJA M12, §7.3): koniec→początek z opóźnieniem w dniach.
 * Cykl jest blokowany przy tworzeniu (tu) i w triggerze; SVAR Gantt sam cykli nie pilnuje
 * (POC_WYNIKI, PoC-5), więc widok woła `detectCycle` przed zapisem.
 *
 * Granulacja: dni. Początek = `start_date ?? due_date`; koniec = `due_date`, a przy godzinie
 * i czasie trwania — dzień, w którym zadanie się kończy. Naruszenie: B zaczyna się przed
 * końcem A + `lag_days` (B może zacząć się w dniu, w którym A się kończy, gdy lag = 0).
 */
import { addDays, addWorkdays, daysBetween } from './dates.ts';
import type { LocalDate, LocalTime } from './schemas/primitives.ts';

export interface Dependency {
  id: string;
  predecessorId: string;
  successorId: string;
  lagDays: number;
}

export interface ScheduledTask {
  id: string;
  startDate: LocalDate | null;
  dueDate: LocalDate | null;
  dueTime: LocalTime | null;
  durationMin: number | null;
}

export interface Span {
  start: LocalDate;
  end: LocalDate;
}

/** Zakres zadania na osi czasu; bez terminu — brak paska. */
export function taskSpan(task: ScheduledTask): Span | null {
  if (!task.dueDate) return null;
  let end = task.dueDate;
  if (task.dueTime && task.durationMin) {
    const [h, m] = task.dueTime.split(':').map(Number) as [number, number];
    // Koniec dokładnie o północy należy jeszcze do dnia rozpoczęcia.
    end = addDays(task.dueDate, Math.floor((h * 60 + m + task.durationMin - 1) / 1440));
  }
  const start = task.startDate && task.startDate < end ? task.startDate : task.dueDate;
  return { start, end };
}

const successorsOf = (deps: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[]) => {
  const out = new Map<string, string[]>();
  for (const d of deps) out.set(d.predecessorId, [...(out.get(d.predecessorId) ?? []), d.successorId]);
  return out;
};

/**
 * Czy nowa zależność zamyka cykl. Zwraca cykl jako ścieżkę id (`[A, B, …, A]`) albo `null`.
 * Zależność zadania od samego siebie też jest cyklem.
 */
export function detectCycle(deps: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[], next: Pick<Dependency, 'predecessorId' | 'successorId'>): string[] | null {
  if (next.predecessorId === next.successorId) return [next.predecessorId, next.successorId];
  const graph = successorsOf(deps);
  // Ścieżka od następnika z powrotem do poprzednika = cykl po dodaniu krawędzi.
  const parent = new Map<string, string>();
  const queue = [next.successorId];
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === next.predecessorId) {
      const path = [id];
      for (let p = parent.get(id); p !== undefined; p = parent.get(p)) path.unshift(p);
      return [next.predecessorId, ...path];
    }
    for (const s of graph.get(id) ?? []) {
      if (seen.has(s)) continue;
      seen.add(s);
      parent.set(s, id);
      queue.push(s);
    }
  }
  return null;
}

export interface Violation {
  dependency: Dependency;
  /** Najwcześniejszy dopuszczalny początek następnika. */
  earliestStart: LocalDate;
  /** Początek następnika teraz. */
  start: LocalDate;
  /** O ile dni za wcześnie. */
  days: number;
}

/** Naruszenia kolejności (czerwone strzałki i lista naruszeń). Zależności bez obu dat są pomijane. */
export function violations(tasks: readonly ScheduledTask[], deps: readonly Dependency[]): Violation[] {
  const spans = new Map(tasks.map((t) => [t.id, taskSpan(t)]));
  const out: Violation[] = [];
  for (const dependency of deps) {
    const a = spans.get(dependency.predecessorId);
    const b = spans.get(dependency.successorId);
    if (!a || !b) continue;
    const earliestStart = addDays(a.end, dependency.lagDays);
    if (b.start < earliestStart) out.push({ dependency, earliestStart, start: b.start, days: daysBetween(b.start, earliestStart) });
  }
  return out;
}

export interface DateChange {
  id: string;
  startDate: LocalDate | null;
  dueDate: LocalDate;
}

/**
 * Przesunięcie zadania o `deltaDays` i — „Przesuń zależne” — wszystkich jego następników
 * (przechodnio) o tyle samo, więc odstępy między nimi zostają. Z `workdays` przesunięcie liczy się
 * w dniach roboczych. Zadania bez terminu nie mają paska i nie są przesuwane.
 */
export function shiftSuccessors(
  tasks: readonly ScheduledTask[],
  deps: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  taskId: string,
  deltaDays: number,
  { cascade = true, workdays }: { cascade?: boolean; workdays?: readonly number[] } = {},
): DateChange[] {
  if (deltaDays === 0) return [];
  const graph = successorsOf(deps);
  const moved = new Set([taskId]);
  if (cascade) {
    for (const queue = [taskId]; queue.length; ) {
      for (const s of graph.get(queue.shift()!) ?? []) {
        if (!moved.has(s)) {
          moved.add(s);
          queue.push(s);
        }
      }
    }
  }
  const shift = (date: LocalDate) => (workdays ? addWorkdays(date, deltaDays, workdays) : addDays(date, deltaDays));
  return tasks
    .filter((t) => moved.has(t.id) && t.dueDate)
    .map((t) => ({ id: t.id, startDate: t.startDate && shift(t.startDate), dueDate: shift(t.dueDate!) }));
}

/** Pasek projektu: daty projektu, a brakujące — z zakresu jego zadań. */
export function projectSpan(project: { startDate: LocalDate | null; endDate: LocalDate | null }, tasks: readonly ScheduledTask[]): Span | null {
  let start = project.startDate;
  let end = project.endDate;
  if (!start || !end) {
    for (const span of tasks.map(taskSpan)) {
      if (!span) continue;
      if (!project.startDate && (!start || span.start < start)) start = span.start;
      if (!project.endDate && (!end || span.end > end)) end = span.end;
    }
  }
  if (!start && !end) return null;
  return { start: start ?? end!, end: end ?? start! };
}
