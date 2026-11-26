/**
 * Menu zadań wspólne dla gestu na wierszu, paska zaznaczenia i szczegółów: termin (gotowe dni +
 * kalendarz), priorytet, lista docelowa. Zmiany liczy core (`bulkTaskOps`, `datesPatch`) — z „Cofnij”.
 */
import {
  assigneeChoices,
  assignSelfOps,
  bulkTaskOps,
  collaboratorsForWorkspace,
  datesPatch,
  LIST_KIND,
  localDateAt,
  PRIORITY,
  relativeDay,
  selfCollaborator,
  tagCoverage,
  tagsForWorkspace,
  type LocalDate,
  type Priority,
  type ViewTask,
} from '@taskplanner/core';

import type { AppData } from '@/lib/app-data';
import { sessionUser } from '@/lib/config';
import { localEngine } from '@/lib/sync';

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

/** Lista docelowa: przestrzeń → Inbox, listy i projekty; przy wielu listach pole szukania (jak „Przenieś do…” na webie). */
export function pickList(data: AppData, title: string, current?: string) {
  const options: Option<string>[] = [];
  for (const w of data.workspaces) {
    for (const l of data.lists.filter((x) => x.workspaceId === w.id)) {
      options.push({ label: l.kind === 'inbox' ? `Inbox` : l.name, hint: `${w.name} · ${LIST_KIND[l.kind]}`, value: l.id, selected: l.id === current });
    }
  }
  return pickOption(title, options, { search: true });
}

/** Wspólna przestrzeń zaznaczonych (różne → `null` = podpowiedzi ze wszystkich). */
function chosenTasks(actions: TaskActions, data: AppData) {
  const chosen = data.tasks.filter((t) => actions.selected.has(t.id));
  const spaces = new Set(chosen.map((t) => t.workspaceId));
  return { chosen, workspaceId: spaces.size === 1 ? [...spaces][0]! : null };
}

/** Pasek zaznaczenia: tag — dodać tym, które go nie mają, albo zdjąć, gdy mają go wszystkie (nowy tag — na ekranie zadania). */
export async function bulkTag(actions: TaskActions, data: AppData) {
  const { chosen, workspaceId } = chosenTasks(actions, data);
  const tags = tagsForWorkspace(data.tags, workspaceId, chosen.flatMap((t) => t.tagIds));
  if (!tags.length) return actions.notify('Brak tagów — dodaj tag na ekranie zadania.');
  const pick = await pickOption(
    `Tag: ${chosen.length} zaznaczonych`,
    tags.map((t) => {
      const coverage = tagCoverage(chosen, t.id);
      const has = chosen.filter((x) => x.tagIds.includes(t.id)).length;
      return {
        label: `${coverage === 'all' ? '−' : '+'} ${t.name}`,
        hint: coverage === 'all' ? 'zdejmij ze wszystkich' : coverage === 'some' ? `dodaj pozostałym (ma ${has} z ${chosen.length})` : 'dodaj',
        value: { tag: t, remove: coverage === 'all' },
      };
    }),
    { search: true },
  );
  if (!pick) return;
  await actions.bulk(pick.remove ? { kind: 'removeTag', tagId: pick.tag.id } : { kind: 'addTag', name: pick.tag.name });
}

/** Pasek zaznaczenia: odpowiedzialny — „Ja” (wpis może dopiero powstać), twórca zadania albo współpracownik. */
export async function bulkAssignee(actions: TaskActions, data: AppData) {
  const { chosen, workspaceId } = chosenTasks(actions, data);
  const email = sessionUser().email ?? null;
  const me = selfCollaborator(data.collaborators, { email });
  const same = (id: string | null) => chosen.length > 0 && chosen.every((t) => (t.assigneeId ?? null) === id);
  const hint = (id: string | null, other?: string) => (same(id) ? 'wszystkie już mają' : other);
  const people = assigneeChoices(collaboratorsForWorkspace(data.collaborators, workspaceId), null).filter((c) => c.id !== me?.id);
  const pick = await pickOption<{ id: string | null; self?: boolean }>(
    `Odpowiedzialny: ${chosen.length} zaznaczonych`,
    [
      { label: 'Ja', value: { id: me?.id ?? null, self: true }, hint: me ? hint(me.id, me.name) : 'powstanie wpis z Twoim e-mailem' },
      { label: 'Twórca zadania', value: { id: null }, hint: hint(null, 'bez wskazanej osoby') },
      ...people.map((c) => ({ label: c.name, value: { id: c.id }, hint: hint(c.id, c.shared ? 'z udostępnionej przestrzeni' : (c.email ?? undefined)) })),
    ],
    { search: true },
  );
  if (!pick) return;
  if (!pick.self) return actions.bulk({ kind: 'assignee', collaboratorId: pick.id });
  const engine = await localEngine();
  const profile = await engine.db.all<{ display_name: string | null }>('select display_name from profiles where id = ?', [engine.userId]);
  const self = assignSelfOps(data.collaborators, { userId: data.userId, email, displayName: profile[0]?.display_name ?? null }, chosen[0]?.id ?? '', []);
  if (!self.ok) return actions.notify(self.error);
  await actions.bulk({ kind: 'assignee', collaboratorId: self.collaboratorId, prepare: self.ops.filter((o) => o.table !== 'tasks') });
}

/** Pasek zaznaczenia: termin dla wielu zadań. */
export async function bulkDate(actions: TaskActions, data: AppData) {
  const today = localDateAt(new Date(), data.settings.timeZone);
  const date = await pickDate({ title: `Termin: ${actions.selected.size} zaznaczonych`, value: null, today });
  if (date) await actions.bulk({ kind: 'date', date });
}
