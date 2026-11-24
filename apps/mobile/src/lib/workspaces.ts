/**
 * Przestrzenie i listy (M2) na lokalnej bazie: odczyt do ekranu „Przestrzenie i listy” i zapisy
 * przez `mutate` (wiersz + outbox). Kolejność = `sort_key` z `keyBetween` / `reorderPatches`.
 */
import { inboxId, keyBetween, listKindPatch, reorderPatches, uuidv7, type GuestAccess, type ListKind, type ProjectStatus, type ScopeRole } from '@taskplanner/core';
import type { SqlRow, SyncEngine } from '@taskplanner/sync';

import { localEngine, mutate } from './sync';

export interface WorkspaceItem {
  id: string;
  name: string;
  color: string | null;
  sort_key: string;
  archived_at: string | null;
  lists: number;
  /** Rola z ostatniej synchronizacji (`_scopes`); `null` = jeszcze nieznana (jak właściciel). */
  role: ScopeRole | null;
}

export interface ListItem {
  id: string;
  scope_id: string;
  kind: ListKind;
  name: string;
  color: string | null;
  sort_key: string;
  project_status: ProjectStatus | null;
  archived_at: string | null;
  /** Dostęp gości (`lists.guest_access`); `null` = jeszcze niezsynchronizowana (jak `edit`). */
  guest_access: GuestAccess | null;
  /** Niezakończone zadania (bez podzadań). */
  open: number;
  /** Wszystkie nieusunięte zadania (lista z zadaniami nie znika, tylko się archiwizuje). */
  total: number;
}

const nowIso = () => new Date().toISOString();

export async function workspaceItems(engine: SyncEngine): Promise<WorkspaceItem[]> {
  const rows = await engine.db.all<SqlRow>(
    `select w.id, w.name, w.color, w.sort_key, w.archived_at, s.role,
            (select count(*) from lists l where l.scope_id = w.id and l.deleted_at is null and l.archived_at is null) as lists
     from workspaces w left join _scopes s on s.id = w.id where w.deleted_at is null order by w.sort_key, w.id`,
  );
  return rows.map((r) => ({ ...r, lists: Number(r.lists) }) as unknown as WorkspaceItem);
}

export async function listItems(engine: SyncEngine, workspaceId: string): Promise<ListItem[]> {
  const rows = await engine.db.all<SqlRow>(
    `select l.id, l.scope_id, l.kind, l.name, l.color, l.sort_key, l.project_status, l.archived_at, l.guest_access,
            (select count(*) from tasks t where t.list_id = l.id and t.deleted_at is null and t.parent_id is null
               and t.status not in ('done', 'cancelled')) as open,
            (select count(*) from tasks t where t.list_id = l.id and t.deleted_at is null) as total
     from lists l where l.scope_id = ? and l.deleted_at is null
     order by l.kind <> 'inbox', l.sort_key, l.id`,
    [workspaceId],
  );
  return rows.map((r) => ({ ...r, open: Number(r.open), total: Number(r.total) }) as unknown as ListItem);
}

/** Klucz na koniec posortowanej listy. */
const lastKey = (items: readonly { sort_key: string }[]) => keyBetween(items.reduce<string | undefined>((max, i) => (max === undefined || i.sort_key > max ? i.sort_key : max), undefined));

/** Nowa przestrzeń z Inboxem (id Inboxu deterministyczne, jak w onboardingu). */
export async function createWorkspace(name: string, color: string | null): Promise<string> {
  const engine = await localEngine();
  const id = uuidv7();
  await mutate('workspaces', id, { name: name.trim(), color, sort_key: lastKey(await workspaceItems(engine)) });
  await mutate('lists', inboxId(id), { scope_id: id, kind: 'inbox', name: 'Inbox', sort_key: 'a' });
  return id;
}

export const updateWorkspace = (id: string, patch: { name?: string; color?: string | null }) =>
  mutate('workspaces', id, patch.name === undefined ? patch : { ...patch, name: patch.name.trim() });

export const archiveWorkspace = (id: string, archived: boolean) => mutate('workspaces', id, { archived_at: archived ? nowIso() : null });

/** Przesunięcie o jedno miejsce wśród aktywnych (albo zarchiwizowanych) — zwykle jedna zmiana `sort_key`. */
export async function moveItem(table: 'workspaces' | 'lists', items: readonly { id: string; sort_key: string }[], from: number, to: number) {
  for (const patch of reorderPatches(items, from, to)) await mutate(table, patch.id, { sort_key: patch.sort_key });
}

export async function createList(workspaceId: string, input: { name: string; kind: Exclude<ListKind, 'inbox'>; color: string | null }): Promise<string> {
  const engine = await localEngine();
  const id = uuidv7();
  const siblings = (await listItems(engine, workspaceId)).filter((l) => l.kind !== 'inbox');
  await mutate('lists', id, {
    scope_id: workspaceId,
    kind: input.kind,
    name: input.name.trim(),
    color: input.color,
    project_status: input.kind === 'project' ? 'active' : null,
    sort_key: lastKey(siblings.length ? siblings : [{ sort_key: 'a' }]),
  });
  return id;
}

/** Zmiana listy; Inbox ma stałą nazwę i rodzaj. Projekt → lista czyści daty i status (reguła modelu). */
export async function updateList(
  list: ListItem,
  patch: { name?: string; color?: string | null; kind?: Exclude<ListKind, 'inbox'>; project_status?: ProjectStatus; guest_access?: GuestAccess },
) {
  if (list.kind === 'inbox' && (patch.name !== undefined || patch.kind !== undefined)) throw new Error('Inbox ma stałą nazwę i rodzaj.');
  const out: Record<string, unknown> = { ...patch };
  if (patch.name !== undefined) out.name = patch.name.trim();
  if (patch.kind) Object.assign(out, listKindPatch({ kind: list.kind, projectStatus: list.project_status }, patch.kind));
  await mutate('lists', list.id, out);
}

export async function archiveList(list: ListItem, archived: boolean) {
  if (list.kind === 'inbox') throw new Error('Inboxu nie można zarchiwizować.');
  await mutate('lists', list.id, { archived_at: archived ? nowIso() : null });
}

/** Usunięcie tylko pustej listy (z zadaniami — archiwizacja); Inbox zostaje zawsze. */
export async function removeList(list: ListItem) {
  if (list.kind === 'inbox') throw new Error('Inboxu nie można usunąć.');
  if (list.total > 0) throw new Error('Lista ma zadania — zarchiwizuj ją albo najpierw przenieś zadania.');
  await mutate('lists', list.id, { deleted_at: nowIso() });
}
