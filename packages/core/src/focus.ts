/**
 * Tryb skupienia i Pomodoro (SPECYFIKACJA M14, §7.7). Stan to znaczniki czasu, nie odliczanie
 * w pamięci: zamknięcie karty czy aplikacji niczego nie gubi, a drugie urządzenie po
 * synchronizacji liczy ten sam pozostały czas. Każde przejście zwraca operacje na `time_entries`
 * (otwórz / zamknij), które aplikacja zapisuje razem ze stanem.
 *
 * Pauza zamyka wpis, wznowienie otwiera nowy — suma wpisów = czas faktycznej pracy. Koniec pracy
 * sam zaczyna przerwę; koniec przerwy czeka na użytkownika (`ready`), żeby uśpione urządzenie
 * nie „przepracowało” kilku cykli.
 */
import { z } from 'zod';

import { addDays, weekStart, zonedInstant } from './dates.ts';
import { uuidv5, uuidv7 } from './ids.ts';
import { FOCUS_PHASE } from './labels.ts';
import type { LocalDate } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';

/** Część `profiles.settings`: długości etapów. */
export const FocusSettings = z.object({
  focusMin: z.number().int().min(1).max(180).default(25),
  shortBreakMin: z.number().int().min(1).max(60).default(5),
  longBreakMin: z.number().int().min(1).max(90).default(15),
  /** Długa przerwa po tylu etapach pracy. */
  longBreakEvery: z.number().int().min(1).max(12).default(4),
});
export type FocusSettings = z.infer<typeof FocusSettings>;
export const DEFAULT_FOCUS: FocusSettings = FocusSettings.parse({});

export const FocusPhase = z.enum(['idle', 'focus', 'short_break', 'long_break', 'ready', 'stopwatch']);
export type FocusPhase = z.infer<typeof FocusPhase>;

/** Stan timera (jeden na użytkownika, synchronizowany jak zwykłe pole). */
export const FocusState = z.object({
  phase: FocusPhase,
  taskId: z.string().nullable(),
  /** Początek bieżącego odcinka; `null` w pauzie i poza etapem. */
  segmentStartedAt: z.iso.datetime().nullable(),
  /** Czas etapu zużyty przed bieżącym odcinkiem (pauzy dzielą etap na odcinki). */
  elapsedMs: z.number().int().min(0),
  paused: z.boolean(),
  /** Ukończone etapy pracy w tej serii — do długiej przerwy i `pomodoro_index`. */
  completedFocus: z.number().int().min(0),
  /** Otwarty wpis `time_entries`. */
  entryId: z.string().nullable(),
});
export type FocusState = z.infer<typeof FocusState>;

export const FOCUS_IDLE: FocusState = { phase: 'idle', taskId: null, segmentStartedAt: null, elapsedMs: 0, paused: false, completedFocus: 0, entryId: null };

export type EntryOp =
  | { op: 'open'; id: string; taskId: string | null; kind: 'focus' | 'break'; startedAt: string; pomodoroIndex: number | null }
  | { op: 'close'; id: string; endedAt: string };

export interface FocusStep {
  state: FocusState;
  entries: EntryOp[];
}

/** Id nowego wpisu; dostaje etap i początek — `focusEntryId` liczy z nich id deterministyczne. */
type NewId = (phase: FocusPhase, startedAt: string) => string;
const iso = (ms: number) => new Date(ms).toISOString();
const isBreak = (phase: FocusPhase) => phase === 'short_break' || phase === 'long_break';
const isRunning = (s: FocusState) => s.phase === 'focus' || s.phase === 'stopwatch' || isBreak(s.phase);

/** Długość etapu w ms; `null` = bez limitu (stoper) albo poza etapem. */
export function phaseMs(phase: FocusPhase, settings: FocusSettings = DEFAULT_FOCUS): number | null {
  const min = phase === 'focus' ? settings.focusMin : phase === 'short_break' ? settings.shortBreakMin : phase === 'long_break' ? settings.longBreakMin : null;
  return min === null ? null : min * 60_000;
}

