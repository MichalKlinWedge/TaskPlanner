/**
 * Operacje bez ekranu — widżet, akcje z powiadomień, zadanie w tle. Te same reguły z core co na
 * ekranach (`completeTaskOps`, `bulkTaskOps`, `reopenTaskPatch`), dane z `loadAppData`.
 * Każda operacja jest idempotentna: powtórzona (dwa wywołania tej samej akcji) nic nie psuje.
 */
import { bulkTaskOps, completeTaskOps, isOpen, localDateAt, reopenTaskPatch, type LocalDate, type TaskOp, type ViewTask } from '@taskplanner/core';

import { loadAppData, type AppData } from './app-data';
import { localEngine, mutate } from './sync';

export const applyOps = async (ops: readonly TaskOp[]) => {
  for (const op of ops) await mutate(op.table, op.id, op.patch);
};

export const headlessData = async (): Promise<AppData> => loadAppData(await localEngine());

async function withTask(id: string, act: (task: ViewTask, data: AppData) => readonly TaskOp[] | null): Promise<boolean> {
  const data = await headlessData();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return false;
  const ops = act(task, data);
  if (!ops?.length) return false;
  await applyOps(ops);
  return true;
}

/**
 * Ukończenie (akcja z powiadomienia). Z `occurrence` — tylko gdy to nadal bieżące wystąpienie serii:
 * powtórzona akcja albo stare powiadomienie nie ukończą kolejnego wystąpienia.
 */
export const completeTaskById = (id: string, occurrence?: LocalDate | null) =>
  withTask(id, (task, data) => {
    if (!isOpen(task) || task.kind !== 'task') return null;
    if (occurrence && task.recurrence && task.dueDate !== occurrence) return null;
    return completeTaskOps(task, { now: new Date(), timeZone: data.settings.timeZone }).ops;
  });

/** Odhaczenie z widżetu: otwarte → ukończone, ukończone dziś → z powrotem otwarte. */
export const toggleTaskById = (id: string) =>
  withTask(id, (task, data) => {
    if (task.kind !== 'task') return null;
    if (!isOpen(task)) return [{ table: 'tasks', id, patch: reopenTaskPatch() }];
    return completeTaskOps(task, { now: new Date(), timeZone: data.settings.timeZone }).ops;
  });

/** „Jutro” z powiadomienia: termin na jutro (z licznikiem odłożeń), jak akcja grupowa. */
export const postponeTaskById = (id: string, occurrence?: LocalDate | null) =>
  withTask(id, (task, data) => {
    if (!isOpen(task)) return null;
    const now = new Date();
    const today = localDateAt(now, data.settings.timeZone);
    // Już odłożone (powtórzona akcja) albo seria poszła dalej.
    if (task.dueDate && task.dueDate > today) return null;
    if (occurrence && task.recurrence && task.dueDate !== occurrence) return null;
    return bulkTaskOps([task], data.tasks, { kind: 'tomorrow' }, { today, now, timeZone: data.settings.timeZone }).ops;
  });
