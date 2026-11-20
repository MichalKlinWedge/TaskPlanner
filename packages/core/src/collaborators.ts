/**
 * Współpracownicy, uczestnicy zadań i odpowiedzialny (v1.x, pierwsza część „Uczestników zadań” —
 * bez udostępniania). Współpracownik to wpis w książce adresowej użytkownika (zakres osobisty,
 * jak tag): nazwa i opcjonalny e-mail. Uczestnicy i odpowiedzialny tylko opisują zadanie — nikt
 * nie dostaje przez nie dostępu. Odpowiedzialny `null` = twórca zadania (domyślnie).
 *
 * Web i telefon budują zmiany tylko tutaj (`mutateMany`), z cofnięciem tam, gdzie zmiana coś zabiera.
 */
import { collaboratorId, participantId } from './ids.ts';
import { CollaboratorRow } from './schemas/model.ts';
import { normalizeText } from './search.ts';
import { tagVisibleIn, tagWorkspacesPatch, type TaskOp } from './tasks.ts';

export interface Collaborator {
  id: string;
  name: string;
  email: string | null;
  /** Skrót przy zadaniu; brak = inicjały z nazwy (`collaboratorBadge`). */
  acronym?: string | null;
  /** Nieaktywny od (ISO); brak = aktywny. */
  archivedAt?: string | null;
  /** Przestrzenie, w których osoba się podpowiada; brak / `null` = wszystkie (jak przy tagach). */
  workspaceIds?: readonly string[] | null;
}

export interface CollaboratorInput {
  name: string;
  email?: string | null;
  acronym?: string | null;
  /** Status; brak = bez zmiany (nowy — aktywny). */
  active?: boolean;
  /** Przestrzenie, w których osoba się podpowiada; puste = wszystkie, brak = bez zmiany. */
  workspaceIds?: readonly string[];
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const Fields = CollaboratorRow.pick({ name: true, email: true, acronym: true });

/** Nazwa, e-mail i akronim z formularza: przycięte, puste e-mail / akronim = brak; błąd po polsku. */
export function collaboratorFields(input: CollaboratorInput): Result<{ name: string; email: string | null; acronym: string | null }> {
  const email = input.email?.trim() || null;
  const acronym = input.acronym?.trim() || null;
  const parsed = Fields.safeParse({ name: input.name, email, acronym });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Niepoprawne dane.' };
  return { ok: true, name: parsed.data.name, email: parsed.data.email, acronym: parsed.data.acronym };
}

/** Aktywny = podpowiada się przy zadaniach. */
export const isActiveCollaborator = (collaborator: Pick<Collaborator, 'archivedAt'>): boolean => !collaborator.archivedAt;

/**
 * Czy osoba podpowiada się w przestrzeni (uczestnicy, odpowiedzialny, filtr „Odpowiedzialny”) —
 * ta sama reguła co przy tagach: brak przestrzeni albo brak listy = wszędzie.
 */
export const collaboratorVisibleIn = (collaborator: Pick<Collaborator, 'workspaceIds'>, workspaceId: string | null | undefined): boolean =>
  tagVisibleIn({ workspaceIds: collaborator.workspaceIds ?? null }, workspaceId ?? null);

/**
 * Współpracownicy do pokazania w przestrzeni; `keep` — ukryci tam, ale już przy zadaniu albo
 * zaznaczeni w filtrze (nie mogą zniknąć z wyboru).
 */
export function collaboratorsForWorkspace<T extends Collaborator>(collaborators: readonly T[], workspaceId: string | null | undefined, keep: Iterable<string | null | undefined> = []): T[] {
  const kept = new Set(keep);
  return collaborators.filter((c) => kept.has(c.id) || collaboratorVisibleIn(c, workspaceId));
}

/** Współpracownik o tej nazwie (bez wielkości liter i polskich znaków). */
export const findCollaborator = (collaborators: readonly Collaborator[], name: string): Collaborator | undefined => {
  const needle = normalizeText(name.trim());
  return needle ? collaborators.find((c) => normalizeText(c.name) === needle) : undefined;
};

/** Alfabetycznie po polsku (lista w ustawieniach i w wyborze). */
export const sortCollaborators = <T extends Collaborator>(collaborators: readonly T[]): T[] =>
  [...collaborators].sort((a, b) => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));

