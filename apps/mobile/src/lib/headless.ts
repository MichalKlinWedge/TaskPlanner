/**
 * Operacje bez ekranu — widżet, akcje z powiadomień, zadanie w tle. Te same reguły z core co na
 * ekranach (`completeTaskOps`, `bulkTaskOps`, `reopenTaskPatch`); akcje czytają tylko swoje zadanie
 * (`loadTask`), bo w tle liczy się każda sekunda.
 * Każda operacja jest idempotentna: powtórzona (dwa wywołania tej samej akcji) nic nie psuje.
 */
import { bulkTaskOps, completeTaskOps, isOpen, localDateAt, reopenTaskPatch, type LocalDate, type ProfileSettings, type TaskOp, type ViewTask } from '@taskplanner/core';

import { loadAppData, loadTask, type AppData } from './app-data';
import { serverConfig, sessionUser } from './config';
import { localEngine, mutate, syncNow } from './sync';

export const applyOps = async (ops: readonly TaskOp[]) => {
  for (const op of ops) await mutate(op.table, op.id, op.patch);
};

/**
 * Wysyłka od razu po operacji bez ekranu. `mutate` planuje ją timerem, a timery JS stoją, gdy
 * aplikacja jest w tle — bez tego zmiana z powiadomienia czy widżetu czekałaby do otwarcia aplikacji.
 * Bez sieci (albo bez konta) nic nie robi: zmiana zostaje w outboksie.
 */
export async function pushNow(): Promise<void> {
  if (!sessionUser().online || !serverConfig()) return;
  await syncNow().catch(() => undefined);
}

export const headlessData = async (): Promise<AppData> => loadAppData(await localEngine());

async function withTask(id: string, act: (task: ViewTask, settings: ProfileSettings) => readonly TaskOp[] | null): Promise<boolean> {
  const { task, settings } = await loadTask(await localEngine(), id);
  if (!task) return false;
  const ops = act(task, settings);
  if (!ops?.length) return false;
  await applyOps(ops);
  return true;
}

/**
 * Ukończenie (akcja z powiadomienia). Z `occurrence` — tylko gdy to nadal bieżące wystąpienie serii:
 * powtórzona akcja albo stare powiadomienie nie ukończą kolejnego wystąpienia.
 */
export const completeTaskById = (id: string, occurrence?: LocalDate | null) =>
  withTask(id, (task, settings) => {
    if (!isOpen(task) || task.kind !== 'task') return null;
    if (occurrence && task.recurrence && task.dueDate !== occurrence) return null;
    return completeTaskOps(task, { now: new Date(), timeZone: settings.timeZone }).ops;
  });

/** Odhaczenie z widżetu: otwarte → ukończone, ukończone dziś → z powrotem otwarte. */
export const toggleTaskById = (id: string) =>
  withTask(id, (task, settings) => {
    if (task.kind !== 'task') return null;
    if (!isOpen(task)) return [{ table: 'tasks', id, patch: reopenTaskPatch() }];
    return completeTaskOps(task, { now: new Date(), timeZone: settings.timeZone }).ops;
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