/** Czas bieżącego etapu (bez pauz). */
export const focusElapsed = (state: FocusState, now: Date): number =>
  state.elapsedMs + (state.segmentStartedAt && !state.paused ? Math.max(0, now.getTime() - Date.parse(state.segmentStartedAt)) : 0);

/** Pozostały czas etapu; `null` dla stopera i poza etapem. */
export function focusRemaining(state: FocusState, now: Date, settings: FocusSettings = DEFAULT_FOCUS): number | null {
  const total = isRunning(state) ? phaseMs(state.phase, settings) : null;
  return total === null ? null : Math.max(0, total - focusElapsed(state, now));
}

/** Chwila końca etapu — do zaplanowania powiadomienia; `null` w pauzie, dla stopera i poza etapem. */
export function phaseEndsAt(state: FocusState, settings: FocusSettings = DEFAULT_FOCUS): Date | null {
  const total = phaseMs(state.phase, settings);
  if (total === null || state.paused || !state.segmentStartedAt) return null;
  return new Date(Date.parse(state.segmentStartedAt) + total - state.elapsedMs);
}

const open = (state: FocusState, phase: FocusPhase, at: number, newId: NewId): FocusStep => {
  const id = newId(phase, iso(at));
  const focus = phase === 'focus' || phase === 'stopwatch';
  return {
    state: { ...state, phase, segmentStartedAt: iso(at), elapsedMs: 0, paused: false, entryId: id },
    entries: [
      {
        op: 'open',
        id,
        taskId: state.taskId,
        kind: focus ? 'focus' : 'break',
        startedAt: iso(at),
        pomodoroIndex: phase === 'focus' ? state.completedFocus + 1 : phase === 'stopwatch' ? null : state.completedFocus,
      },
    ],
  };
};

const close = (state: FocusState, at: number): EntryOp[] => (state.entryId ? [{ op: 'close', id: state.entryId, endedAt: iso(at) }] : []);

/**
 * Start pracy nad zadaniem (albo bez zadania). Z `ready` seria trwa dalej (licznik do długiej
 * przerwy zostaje); trwający etap jest najpierw zamykany.
 */
export function startFocus(state: FocusState, { taskId, mode = 'pomodoro', now, newId = () => uuidv7() }: { taskId: string | null; mode?: 'pomodoro' | 'stopwatch'; now: Date; newId?: NewId }): FocusStep {
  const at = now.getTime();
  const entries = close(state, at);
  const base: FocusState = { ...FOCUS_IDLE, taskId, completedFocus: state.phase === 'ready' || isBreak(state.phase) ? state.completedFocus : 0 };
  const step = open(base, mode === 'stopwatch' ? 'stopwatch' : 'focus', at, newId);
  return { state: step.state, entries: [...entries, ...step.entries] };
}

export function pauseFocus(state: FocusState, now: Date): FocusStep {
  if (!isRunning(state) || state.paused) return { state, entries: [] };
  return { state: { ...state, elapsedMs: focusElapsed(state, now), segmentStartedAt: null, paused: true, entryId: null }, entries: close(state, now.getTime()) };
}

export function resumeFocus(state: FocusState, now: Date, newId: NewId = () => uuidv7()): FocusStep {
  if (!state.paused) return { state, entries: [] };
  const { state: next, entries } = open(state, state.phase, now.getTime(), newId);
  return { state: { ...next, elapsedMs: state.elapsedMs }, entries };
}

/** Stop: zamyka wpis, seria się kończy. */
export const stopFocus = (state: FocusState, now: Date): FocusStep => ({ state: FOCUS_IDLE, entries: close(state, now.getTime()) });