/** Podpowiedzi do pola „+ osoba”: aktywni, po nazwie, akronimie albo e-mailu, bez już wybranych. */
export function collaboratorMatches(collaborators: readonly Collaborator[], query: string, exclude: readonly string[] = [], limit = 8): Collaborator[] {
  const needle = normalizeText(query.trim());
  const skip = new Set(exclude);
  return sortCollaborators(collaborators.filter((c) => !skip.has(c.id) && isActiveCollaborator(c) && (!needle || normalizeText(c.name).includes(needle) || normalizeText(c.acronym ?? '') === needle || (c.email ?? '').toLowerCase().includes(needle)))).slice(0, limit);
}

/**
 * Nowy współpracownik albo zmiana istniejącego. Nowy dostaje id z nazwy (`collaboratorId`), więc ta
 * sama osoba dodana na dwóch urządzeniach offline to jeden wiersz, a dodanie usuniętej — jej przywrócenie.
 */
export function collaboratorSaveOps(
  userId: string,
  collaborators: readonly Collaborator[],
  input: CollaboratorInput,
  existing?: Collaborator,
  now: Date | string = new Date(),
): Result<{ id: string; ops: TaskOp[] }> {
  const fields = collaboratorFields(input);
  if (!fields.ok) return fields;
  const twin = findCollaborator(collaborators, fields.name);
  if (twin && twin.id !== existing?.id) return { ok: false, error: `„${twin.name}” już jest na liście współpracowników.` };
  if (!existing) {
    // Ten sam id co osoba usunięta albo dodana równolegle na innym urządzeniu: bez podanego e-maila
    // nie nadpisujemy tamtego (nowy wiersz i tak ma pusty).
    const id = collaboratorId(userId, fields.name);
    const patch = {
      scope_id: userId,
      name: fields.name,
      ...(fields.email && { email: fields.email }),
      ...(fields.acronym && { acronym: fields.acronym }),
      ...(input.active !== undefined && { archived_at: input.active ? null : new Date(now).toISOString() }),
      ...(input.workspaceIds?.length && tagWorkspacesPatch(input.workspaceIds)),
      deleted_at: null,
    };
    return { ok: true, id, ops: [{ table: 'collaborators', id, patch }] };
  }
  const patch: Record<string, unknown> = {};
  if (fields.name !== existing.name) patch.name = fields.name;
  if (fields.email !== existing.email) patch.email = fields.email;
  if (fields.acronym !== (existing.acronym ?? null)) patch.acronym = fields.acronym;
  if (input.active !== undefined && input.active !== isActiveCollaborator(existing)) patch.archived_at = input.active ? null : new Date(now).toISOString();
  if (input.workspaceIds) {
    const next = tagWorkspacesPatch(input.workspaceIds).workspace_ids;
    const same = (next ?? []).length === (existing.workspaceIds ?? []).length && (next ?? []).every((id) => existing.workspaceIds?.includes(id));
    if (!same) patch.workspace_ids = next;
  }
  return { ok: true, id: existing.id, ops: Object.keys(patch).length ? [{ table: 'collaborators', id: existing.id, patch }] : [] };
}

/**
 * Usunięcie współpracownika: znika z uczestników zadań, a zadania, za które odpowiadał, wracają do
 * twórcy. `undo` przywraca wszystko (te same id).
 */
export function deleteCollaboratorOps(
  collaborator: Pick<Collaborator, 'id'>,
  usage: { assignedTaskIds: readonly string[]; participantRowIds: readonly string[] },
  now: Date | string,
): { ops: TaskOp[]; undo: TaskOp[] } {
  const at = new Date(now).toISOString();
  return {
    ops: [
      ...usage.assignedTaskIds.map((id): TaskOp => ({ table: 'tasks', id, patch: { assignee_id: null } })),
      ...usage.participantRowIds.map((id): TaskOp => ({ table: 'task_participants', id, patch: { deleted_at: at } })),
      { table: 'collaborators', id: collaborator.id, patch: { deleted_at: at } },
    ],
    undo: [
      { table: 'collaborators', id: collaborator.id, patch: { deleted_at: null } },
      ...usage.participantRowIds.map((id): TaskOp => ({ table: 'task_participants', id, patch: { deleted_at: null } })),
      ...usage.assignedTaskIds.map((id): TaskOp => ({ table: 'tasks', id, patch: { assignee_id: collaborator.id } })),
    ],
  };
}

