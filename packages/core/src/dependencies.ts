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
 * Przesunięcie zadania (albo kilku — pasek projektu) o `deltaDays` i — „Przesuń zależne” — wszystkich
 * następników (przechodnio) o tyle samo, więc odstępy między nimi zostają. Z `workdays` przesunięcie
 * liczy się w dniach roboczych. Zadania bez terminu nie mają paska i nie są przesuwane.
 */
export function shiftSuccessors(
  tasks: readonly ScheduledTask[],
  deps: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  taskId: string | readonly string[],
  deltaDays: number,
  { cascade = true, workdays }: { cascade?: boolean; workdays?: readonly number[] } = {},
): DateChange[] {
  if (deltaDays === 0) return [];
  const graph = successorsOf(deps);
  const roots = typeof taskId === 'string' ? [taskId] : [...taskId];
  const moved = new Set(roots);
  if (cascade) {
    for (const queue = [...roots]; queue.length; ) {
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

export interface CriticalPath {
  /**
   * Zapas zadania w dniach (roboczych, gdy podano `workdays`): o ile może skończyć się później, nie
   * przesuwając końca swojego projektu (ani — przez zależności — końca innych projektów). Zawsze ≥ 0:
   * zadanie już „za późno” (naruszenie, start w dniu końca poprzednika) ma zapas 0 i jest krytyczne.
   */
  float: Map<string, number>;
  /** Zadania na ścieżce krytycznej (bez zapasu). */
  tasks: Set<string>;
  /** Zależności na ścieżce: oba końce krytyczne i bez luzu (następnik zaczyna się najpóźniej dzień po poprzedniku + lag). */
  links: Set<string>;
  /** Koniec projektu (grupy) = najpóźniejszy koniec jego zadań. */
  ends: Map<string, LocalDate>;
}

/** Poniedziałek — punkt odniesienia numeracji dni roboczych. */
const EPOCH = '2000-01-03';

/** Numer dnia: liczba dni (roboczych z `work`) przed `date`; dzień wolny ma numer następnego roboczego. */
function dayPosition(date: LocalDate, work: ReadonlySet<number> | null): number {
  const n = daysBetween(EPOCH, date);
  if (!work) return n;
  const weeks = Math.floor(n / 7);
  let position = weeks * work.size;
  for (let i = 0; i < n - weeks * 7; i++) if (work.has(((i % 7) + 1) as number)) position++;
  return position;
}

/**
 * Ścieżka krytyczna na bieżącym planie (M12, v1.x): przejście wstecz od końca każdej grupy (projektu) po
 * zależnościach koniec→początek z opóźnieniem — najpóźniejszy dopuszczalny koniec zadania = min(koniec grupy,
 * najpóźniejszy początek każdego następnika − lag). Liczone w dniach (z `workdays` — tylko robocze, więc
 * piątek → poniedziałek nie daje zapasu); następnik bez luzu zaczyna się dzień po końcu poprzednika. Daty
 * zadań się nie zmieniają (to nie auto-planowanie): zapas mówi, ile dni zadanie może się spóźnić. Zadania bez
 * paska są pomijane, a zależność z takim zadaniem nie ogranicza; cykl (zablokowany przy zapisie) jest przerywany.
 */
export function criticalPath(
  tasks: readonly (ScheduledTask & { group: string })[],
  deps: readonly Dependency[],
  { workdays }: { workdays?: readonly number[] } = {},
): CriticalPath {
  const work = workdays?.length && workdays.length < 7 ? new Set(workdays) : null;
  // Pozycje: początek (włącznie) i koniec (wyłącznie) paska w numeracji dni.
  const at = new Map<string, { start: number; end: number; group: string }>();
  const groupEnd = new Map<string, number>();
  const ends = new Map<string, LocalDate>();
  for (const t of tasks) {
    const span = taskSpan(t);
    if (!span) continue;
    const pos = { start: dayPosition(span.start, work), end: dayPosition(addDays(span.end, 1), work), group: t.group };
    at.set(t.id, pos);
    groupEnd.set(t.group, Math.max(groupEnd.get(t.group) ?? -Infinity, pos.end));
    const end = ends.get(t.group);
    if (!end || span.end > end) ends.set(t.group, span.end);
  }
  const out = new Map<string, Dependency[]>();
  for (const d of deps) if (at.has(d.predecessorId) && at.has(d.successorId)) out.set(d.predecessorId, [...(out.get(d.predecessorId) ?? []), d]);

  const latestFinish = new Map<string, number>();
  const visiting = new Set<string>();
  const finishOf = (id: string): number => {
    const known = latestFinish.get(id);
    if (known !== undefined) return known;
    const pos = at.get(id)!;
    let finish = groupEnd.get(pos.group)!;
    visiting.add(id);
    for (const d of out.get(id) ?? []) {
      if (visiting.has(d.successorId)) continue;
      const s = at.get(d.successorId)!;
      finish = Math.min(finish, finishOf(d.successorId) - (s.end - s.start) - d.lagDays);
    }
    visiting.delete(id);
    latestFinish.set(id, finish);
    return finish;
  };

  const float = new Map<string, number>();
  const critical = new Set<string>();
  for (const [id, pos] of at) {
    const days = finishOf(id) - pos.end;
    float.set(id, Math.max(0, days));
    if (days <= 0) critical.add(id);
  }
  const links = new Set<string>();
  for (const list of out.values()) {
    for (const d of list) {
      if (critical.has(d.predecessorId) && critical.has(d.successorId) && at.get(d.successorId)!.start - (at.get(d.predecessorId)!.end + d.lagDays) <= 0) links.add(d.id);
    }
  }
  return { float, tasks: critical, links, ends };
}