/** Przejście po etapie, który skończył się w chwili `at`. */
function finish(state: FocusState, at: number, settings: FocusSettings, newId: NewId): FocusStep {
  const entries = close(state, at);
  if (state.phase === 'focus') {
    const completedFocus = state.completedFocus + 1;
    const phase = completedFocus % settings.longBreakEvery === 0 ? 'long_break' : 'short_break';
    const step = open({ ...state, completedFocus }, phase, at, newId);
    return { state: step.state, entries: [...entries, ...step.entries] };
  }
  return { state: { ...state, phase: 'ready', segmentStartedAt: null, elapsedMs: 0, paused: false, entryId: null }, entries };
}

/**
 * Doliczenie upływu czasu (przy starcie aplikacji, po synchronizacji, co sekundę na ekranie):
 * etap, który się skończył, zamyka się w chwili swojego końca, nie „teraz”.
 */
export function advanceFocus(state: FocusState, now: Date, { settings = DEFAULT_FOCUS, newId = () => uuidv7() }: { settings?: FocusSettings; newId?: NewId } = {}): FocusStep {
  let current: FocusStep = { state, entries: [] };
  for (let end = phaseEndsAt(current.state, settings); end && end.getTime() <= now.getTime(); end = phaseEndsAt(current.state, settings)) {
    const step = finish(current.state, end.getTime(), settings, newId);
    current = { state: step.state, entries: [...current.entries, ...step.entries] };
  }
  return current;
}

/** Treść powiadomienia o końcu etapu (web i Web Push z serwera). */
export const focusEndText = (finished: FocusPhase, next: FocusState): { title: string; body: string } =>
  finished === 'focus' ? { title: 'Koniec pracy', body: `${FOCUS_PHASE[next.phase]} — odpocznij.` } : { title: 'Koniec przerwy', body: 'Wróć do pracy, kiedy zechcesz.' };

export interface FocusEndPush {
  /** Jedna wysyłka na odcinek: `<id wpisu>:focus` (wznowienie po pauzie = nowy wpis). */
  key: string;
  endsAt: string;
  taskId: string | null;
  title: string;
  body: string;
}

/**
 * Koniec bieżącego etapu w oknie `[from, to]` — do Web Push z serwera (`reminders-push`), kiedy żadna
 * karta nie jest otwarta (otwarta karta przechodzi dalej sama i pokazuje dźwięk / powiadomienie).
 */
export function focusEndPush(state: FocusState, settings: FocusSettings, { from, to }: { from: Date; to: Date }): FocusEndPush | null {
  const end = phaseEndsAt(state, settings);
  if (!end || !state.entryId || end.getTime() < from.getTime() || end.getTime() > to.getTime()) return null;
  const next = advanceFocus(state, end, { settings, newId: () => 'next' }).state;
  return { key: `${state.entryId}:focus`, endsAt: end.toISOString(), taskId: state.taskId, ...focusEndText(state.phase, next) };
}

/** „Pomiń”: koniec etapu teraz (praca liczy się jako ukończona, przerwa przechodzi w `ready`). */
export function skipPhase(state: FocusState, now: Date, { settings = DEFAULT_FOCUS, newId = () => uuidv7() }: { settings?: FocusSettings; newId?: NewId } = {}): FocusStep {
  if (!isRunning(state) || state.phase === 'stopwatch') return { state, entries: [] };
  return finish(state.paused ? { ...state, entryId: null } : state, now.getTime(), settings, newId);
}

export interface TimeEntryLike {
  taskId: string | null;
  kind: 'focus' | 'break' | 'manual';
  startedAt: string;
  endedAt: string | null;
}

/**
 * Minuty pracy (wpisy `focus` i `manual`) — „spędzono 1 h 20 min” i statystyki tygodnia. Otwarty
 * wpis liczy się do `now`; wpis na granicy okresu — tylko jego część w okresie.
 */
