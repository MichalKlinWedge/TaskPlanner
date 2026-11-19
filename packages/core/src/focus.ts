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

import { uuidv7 } from './ids.ts';

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

type NewId = () => string;
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
  const id = newId();
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
export function startFocus(state: FocusState, { taskId, mode = 'pomodoro', now, newId = uuidv7 }: { taskId: string | null; mode?: 'pomodoro' | 'stopwatch'; now: Date; newId?: NewId }): FocusStep {
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

export function resumeFocus(state: FocusState, now: Date, newId: NewId = uuidv7): FocusStep {
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
export function advanceFocus(state: FocusState, now: Date, { settings = DEFAULT_FOCUS, newId = uuidv7 }: { settings?: FocusSettings; newId?: NewId } = {}): FocusStep {
  let current: FocusStep = { state, entries: [] };
  for (let end = phaseEndsAt(current.state, settings); end && end.getTime() <= now.getTime(); end = phaseEndsAt(current.state, settings)) {
    const step = finish(current.state, end.getTime(), settings, newId);
    current = { state: step.state, entries: [...current.entries, ...step.entries] };
  }
  return current;
}

/** „Pomiń”: koniec etapu teraz (praca liczy się jako ukończona, przerwa przechodzi w `ready`). */
export function skipPhase(state: FocusState, now: Date, { settings = DEFAULT_FOCUS, newId = uuidv7 }: { settings?: FocusSettings; newId?: NewId } = {}): FocusStep {
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
