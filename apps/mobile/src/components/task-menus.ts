/**
 * Menu zadań wspólne dla gestu na wierszu, paska zaznaczenia i szczegółów: termin (gotowe dni +
 * kalendarz), priorytet, lista docelowa. Zmiany liczy core (`bulkTaskOps`, `datesPatch`) — z „Cofnij”.
 */
import { bulkTaskOps, datesPatch, LIST_KIND, localDateAt, PRIORITY, relativeDay, type LocalDate, type Priority, type ViewTask } from '@taskplanner/core';

import type { AppData } from '@/lib/app-data';

import type { TaskActions } from './actions';
import { pickDate, pickOption, type Option } from './pickers';

/** Nowy termin jednego zadania (gest „w lewo”): przesunięcie liczy `reschedulePatch` (licznik odłożeń). */
export async function rescheduleWithMenu(task: ViewTask, today: LocalDate, { run }: Pick<TaskActions, 'run'>) {
  const date = await pickDate({ title: `Termin: ${task.title}`, value: task.dueDate, today, allowNone: true });
  if (date === undefined || date === task.dueDate) return;
  if (date === null) {
    const patch = datesPatch(task, { due_date: null });
    const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, k === 'due_date' ? task.dueDate : k === 'due_time' ? task.dueTime : task.startDate]));
    return run([{ table: 'tasks', id: task.id, patch }], { text: `„${task.title}” bez terminu`, undo: [{ table: 'tasks', id: task.id, patch: undo }] });
  }
  const now = new Date();
  const { ops, undo } = bulkTaskOps([task], [task], { kind: 'date', date }, { today, now });
  if (ops.length) await run(ops, { text: `„${task.title}” → ${relativeDay(date, today)}`, undo });
}

export const PRIORITIES = [1, 2, 3, 4] as const satisfies readonly Priority[];

export const pickPriority = (title: string, current?: Priority) =>
  pickOption<Priority>(
    title,
    PRIORITIES.map((p) => ({ label: PRIORITY[p].label, hint: PRIORITY[p].short, value: p, selected: p === current })),
  );

/** Lista docelowa: przestrzeń → Inbox, listy i projekty. */
export function pickList(data: AppData, title: string, current?: string) {
  const options: Option<string>[] = [];
  for (const w of data.workspaces) {
    for (const l of data.lists.filter((x) => x.workspaceId === w.id)) {
      options.push({ label: l.kind === 'inbox' ? `Inbox` : l.name, hint: `${w.name} · ${LIST_KIND[l.kind]}`, value: l.id, selected: l.id === current });
    }
  }
  return pickOption(title, options);
}

/** Pasek zaznaczenia: termin dla wielu zadań. */
export async function bulkDate(actions: TaskActions, data: AppData) {
  const today = localDateAt(new Date(), data.settings.timeZone);
  const date = await pickDate({ title: `Termin: ${actions.selected.size} zaznaczonych`, value: null, today });
  if (date) await actions.bulk({ kind: 'date', date });
}
