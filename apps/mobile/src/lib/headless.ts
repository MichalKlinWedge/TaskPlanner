/**
 * Operacje bez ekranu — widżet, akcje z powiadomień, zadanie w tle. Te same reguły z core co na
 * ekranach (`completeTaskOps`, `bulkTaskOps`, `reopenTaskPatch`, `habitEntryOps`, `focusStepOps`);
 * akcje czytają tylko swoje zadanie (`loadTask`), bo w tle liczy się każda sekunda.
 * Każda operacja jest idempotentna: powtórzona (dwa wywołania tej samej akcji) nic nie psuje.
 */
import {
  advanceFocus,
  bulkTaskOps,
  completeTaskOps,
  descendants,
  focusEntryId,
  focusStepOps,
  habitEntryOps,
  isOpen,
  localDateAt,
  parseFocusState,
  pauseFocus,
  reopenTaskPatch,
  resumeFocus,
  skipPhase,
  startFocus,
  stopFocus,
  toHabit,
  sameHabitEntry,
  toHabitCompletion,
  type FocusSettings,
  type FocusState,
  type FocusStep,
  type HabitEntry,
  type LocalDate,
  type ProfileSettings,
  type TaskOp,
  type ViewTask,
} from '@taskplanner/core';
import type { SqlRow } from '@taskplanner/sync';

import { loadTask, parseSettings, sharedAppData, type AppData } from './app-data';
import { serverConfig, sessionUser } from './config';
import { localEngine, mutateMany, syncNow } from './sync';

/** Zapis operacji core w jednej transakcji (wiersze + outbox, jedno odświeżenie widoków). */
export const applyOps = (ops: readonly TaskOp[]) => mutateMany(ops);

/**
 * Wysyłka od razu po operacji bez ekranu. `mutate` planuje ją timerem, a timery JS stoją, gdy
 * aplikacja jest w tle — bez tego zmiana z powiadomienia czy widżetu czekałaby do otwarcia aplikacji.
 * Bez sieci (albo bez konta) nic nie robi: zmiana zostaje w outboksie.
 */
export async function pushNow(): Promise<void> {
  if (!sessionUser().online || !serverConfig()) return;
  await syncNow().catch(() => undefined);
}

/** Dane jak dla ekranów; w procesie z ekranami — wspólny wynik magazynu (`sharedAppData`). */
export const headlessData = async (): Promise<AppData> => sharedAppData(await localEngine());

type Ops = readonly TaskOp[] | null;

/** Podzadania serii (`completeTaskOps` z `subtasks` — zamknięte wracają przy następnym wystąpieniu). */
async function seriesSubtasks(id: string): Promise<Pick<ViewTask, 'id' | 'parentId' | 'status' | 'completedAt'>[]> {
  const engine = await localEngine();
  const rows = await engine.db.all<SqlRow>('select id, parent_id, status, completed_at from tasks where deleted_at is null and parent_id is not null');
  const tree = rows.map((r) => ({ id: String(r.id), parentId: r.parent_id as string | null, status: r.status as ViewTask['status'], completedAt: (r.completed_at as string | null) ?? null }));
  return descendants(tree, id);
}

async function withTask(id: string, act: (task: ViewTask, settings: ProfileSettings) => Ops | Promise<Ops>): Promise<boolean> {
  const { task, settings } = await loadTask(await localEngine(), id);
  if (!task) return false;
  const ops = await act(task, settings);
  if (!ops?.length) return false;
  await applyOps(ops);
  return true;
}

/**
 * Ukończenie (akcja z powiadomienia). Z `occurrence` — tylko gdy to nadal bieżące wystąpienie serii:
 * powtórzona akcja albo stare powiadomienie nie ukończą kolejnego wystąpienia.
 */
export const completeTaskById = (id: string, occurrence?: LocalDate | null) =>
  withTask(id, async (task, settings) => {
    if (!isOpen(task) || task.kind !== 'task') return null;
    if (occurrence && task.recurrence && task.dueDate !== occurrence) return null;
    return completeTaskOps(task, { now: new Date(), timeZone: settings.timeZone, subtasks: task.recurrence ? await seriesSubtasks(task.id) : [] }).ops;
  });