export function focusMinutes(entries: readonly TimeEntryLike[], now: Date, { taskId, from, to }: { taskId?: string; from?: Date; to?: Date } = {}): number {
  let ms = 0;
  for (const e of entries) {
    if (e.kind === 'break' || (taskId !== undefined && e.taskId !== taskId)) continue;
    const start = Math.max(Date.parse(e.startedAt), from?.getTime() ?? -Infinity);
    const end = Math.min(e.endedAt ? Date.parse(e.endedAt) : now.getTime(), to?.getTime() ?? Infinity);
    if (end > start) ms += end - start;
  }
  return Math.round(ms / 60_000);
}

// ── Zapis i stan w aplikacji (Etap 7) ────────────────────────────────────────────────────────

/**
 * Id wpisu deterministyczne (UUIDv5 z użytkownika, etapu i początku): dwa urządzenia (albo karty),
 * które naraz doliczają koniec etapu w `advanceFocus`, otwierają ten sam wpis przerwy, a nie dwa.
 */
export const focusEntryId =
  (userId: string): NewId =>
  (phase, startedAt) =>
    uuidv5(`focus:${userId}:${phase}:${startedAt}`);

/** Stan z kolumny `profiles.focus` (tekst JSON albo obiekt); brak albo błąd = `idle`. */
export function parseFocusState(value: unknown): FocusState {
  let raw = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value);
    } catch {
      return FOCUS_IDLE;
    }
  }
  const parsed = FocusState.safeParse(raw ?? undefined);
  return parsed.success ? parsed.data : FOCUS_IDLE;
}

export const isFocusActive = (state: FocusState): boolean => state.phase !== 'idle';

/** Przejście → operacje do `mutateMany`: wpisy `time_entries` i stan w profilu (jedna transakcja). */
export function focusStepOps(userId: string, step: FocusStep): TaskOp[] {
  const ops: TaskOp[] = step.entries.map((e) =>
    e.op === 'open'
      ? { table: 'time_entries', id: e.id, patch: { task_id: e.taskId, kind: e.kind, started_at: e.startedAt, ended_at: null, pomodoro_index: e.pomodoroIndex } }
      : { table: 'time_entries', id: e.id, patch: { ended_at: e.endedAt } },
  );
  ops.push({ table: 'profiles', id: userId, patch: { focus: step.state.phase === 'idle' ? null : step.state } });
  return ops;
}

export interface TimeEntryRecord extends TimeEntryLike {
  id: string;
  pomodoroIndex: number | null;
}

/** Po tylu ms otwarty wpis spoza stanu uznaje się za porzucony (synchronizacja dowozi stan i wpis razem). */
const ORPHAN_GRACE_MS = 2 * 60_000;

/**
 * Otwarte wpisy, których nie wskazuje stan timera — zostają, gdy dwa urządzenia naraz zmieniły
 * timer (stan wygrywa ostatni, wpis przegranego zostaje otwarty i liczyłby się bez końca).
 * Zamknięcie: w chwili startu wygrywającego odcinka, jeśli był później, inaczej po długości etapu
 * (stoper — teraz), nigdy po `now`.
 */
export function orphanEntryOps(entries: readonly TimeEntryRecord[], state: FocusState, now: Date, settings: FocusSettings = DEFAULT_FOCUS): TaskOp[] {
  const ops: TaskOp[] = [];
  const current = state.segmentStartedAt ? Date.parse(state.segmentStartedAt) : null;
  for (const e of entries) {
    if (e.endedAt || e.kind === 'manual' || e.id === state.entryId) continue;
    const start = Date.parse(e.startedAt);
    if (now.getTime() - start < ORPHAN_GRACE_MS) continue;
    const length = e.kind === 'break' ? settings.longBreakMin * 60_000 : e.pomodoroIndex === null ? null : settings.focusMin * 60_000;
    const end = current !== null && current > start ? current : length === null ? now.getTime() : start + length;
    ops.push({ table: 'time_entries', id: e.id, patch: { ended_at: iso(Math.min(end, now.getTime())) } });
  }
  return ops;
}

