/**
 * Eksport i import przestrzeni (v1.x) nad lokalną bazą: odczyt wierszy do `createWorkspaceFile`
 * i danych konta do `workspaceImportPlan` (`core/workspace-file.ts`). Zapis planu — `applyBackupPlan`.
 */
import {
  createWorkspaceFile,
  WORKSPACE_FILE_TABLES,
  type WorkspaceFile,
  type WorkspaceFileAccount,
  type WorkspaceFileInvite,
  type WorkspaceFileTable,
  type WorkspaceImportTarget,
} from '@taskplanner/core';

import type { BackupQuery } from './backup.ts';
import { decodeRow } from './merge.ts';

export interface WorkspaceExportInput {
  workspaceId: string;
  userId: string;
  email: string | null;
  /** Członkowie i zaproszenia z serwera (`workspace_sharing`). */
  accounts: readonly WorkspaceFileAccount[];
  invites: readonly WorkspaceFileInvite[];
  exportedAt?: string;
}

type Row = Record<string, unknown>;

const TASK_CHILDREN = ['task_tags', 'task_completions', 'reminders', 'time_entries', 'attachments', 'task_participants', 'task_comments'] as const satisfies readonly WorkspaceFileTable[];

/** Wszystkie napisy w wartości (id w filtrach i ustawieniach widoku). */
function strings(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Plik przestrzeni bez zawartości załączników; kosz (zadania i listy) pominięty. */
export async function exportWorkspace(query: BackupQuery, input: WorkspaceExportInput): Promise<WorkspaceFile> {
  const { workspaceId, userId } = input;
  const read = async (table: WorkspaceFileTable | 'workspaces', where: string, params: string[]): Promise<Row[]> =>
    (await query(`select * from ${table} where deleted_at is null and ${where}`, params)).map((row) => decodeRow<Row>(table, row));

  const [workspace] = await read('workspaces', 'id = ?', [workspaceId]);
  if (!workspace) throw new Error('Nie ma takiej przestrzeni.');
  // Przestrzeń zadania z listy (wiersz zapisany offline nie ma jeszcze zakresu z serwera).
  const inWorkspace = 'select t.id from tasks t join lists l on l.id = t.list_id where l.scope_id = ? and l.deleted_at is null and t.deleted_at is null';
  const tables = Object.fromEntries(WORKSPACE_FILE_TABLES.map((table) => [table, [] as Row[]])) as Record<WorkspaceFileTable, Row[]>;
  tables.lists = await read('lists', 'scope_id = ?', [workspaceId]);
  tables.tasks = await read('tasks', `id in (${inWorkspace})`, [workspaceId]);
  for (const table of TASK_CHILDREN) tables[table] = await read(table, `task_id in (${inWorkspace})`, [workspaceId]);
  tables.task_dependencies = await read('task_dependencies', `predecessor_id in (${inWorkspace}) and successor_id in (${inWorkspace})`, [workspaceId, workspaceId]);

  // Filtry konta, które dotyczą tej przestrzeni albo jej list.
  const places = new Set([workspaceId, ...tables.lists.map((l) => String(l.id))]);
  tables.saved_filters = (await read('saved_filters', 'scope_id = ?', [userId])).filter((f) => {
    const q = f.query as { lists?: string[]; workspaces?: string[] } | null;
    return [...(q?.lists ?? []), ...(q?.workspaces ?? [])].some((id) => places.has(id));
  });

  // Tagi i osoby: użyte w zadaniach, w filtrach i ustawieniach widoku albo przypisane do przestrzeni.
  const used = strings([tables.saved_filters.map((f) => f.query), tables.lists.map((l) => l.view_prefs)]);
  for (const r of tables.task_tags) used.add(String(r.tag_id));
  for (const r of tables.task_participants) used.add(String(r.collaborator_id));
  for (const r of tables.tasks) if (r.assignee_id) used.add(String(r.assignee_id));
  const belongs = (row: Row) => used.has(String(row.id)) || ((row.workspace_ids as string[] | null) ?? []).includes(workspaceId);
  tables.tags = (await read('tags', 'scope_id = ?', [userId])).filter(belongs);
  tables.collaborators = (await read('collaborators', 'scope_id = ?', [userId])).filter(belongs);

  // Cudze tagi i osoby — z kopii w przestrzeni (`scope_tags`, `scope_collaborators`); własny wpis wygrywa.
  const known = new Set([...tables.tags, ...tables.collaborators].map((r) => r.id));
  for (const c of await query('select * from scope_tags where scope_id = ?', [workspaceId])) {
    if (!known.has(c.tag_id)) tables.tags.push({ id: c.tag_id, scope_id: workspaceId, name: c.name, color: c.color, sort_key: 'n', workspace_ids: null });
  }
  for (const c of await query('select * from scope_collaborators where scope_id = ?', [workspaceId])) {
    if (!known.has(c.collaborator_id)) {
      tables.collaborators.push({ id: c.collaborator_id, scope_id: workspaceId, name: c.name, email: null, acronym: c.acronym, color: c.color ?? null, archived_at: c.archived_at, workspace_ids: null });
    }
  }
  return createWorkspaceFile({
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    exportedBy: { userId, email: input.email },
    workspace,
    accounts: input.accounts,
    invites: input.invites,
    tables,
  });
}

export type WorkspaceImportContext = Pick<WorkspaceImportTarget, 'tags' | 'collaborators' | 'lastSortKey'> & { workspaceNames: string[] };

/** Dane konta potrzebne do planu importu: własne tagi, współpracownicy, nazwy i kolejność przestrzeni. */
export async function workspaceImportContext(query: BackupQuery, userId: string): Promise<WorkspaceImportContext> {
  const workspaces = await query<{ name: string; sort_key: string | null }>('select name, sort_key from workspaces where deleted_at is null');
  const own = async (table: 'tags' | 'collaborators') => (await query(`select * from ${table} where scope_id = ? and deleted_at is null`, [userId])).map((row) => decodeRow<Row>(table, row));
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const spaces = (row: Row) => (row.workspace_ids as string[] | null) ?? null;
  return {
    workspaceNames: workspaces.map((w) => w.name),
    lastSortKey: workspaces.reduce<string | undefined>((max, w) => (w.sort_key && (!max || w.sort_key > max) ? w.sort_key : max), undefined),
    tags: (await own('tags')).map((g) => ({ id: String(g.id), name: String(g.name), sortKey: text(g.sort_key) ?? 'n', workspaceIds: spaces(g) })),
    collaborators: (await own('collaborators')).map((c) => ({
      id: String(c.id),
      name: String(c.name),
      email: text(c.email),
      acronym: text(c.acronym),
      color: text(c.color),
      archivedAt: text(c.archived_at),
      workspaceIds: spaces(c),
    })),
  };
}