/** Odhaczenie z widżetu: otwarte → ukończone, ukończone dziś → z powrotem otwarte. */
export const toggleTaskById = (id: string) =>
  withTask(id, async (task, settings) => {
    if (task.kind !== 'task') return null;
    if (!isOpen(task)) return [{ table: 'tasks', id, patch: reopenTaskPatch() }];
    return completeTaskOps(task, { now: new Date(), timeZone: settings.timeZone, subtasks: task.recurrence ? await seriesSubtasks(task.id) : [] }).ops;
  });

/** „Jutro” z powiadomienia: termin na jutro (z licznikiem odłożeń), jak akcja grupowa. */
export const postponeTaskById = (id: string, occurrence?: LocalDate | null) =>
  withTask(id, (task, settings) => {
    if (!isOpen(task)) return null;
    const now = new Date();
    const today = localDateAt(now, settings.timeZone);
    // Już odłożone (powtórzona akcja) albo seria poszła dalej.
    if (task.dueDate && task.dueDate > today) return null;
    if (occurrence && task.recurrence && task.dueDate !== occurrence) return null;
    return bulkTaskOps([task], [task], { kind: 'tomorrow' }, { today, now, timeZone: settings.timeZone }).ops;
  });

/**
 * „Zrobione” z przypomnienia nawyku: wpis dnia `date` (cel ilościowy — osiągnięty). Dzień już
 * zaliczony albo wolny, dzień spoza okna uzupełniania i zamknięty nawyk — nic (powtórzona akcja
 * też niczego nie zmienia; id wpisu jest deterministyczne).
 */
export const habitDoneById = (id: string, date: LocalDate) =>
  withTask(id, async (task, settings) => {
    const habit = task.kind === 'habit' && isOpen(task) ? toHabit(task) : null;
    if (!habit) return null;
    const today = localDateAt(new Date(), settings.timeZone);
    const engine = await localEngine();
    const rows = await engine.db.all<{ occurrence_date: string; kind: string; value: number | null }>('select occurrence_date, kind, value from task_completions where task_id = ? and occurrence_date = ? and deleted_at is null', [id, date]);
    const previous = rows[0] ? toHabitCompletion(rows[0]) : null;
    if (previous && (previous.kind === 'skipped' || previous.value === null || previous.value === undefined || habit.target === undefined || previous.value >= habit.target)) return null;
    try {
      return habitEntryOps(habit, id, date, { kind: 'done', value: habit.target ?? null }, { now: new Date(), today, previous }).ops;
    } catch {
      return null;
    }
  });

// ── Timer skupienia (Etap 7) ─────────────────────────────────────────────────────────────────

export type FocusCommand =
  | { kind: 'start'; taskId: string | null; mode?: 'pomodoro' | 'stopwatch' }
  /** Z `ready`: następny etap pracy nad tym samym zadaniem (seria trwa). */
  | { kind: 'continue' }
  | { kind: 'pause' | 'resume' | 'skip' | 'stop' | 'advance' };

export interface FocusNow {
  userId: string;
  state: FocusState;
  settings: FocusSettings;
  /** Strefa z ustawień profilu (godziny w powiadomieniu). */
  timeZone?: string;
}

/** Odcisk stanu — akcja ze starego powiadomienia (inny etap) nic nie robi. */
export const focusStamp = (s: FocusState): string => `${s.phase}:${s.segmentStartedAt ?? ''}:${s.elapsedMs}:${s.paused ? 'p' : ''}`;

export async function loadFocus(): Promise<FocusNow> {
  const engine = await localEngine();
  const row = (await engine.db.all<SqlRow>('select focus, settings from profiles where id = ?', [engine.userId]))[0];
  const settings = parseSettings(row?.settings);
  return { userId: engine.userId, state: parseFocusState(row?.focus ?? null), settings: settings.focus, timeZone: settings.timeZone };
}