/** Ręczny wpis pracy kończący się teraz („Dodaj czas”); poza 1–1440 min — nic. */
export function manualEntryOps(taskId: string, minutes: number, now: Date, newId: () => string = uuidv7): TaskOp[] {
  const min = Math.round(minutes);
  if (!Number.isFinite(min) || min < 1 || min > 24 * 60) return [];
  return [{ table: 'time_entries', id: newId(), patch: { task_id: taskId, kind: 'manual', started_at: iso(now.getTime() - min * 60_000), ended_at: iso(now.getTime()), pomodoro_index: null } }];
}

export interface FocusTaskInfo {
  id: string;
  listId: string;
  workspaceId: string;
}

export interface FocusBucket {
  /** `null` = wpisy bez zadania. */
  id: string | null;
  minutes: number;
}

export interface FocusWeek {
  /** Pierwszy dzień tygodnia. */
  from: LocalDate;
  days: { date: LocalDate; minutes: number }[];
  total: number;
  /** Etapy pracy Pomodoro, po których zaczęła się przerwa (koniec etapu albo „Pomiń”). */
  pomodoros: number;
  /** Malejąco po minutach (przy remisie „bez zadania” na końcu). */
  byWorkspace: FocusBucket[];
  byList: FocusBucket[];
  byTask: FocusBucket[];
}

/**
 * Statystyki tygodnia (M14): minuty pracy (wpisy `focus` i `manual`) na dzień, przestrzeń, listę /
 * projekt i zadanie. Dni w strefie użytkownika; wpis przez północ dzieli się między dni.
 */
export function focusWeek(
  entries: readonly TimeEntryRecord[],
  tasks: readonly FocusTaskInfo[],
  { today, firstDayOfWeek = 1, timeZone, now }: { today: LocalDate; firstDayOfWeek?: number; timeZone?: string; now: Date },
): FocusWeek {
  const from = weekStart(today, firstDayOfWeek);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const bounds = [...dates, addDays(from, 7)].map((d) => zonedInstant(d, '00:00', timeZone));
  const start = bounds[0]!;
  const end = bounds[7]!;
  const work = entries.filter((e) => e.kind !== 'break');
  const days = dates.map((date, i) => ({ date, minutes: focusMinutes(work, now, { from: bounds[i], to: bounds[i + 1] }) }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sums = { workspace: new Map<string | null, number>(), list: new Map<string | null, number>(), task: new Map<string | null, number>() };
  const add = (map: Map<string | null, number>, key: string | null, min: number) => map.set(key, (map.get(key) ?? 0) + min);
  for (const e of work) {
    const min = focusMinutes([e], now, { from: start, to: end });
    if (min <= 0) continue;
    const task = e.taskId ? byId.get(e.taskId) : undefined;
    add(sums.workspace, task?.workspaceId ?? null, min);
    add(sums.list, task?.listId ?? null, min);
    add(sums.task, e.taskId ?? null, min);
  }
  // Etap dzielony pauzami = kilka wpisów; liczy się ten, po którym (w tej samej chwili) zaczęła się przerwa.
  const breaks = new Set(entries.filter((e) => e.kind === 'break').map((e) => `${e.taskId}|${Date.parse(e.startedAt)}`));
  let pomodoros = 0;
  for (const e of work) {
    if (e.kind !== 'focus' || e.pomodoroIndex === null || !e.endedAt) continue;
    const ended = Date.parse(e.endedAt);
    if (ended >= start.getTime() && ended < end.getTime() && breaks.has(`${e.taskId}|${ended}`)) pomodoros++;
  }
  const sorted = (map: Map<string | null, number>): FocusBucket[] => [...map].map(([id, minutes]) => ({ id, minutes })).sort((a, b) => b.minutes - a.minutes || Number(a.id === null) - Number(b.id === null));
  return { from, days, total: days.reduce((n, d) => n + d.minutes, 0), pomodoros, byWorkspace: sorted(sums.workspace), byList: sorted(sums.list), byTask: sorted(sums.task) };
}