// ── Uczestnicy zadania ───────────────────────────────────────────────────────────────────────

/** Dodanie współpracownika do uczestników (powtórka i ponowne dodanie usuniętego — ten sam wiersz). */
export const addParticipantOps = (taskId: string, collaboratorId: string): TaskOp[] => [
  { table: 'task_participants', id: participantId(taskId, collaboratorId), patch: { task_id: taskId, collaborator_id: collaboratorId, deleted_at: null } },
];

export function removeParticipantOps(taskId: string, collaboratorId: string, now: Date | string): { ops: TaskOp[]; undo: TaskOp[] } {
  const id = participantId(taskId, collaboratorId);
  return {
    ops: [{ table: 'task_participants', id, patch: { deleted_at: new Date(now).toISOString() } }],
    undo: [{ table: 'task_participants', id, patch: { deleted_at: null } }],
  };
}

/**
 * Uczestnik z pola tekstowego: istniejący współpracownik o tej nazwie albo nowy (jedna paczka:
 * współpracownik, potem uczestnik — serwer sprawdza dostęp do współpracownika). Nowy dostaje
 * przestrzeń zadania (`workspaceId`, jak nowy tag); istniejącego nie zmienia.
 */
export function addParticipantByNameOps(
  userId: string,
  collaborators: readonly Collaborator[],
  taskId: string,
  name: string,
  workspaceId?: string | null,
): Result<{ collaboratorId: string; created: boolean; ops: TaskOp[] }> {
  const known = findCollaborator(collaborators, name);
  if (known) return { ok: true, collaboratorId: known.id, created: false, ops: addParticipantOps(taskId, known.id) };
  const saved = collaboratorSaveOps(userId, collaborators, { name, ...(workspaceId && { workspaceIds: [workspaceId] }) });
  if (!saved.ok) return saved;
  return { ok: true, collaboratorId: saved.id, created: true, ops: [...saved.ops, ...addParticipantOps(taskId, saved.id)] };
}

// ── Odpowiedzialny ───────────────────────────────────────────────────────────────────────────

/** Odpowiedzialny za zadanie; `null` = twórca. */
export const assignTaskOps = (taskId: string, collaboratorId: string | null): TaskOp[] => [{ table: 'tasks', id: taskId, patch: { assignee_id: collaboratorId } }];

/** Etykieta twórcy zadania: „Ty” (zadanie z tego konta albo jeszcze niewysłane) lub „Twórca zadania”. */
export const creatorLabel = (createdBy: string | null | undefined, userId: string): string => (!createdBy || createdBy === userId ? 'Ty' : 'Twórca zadania');

/**
 * Kto odpowiada za zadanie: współpracownik albo twórca. Usunięty / nieznany współpracownik (np.
 * jeszcze niezsynchronizowany) — twórca, jak w bazie po usunięciu.
 */
export function assigneeOf(assigneeId: string | null | undefined, collaborators: readonly Collaborator[]): Collaborator | null {
  return assigneeId ? (collaborators.find((c) => c.id === assigneeId) ?? null) : null;
}

/** Znaczek przy zadaniu: akronim osoby albo inicjały z nazwy. */
export const collaboratorBadge = (collaborator: Pick<Collaborator, 'name' | 'acronym'>): string => collaborator.acronym?.trim() || initials(collaborator.name);

/** Kolejność listy współpracowników: aktywni, potem nieaktywni, w grupie alfabetycznie. */
export const collaboratorsByStatus = <T extends Collaborator>(collaborators: readonly T[]): T[] => {
  const sorted = sortCollaborators(collaborators);
  return [...sorted.filter(isActiveCollaborator), ...sorted.filter((c) => !isActiveCollaborator(c))];
};

/**
 * Wybór odpowiedzialnego: aktywni i obecny odpowiedzialny (także nieaktywny — żeby lista pokazała,
 * kto jest wybrany).
 */
export const assigneeChoices = <T extends Collaborator>(collaborators: readonly T[], currentId: string | null | undefined): T[] =>
  sortCollaborators(collaborators.filter((c) => isActiveCollaborator(c) || c.id === currentId));

/** Inicjały do znaczka na wierszu zadania: „Anna Nowak” → „AN”, „ania” → „A”. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toLocaleUpperCase('pl'))
    .join('');
}