/**
 * Przejście timera z ekranu, z powiadomienia albo przy starcie aplikacji. Najpierw doliczenie
 * upływu czasu (`advanceFocus`: etap, który minął, zamyka się w chwili swojego końca), potem
 * polecenie; całość w jednej transakcji (`focusStepOps`). Id wpisów deterministyczne
 * (`focusEntryId`), więc telefon i web, które naraz doliczą koniec etapu, zapiszą te same wiersze.
 * Z `stamp` — tylko gdy stan po doliczeniu jest nadal tym, którego dotyczyło powiadomienie.
 */
export async function focusCommand(command: FocusCommand, stamp?: string): Promise<FocusNow & { changed: boolean }> {
  const current = await loadFocus();
  const { userId, settings, timeZone } = current;
  const now = new Date();
  const newId = focusEntryId(userId);
  const advanced = advanceFocus(current.state, now, { settings, newId });
  if (stamp && command.kind !== 'advance' && focusStamp(advanced.state) !== stamp) {
    if (!advanced.entries.length) return { ...current, changed: false };
    await mutateMany(focusStepOps(userId, advanced));
    return { userId, settings, timeZone, state: advanced.state, changed: true };
  }
  const s = advanced.state;
  const act: FocusStep =
    command.kind === 'start'
      ? startFocus(s, { taskId: command.taskId, mode: command.mode, now, newId })
      : command.kind === 'continue'
        ? s.phase === 'ready' ? startFocus(s, { taskId: s.taskId, now, newId }) : { state: s, entries: [] }
        : command.kind === 'pause'
          ? pauseFocus(s, now)
          : command.kind === 'resume'
            ? resumeFocus(s, now, newId)
            : command.kind === 'skip'
              ? skipPhase(s, now, { settings, newId })
              : command.kind === 'stop'
                ? s.phase === 'idle' ? { state: s, entries: [] } : stopFocus(s, now)
                : { state: s, entries: [] };
  const step: FocusStep = { state: act.state, entries: [...advanced.entries, ...act.entries] };
  const changed = step.entries.length > 0 || JSON.stringify(step.state) !== JSON.stringify(current.state);
  if (changed) await mutateMany(focusStepOps(userId, step));
  return { userId, settings, timeZone, state: step.state, changed };
}

// ── Widżety (Etap 11) ────────────────────────────────────────────────────────────────────────

/**
 * Odhaczenie z widżetu „Dziś”. Kliknięcie niesie stan docelowy (`done`), więc powtórzona obsługa
 * nic nie zmienia: ukończenie idzie jak z powiadomienia (z wystąpieniem serii), przywrócenie
 * tylko zadania, które nadal jest ukończone.
 */
export const setTaskDoneById = (id: string, done: boolean, occurrence?: LocalDate | null) =>
  done ? completeTaskById(id, occurrence) : withTask(id, async (task) => (task.kind === 'task' && task.status === 'done' ? [{ table: 'tasks', id, patch: reopenTaskPatch() }] : null));

/**
 * Wpis dnia nawyku z widżetu „Nawyki” (zrobione, wyczyszczenie albo wartość po „+1” — `habitEntryOps`
 * z core, id deterministyczne). Tylko dla dziś: kliknięcie w widżet narysowany przed północą
 * odświeża go zamiast zmieniać wczorajszy dzień. Wpis taki jak żądany (powtórzona obsługa) — bez zapisu.
 */
export const setHabitEntryById = (id: string, date: LocalDate, entry: HabitEntry) =>
  withTask(id, async (task, settings) => {
    const habit = task.kind === 'habit' && isOpen(task) ? toHabit(task) : null;
    const now = new Date();
    const today = localDateAt(now, settings.timeZone);
    if (!habit || date !== today) return null;
    const engine = await localEngine();
    const rows = await engine.db.all<SqlRow>('select occurrence_date, kind, value from task_completions where task_id = ? and occurrence_date = ? and deleted_at is null', [id, date]);
    const previous = rows[0] ? toHabitCompletion({ occurrence_date: rows[0].occurrence_date, kind: rows[0].kind, value: rows[0].value }) : null;
    if (sameHabitEntry(previous, entry)) return null;
    return habitEntryOps(habit, id, date, entry, { now, today, previous }).ops;
  });
