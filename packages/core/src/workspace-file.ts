/**
 * Eksport i import całej przestrzeni jednym plikiem JSON (v1.x). Plik ma wszystko, co należy do
 * przestrzeni: listy i projekty (z dostępem gości, tablicą i karteczkami), zadania i cykliczne
 * z historią wystąpień, tagi, przypomnienia, zależności, czas pracy, komentarze, współpracowników,
 * zapisane filtry tej przestrzeni, członków z rolami i zaproszeniami oraz zawartość załączników
 * (base64). Bez kosza, historii zmian (`activity_log` prowadzi serwer), integracji i ustawień konta.
 *
 * Import zawsze tworzy **nową przestrzeń** z nowymi id (nic istniejącego nie zmienia treścią z pliku;
 * odtworzenie tych samych wierszy to kopia konta — `backup.ts`). Id są wyliczane z `importId`, więc
 * przerwany import można powtórzyć bez duplikatów. Wiersze idą przez `mutateMany`, pliki przez
 * kolejkę załączników, a role wracają jako zaproszenia (`share_workspace`) — nikt nie trafia do
 * przestrzeni bez swojej zgody.
 *
 * Autora wiersza (`created_by`) nadaje serwer, więc po imporcie wszystko jest importującego. Dlatego:
 * cudzy komentarz dostaje podpis autora, zadanie bez odpowiedzialnego założone przez inną osobę —
 * tę osobę jako odpowiedzialną, a przypomnienia wracają tylko własne (odpalają się tylko autorowi).
 */
import { z } from 'zod';

import { attachmentPath } from './attachments.ts';
import { BACKUP_DEFAULTS, BackupError, checkBackupRows, parentsFirst, pickBackupRow, type BackupOp, type BackupRow, type BackupTable, type InvalidRow } from './backup.ts';
import { findCollaborator, nameFromEmail, type Collaborator } from './collaborators.ts';
import { collaboratorId, completionId, inboxId, participantId, tagId, taskTagId, uuidv5 } from './ids.ts';
import { Instant, MAX_ATTACHMENT_BYTES, MAX_COMMENT_LENGTH } from './schemas/model.ts';
import { normalizeText } from './search.ts';
import type { ScopeRole, ShareRole } from './sharing.ts';
import { keyBetween } from './sort-key.ts';
import { ASSIGNEE_CREATOR } from './views.ts';

export const WORKSPACE_FILE_FORMAT = 'taskplanner-workspace';
export const WORKSPACE_FILE_VERSION = 1;

/** Tabele w pliku (przestrzeń osobno). */
export const WORKSPACE_FILE_TABLES = [
  'lists', 'tags', 'collaborators', 'tasks', 'task_tags', 'task_completions', 'reminders', 'task_dependencies',
  'time_entries', 'attachments', 'task_participants', 'task_comments', 'saved_filters',
] as const satisfies readonly BackupTable[];
export type WorkspaceFileTable = (typeof WORKSPACE_FILE_TABLES)[number];

/** Wiersz pliku: pola kopii i autor (`null` = eksportujący, wiersz jeszcze niewysłany). */
export type WorkspaceFileRow = BackupRow & { created_by?: string | null };

export interface WorkspaceFileAccount {
  userId: string;
  email: string;
  role: ScopeRole;
}

export interface WorkspaceFileInvite {
  email: string;
  role: ShareRole;
}

/** Plik bez zawartości załączników (tę czyta się i zapisuje po jednym pliku). */
export interface WorkspaceFile {
  format: typeof WORKSPACE_FILE_FORMAT;
  version: typeof WORKSPACE_FILE_VERSION;
  exportedAt: string;
  /** Konto eksportującego. */
  exportedBy: { userId: string; email: string | null };
  workspace: WorkspaceFileRow;
  /** Członkowie przestrzeni z rolami (także eksportujący). */
  accounts: WorkspaceFileAccount[];
  /** Zaproszenia czekające na odpowiedź (bez tokenów). */
  invites: WorkspaceFileInvite[];
  tables: Record<WorkspaceFileTable, WorkspaceFileRow[]>;
}

/** Zawartość załącznika w pliku. */
export interface WorkspaceFileContent {
  attachmentId: string;
  data: string;
}

// ── base64 ───────────────────────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Bajty albo `null`, gdy to nie base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ── Zapis ────────────────────────────────────────────────────────────────────────────────────

export interface WorkspaceFileInput {
  exportedAt: string;
  exportedBy: { userId: string; email: string | null };
  workspace: Record<string, unknown>;
  accounts: readonly WorkspaceFileAccount[];
  invites: readonly WorkspaceFileInvite[];
  tables: Partial<Record<WorkspaceFileTable, readonly Record<string, unknown>[]>>;
}

const fileRow = (table: BackupTable, row: Record<string, unknown>): WorkspaceFileRow => ({
  ...pickBackupRow(table, row, BACKUP_DEFAULTS[table]),
  created_by: typeof row.created_by === 'string' ? row.created_by : null,
});

export function createWorkspaceFile(input: WorkspaceFileInput): WorkspaceFile {
  const tables = {} as Record<WorkspaceFileTable, WorkspaceFileRow[]>;
  for (const table of WORKSPACE_FILE_TABLES) tables[table] = (input.tables[table] ?? []).map((row) => fileRow(table, row));
  return {
    format: WORKSPACE_FILE_FORMAT,
    version: WORKSPACE_FILE_VERSION,
    exportedAt: input.exportedAt,
    exportedBy: input.exportedBy,
    workspace: fileRow('workspaces', input.workspace),
    accounts: input.accounts.map(({ userId, email, role }) => ({ userId, email, role })),
    invites: input.invites.map(({ email, role }) => ({ email, role })),
    tables,
  };
}

/*
 * Układ pliku: nagłówek w jednej linii, potem `"files":[` i każdy załącznik w osobnej linii. To nadal
 * jeden poprawny JSON, ale duży plik (setki MB załączników) da się zapisać i odczytać po kawałku,
 * bez trzymania całości w jednym napisie.
 */
const FILES_LINE = '"files":[';

export const workspaceFileHead = (file: WorkspaceFile): string => `${JSON.stringify(file).slice(0, -1)},\n${FILES_LINE}\n`;
export const workspaceFileEntry = (content: WorkspaceFileContent, first: boolean): string =>
  `${first ? '' : ',\n'}${JSON.stringify({ attachmentId: content.attachmentId, data: content.data })}`;
export const WORKSPACE_FILE_TAIL = '\n]}\n';

// ── Odczyt ───────────────────────────────────────────────────────────────────────────────────

const Email = z.email().max(254).transform((e) => e.toLowerCase());
const Row = z.record(z.string(), z.unknown());

const Envelope = z.object({
  format: z.literal(WORKSPACE_FILE_FORMAT),
  version: z.literal(WORKSPACE_FILE_VERSION),
  exportedAt: Instant,
  exportedBy: z.object({ userId: z.uuid(), email: Email.nullable().catch(null) }),
  workspace: Row,
  accounts: z.array(z.object({ userId: z.uuid(), email: Email, role: z.enum(['owner', 'editor', 'viewer']) })).max(1000),
  invites: z.array(z.object({ email: Email, role: z.enum(['editor', 'viewer']) })).max(1000),
  tables: z.partialRecord(z.enum(WORKSPACE_FILE_TABLES), z.array(Row)),
});

const Content = z.object({ attachmentId: z.uuid(), data: z.string() });

interface ReadResult {
  file: WorkspaceFile;
  invalid: InvalidRow[];
}

function parseHead(input: unknown): ReadResult {
  const head = z.object({ format: z.string(), version: z.unknown() }).safeParse(input);
  if (!head.success || head.data.format !== WORKSPACE_FILE_FORMAT) {
    throw new BackupError(
      head.success && head.data.format === 'taskplanner-backup'
        ? 'To kopia całego konta — wczytaj ją w Ustawieniach → „Kopia zapasowa”.'
        : 'To nie jest plik przestrzeni Task Plannera.',
    );
  }
  if (typeof head.data.version === 'number' && head.data.version > WORKSPACE_FILE_VERSION) {
    throw new BackupError(`Plik z nowszej wersji aplikacji (format ${head.data.version}) — zaktualizuj aplikację.`);
  }
  const envelope = Envelope.safeParse(input);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    throw new BackupError(`Uszkodzony plik przestrzeni: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'nieznany format'}.`);
  }
  const { data } = envelope;
  const invalid: InvalidRow[] = [];
  const check = (table: BackupTable, rows: readonly Record<string, unknown>[]): WorkspaceFileRow[] => {
    const authors = new Map(rows.map((r) => [r.id, z.uuid().safeParse(r.created_by).data ?? null]));
    // Plik sprzed nowej kolumny jej nie ma — brakujące pola jak w bazie.
    const filled = rows.map((r) => pickBackupRow(table, r, BACKUP_DEFAULTS[table]));
    return checkBackupRows(table, filled, invalid).map((row) => ({ ...row, created_by: authors.get(row.id) ?? null }));
  };
  const [workspace] = check('workspaces', [data.workspace]);
  if (!workspace) throw new BackupError(`Uszkodzony plik przestrzeni: ${invalid[0]?.message ?? 'brak przestrzeni'}.`);
  const tables = {} as Record<WorkspaceFileTable, WorkspaceFileRow[]>;
  for (const table of WORKSPACE_FILE_TABLES) tables[table] = check(table, data.tables[table] ?? []);
  return { file: { ...data, workspace, tables }, invalid };
}

/**
 * Odczyt pliku po kawałku tekstu; zawartość załączników trafia po jednej do `onContent` (dopiero po
 * sprawdzeniu nagłówka). Plik sformatowany inaczej (np. z wcięciami) też jest poprawny — wtedy w całości.
 */
export async function readWorkspaceFile(
  chunks: AsyncIterable<string> | Iterable<string>,
  onContent: (attachmentId: string, bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
): Promise<ReadResult> {
  const head: string[] = [];
  let result: ReadResult | null = null;
  let parts: string[] = [];
  let ended = false;

  const content = async ({ file, invalid }: ReadResult, raw: unknown) => {
    const parsed = Content.safeParse(raw);
    const row = parsed.success ? file.tables.attachments.find((a) => a.id === parsed.data.attachmentId && a.kind === 'file') : undefined;
    if (parsed.success && !row) return;
    const bytes = parsed.success ? base64ToBytes(parsed.data.data) : null;
    const size = row?.size_bytes ?? null;
    if (!parsed.success || !bytes || bytes.length > MAX_ATTACHMENT_BYTES || (size !== null && size !== bytes.length)) {
      invalid.push({ table: 'attachments', id: parsed.data?.attachmentId ?? null, message: 'Uszkodzona zawartość załącznika.' });
    } else await onContent(parsed.data.attachmentId, bytes);
  };

  const line = async (text: string) => {
    if (!result) {
      if (text === FILES_LINE) result = parseHead(JSON.parse(`${head.join('\n')}"files":[]}`));
      else head.push(text);
    } else if (text.trim() === ']}') ended = true;
    else if (!ended && text.trim()) await content(result, JSON.parse(text.endsWith(',') ? text.slice(0, -1) : text));
  };

  for await (const chunk of chunks) {
    let from = 0;
    for (let at = chunk.indexOf('\n'); at >= 0; at = chunk.indexOf('\n', from)) {
      parts.push(chunk.slice(from, at));
      const text = parts.join('');
      parts = [];
      from = at + 1;
      await line(text.endsWith('\r') ? text.slice(0, -1) : text);
    }
    if (from < chunk.length) parts.push(chunk.slice(from));
  }
  if (parts.length) await line(parts.join(''));

  if (result) {
    if (!ended) throw new BackupError('Plik jest niepełny (przerwane pobieranie albo zapis).');
    return result;
  }
  const whole: unknown = JSON.parse(head.join('\n'));
  const parsed = parseHead(whole);
  const files = (whole as { files?: unknown }).files;
  for (const raw of Array.isArray(files) ? files : []) await content(parsed, raw);
  return parsed;
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────

/** Konto importującego, do którego trafia przestrzeń. */
export interface WorkspaceImportTarget {
  userId: string;
  email: string | null;
  /** Stały dla jednego importu — powtórka po przerwaniu trafia w te same wiersze. */
  importId: string;
  name: string;
  /** Ostatni klucz kolejności przestrzeni. */
  lastSortKey?: string;
  /** Własne tagi i współpracownicy konta (bez usuniętych). */
  tags: readonly { id: string; name: string; sortKey: string; workspaceIds: readonly string[] | null }[];
  collaborators: readonly Collaborator[];
  /** Id załączników, których zawartość odczytano z pliku. */
  contents: ReadonlySet<string>;
}

/** Załącznik do kolejki plików (wiersz `attachments` powstaje po wysyłce). */
export interface WorkspaceImportFile {
  /** Załącznik w pliku (zawartość). */
  sourceId: string;
  id: string;
  taskId: string;
  storagePath: string;
  name: string;
  mime: string;
}

export interface WorkspaceImportPlan {
  workspaceId: string;
  /** Zmiany dla `mutateMany` (rodzice przed dziećmi). */
  ops: BackupOp[];
  files: WorkspaceImportFile[];
  /** Pliki opisane, ale bez zawartości w pliku eksportu. */
  missingFiles: number;
  /** Przypomnienia innych osób (pominięte). */
  otherReminders: number;
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Które konto z pliku jest importującym: o tym samym e-mailu, a bez takiego — eksportujący (przestrzeń
 * przenoszona na nowe konto albo inny serwer).
 */
export function workspaceFileSelf(file: WorkspaceFile, email: string | null): string {
  return file.accounts.find((a) => sameEmail(a.email, email))?.userId ?? file.exportedBy.userId;
}

export interface WorkspaceFilePerson {
  email: string;
  /** Rola w pliku. */
  role: ScopeRole;
  /** Rola w zaproszeniu (dawny właściciel wraca jako edytor). */
  invite: ShareRole;
  /** W pliku było to zaproszenie bez odpowiedzi. */
  pending: boolean;
  /** Proponować zaproszenie (nie: dawne konto importującego). */
  suggested: boolean;
}

/** Osoby do zaproszenia po imporcie: członkowie i zaproszeni z pliku, bez importującego. */
export function workspaceFilePeople(file: WorkspaceFile, email: string | null): WorkspaceFilePerson[] {
  const self = workspaceFileSelf(file, email);
  const people = new Map<string, WorkspaceFilePerson>();
  for (const a of file.accounts) {
    const key = a.email.toLowerCase();
    if (!sameEmail(key, email)) people.set(key, { email: key, role: a.role, invite: a.role === 'viewer' ? 'viewer' : 'editor', pending: false, suggested: a.userId !== self });
  }
  for (const i of file.invites) {
    const key = i.email.toLowerCase();
    if (!sameEmail(key, email) && !people.has(key)) people.set(key, { email: key, role: i.role, invite: i.role, pending: true, suggested: true });
  }
  return [...people.values()];
}

/** Nazwa nowej przestrzeni; zajęta → „… (import)”, „… (import 2)”. */
export function importedWorkspaceName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => normalizeText(n.trim())));
  for (let n = 0; ; n++) {
    const suffix = n === 0 ? '' : n === 1 ? ' (import)' : ` (import ${n})`;
    const candidate = `${name.trim().slice(0, 100 - suffix.length)}${suffix}`;
    if (!used.has(normalizeText(candidate))) return candidate;
  }
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

type Ids = ReadonlyMap<string, string>;
const ref = (ids: Ids, value: unknown): string | null => (typeof value === 'string' ? (ids.get(value) ?? null) : null);
const refs = (ids: Ids, values: unknown): string[] => (Array.isArray(values) ? [...new Set(values.map((v) => ref(ids, v)).filter((v) => v !== null))] : []);
/** Odnośniki do zadań i list w tekście (linki aplikacji) → nowe id. */
const relink = (ids: Ids, text: unknown) => (typeof text === 'string' ? text.replace(UUID, (id) => ids.get(id.toLowerCase()) ?? id) : null);

/** Filtr z id z pliku → nowe id; warunek, z którego nic nie zostało, znika. */
function importFilter(ids: Ids, query: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(query as Record<string, unknown> | null) };
  const set = (key: string, kept: unknown[], value: unknown = kept) => {
    if (kept.length) next[key] = value;
    else delete next[key];
  };
  if (next.lists) set('lists', refs(ids, next.lists));
  if (next.workspaces) set('workspaces', refs(ids, next.workspaces));
  if (Array.isArray(next.assignees)) set('assignees', [...(next.assignees.includes(ASSIGNEE_CREATOR) ? [ASSIGNEE_CREATOR] : []), ...refs(ids, next.assignees)]);
  if (next.tags) {
    const kept = refs(ids, (next.tags as { ids?: unknown }).ids);
    set('tags', kept, { ...(next.tags as object), ids: kept });
  }
  return next;
}

/** `workspace_ids` z dodaną przestrzenią; `null` = bez zmiany (widoczny wszędzie, już dodana albo pełna lista). */
const withSpace = (spaces: readonly string[] | null | undefined, workspaceId: string): string[] | null =>
  spaces?.length && spaces.length < 100 && !spaces.includes(workspaceId) ? [...spaces, workspaceId] : null;

/** Operacje nowej przestrzeni z pliku (zasady w nagłówku modułu) i lista plików do kolejki. */
export function workspaceImportPlan(file: WorkspaceFile, target: WorkspaceImportTarget): WorkspaceImportPlan {
  const { userId, importId } = target;
  const newId = (old: string) => uuidv5(`workspace-import:${old}`, importId);
  const name = target.name.trim().slice(0, 100);
  if (!name) throw new BackupError('Przestrzeń musi mieć nazwę.');
  const workspaceId = newId(file.workspace.id);
  const self = workspaceFileSelf(file, target.email);
  const t = file.tables;
  const ops: BackupOp[] = [];
  const push = (table: BackupTable, id: string, patch: Record<string, unknown>) => ops.push({ table, id, patch: { ...patch, deleted_at: null } });
  const ids = new Map<string, string>([[file.workspace.id, workspaceId]]);
  /** Autor wiersza; pusty = eksportujący. */
  const author = (row: WorkspaceFileRow) => row.created_by ?? file.exportedBy.userId;
  const emailOf = new Map(file.accounts.map((a) => [a.userId, a.email]));
  const fields = (row: WorkspaceFileRow): Record<string, unknown> => {
    const { id: _id, created_by: _by, deleted_at: _deleted, ...patch } = row;
    return patch;
  };

  push('workspaces', workspaceId, { ...fields(file.workspace), name, archived_at: null, sort_key: keyBetween(target.lastSortKey) });

  // Id z góry — wiersze wskazują na siebie nawzajem (filtry list, „wynika z”, linki w opisach).
  const inbox = t.lists.find((l) => l.kind === 'inbox');
  for (const l of t.lists) ids.set(l.id, l === inbox ? inboxId(workspaceId) : newId(l.id));
  const tasks = parentsFirst(t.tasks).filter((task) => ids.has(task.list_id as string)) as WorkspaceFileRow[];
  const taskIds = new Map(tasks.map((task) => [task.id, newId(task.id)]));
  for (const [old, id] of taskIds) ids.set(old, id);

  // Tagi: własny o tej samej nazwie (dopuszczony w nowej przestrzeni) albo nowy, widoczny tylko w niej.
  const tagOps: BackupOp[] = [];
  const tagByName = new Map<string, string>();
  let lastTagKey = target.tags.reduce<string | undefined>((max, g) => (!max || g.sortKey > max ? g.sortKey : max), undefined);
  for (const tag of t.tags) {
    const tagName = String(tag.name).trim();
    const key = normalizeText(tagName);
    const existing = target.tags.find((g) => normalizeText(g.name.trim()) === key);
    const id = tagByName.get(key) ?? existing?.id ?? tagId(userId, tagName);
    ids.set(tag.id, id);
    if (tagByName.has(key)) continue;
    tagByName.set(key, id);
    if (!existing) {
      lastTagKey = keyBetween(lastTagKey);
      tagOps.push({ table: 'tags', id, patch: { scope_id: userId, name: tagName, color: tag.color ?? null, sort_key: lastTagKey, workspace_ids: [workspaceId], deleted_at: null } });
    } else {
      const spaces = withSpace(existing.workspaceIds, workspaceId);
      if (spaces) tagOps.push({ table: 'tags', id, patch: { workspace_ids: spaces } });
    }
  }

  // Współpracownicy: własny o tej samej nazwie albo nowy wpis (jak tagi).
  const peopleOps: BackupOp[] = [];
  const people: Collaborator[] = [...target.collaborators];
  const person = (input: { name: string; email: string | null; acronym: string | null; color?: string | null; archivedAt: string | null }): string => {
    const existing = findCollaborator(people, input.name);
    if (existing) {
      const spaces = withSpace(existing.workspaceIds, workspaceId);
      if (spaces) {
        people[people.indexOf(existing)] = { ...existing, workspaceIds: spaces };
        peopleOps.push({ table: 'collaborators', id: existing.id, patch: { workspace_ids: spaces } });
      }
      return existing.id;
    }
    const id = collaboratorId(userId, input.name);
    people.push({ id, ...input, workspaceIds: [workspaceId] });
    peopleOps.push({
      table: 'collaborators',
      id,
      patch: { scope_id: userId, name: input.name, email: input.email, acronym: input.acronym, color: input.color ?? null, archived_at: input.archivedAt, workspace_ids: [workspaceId], deleted_at: null },
    });
    return id;
  };
  for (const c of t.collaborators) {
    ids.set(c.id, person({ name: String(c.name).trim(), email: (c.email as string | null) ?? null, acronym: (c.acronym as string | null) ?? null, color: (c.color as string | null) ?? null, archivedAt: (c.archived_at as string | null) ?? null }));
  }
  /** Współpracownik odpowiadający kontu z pliku (po e-mailu); `null` = konto nieznane. */
  const accountPerson = (account: string): string | null => {
    const email = emailOf.get(account);
    if (!email) return null;
    const known = people.find((c) => sameEmail(c.email, email));
    return person(known ? { name: known.name, email, acronym: null, archivedAt: null } : { name: nameFromEmail(email) || email.slice(0, 100), email, acronym: null, archivedAt: null });
  };

  // Przestrzeń ma zawsze dokładnie jeden Inbox.
  if (!inbox) push('lists', inboxId(workspaceId), { scope_id: workspaceId, kind: 'inbox', name: 'Inbox', sort_key: 'a' });
  for (const list of t.lists) {
    const prefs: Record<string, unknown> = { ...(list.view_prefs as Record<string, unknown> | null) };
    if (prefs.filter) prefs.filter = importFilter(ids, prefs.filter);
    if (prefs.columnTags) prefs.columnTags = refs(ids, prefs.columnTags);
    push('lists', ids.get(list.id)!, {
      ...fields(list),
      scope_id: workspaceId,
      kind: list.kind === 'inbox' && list !== inbox ? 'list' : list.kind,
      description_md: relink(ids, list.description_md),
      view_prefs: prefs,
    });
  }
  const taskOps: BackupOp[] = tasks.map((task) => {
    const by = author(task);
    const derived = refs(taskIds, task.derived_from);
    const patch = {
      ...fields(task),
      list_id: ids.get(task.list_id as string),
      parent_id: ref(taskIds, task.parent_id),
      description_md: relink(ids, task.description_md),
      assignee_id: ref(ids, task.assignee_id) ?? (!task.assignee_id && by !== self ? accountPerson(by) : null),
      derived_from: derived.length ? derived : null,
      deleted_at: null,
    };
    return { table: 'tasks', id: taskIds.get(task.id)!, patch };
  });
  ops.push(...tagOps, ...peopleOps, ...taskOps);

  /** Wiersze zadań, każde id raz (ta sama para zadanie–tag po scaleniu tagów). */
  const children = (table: WorkspaceFileTable, make: (row: WorkspaceFileRow, taskId: string) => { id: string; patch?: Record<string, unknown> } | null) => {
    const seen = new Set<string>();
    for (const row of t[table]) {
      const taskId = ref(taskIds, row.task_id);
      const made = taskId ? make(row, taskId) : null;
      if (!made || seen.has(made.id)) continue;
      seen.add(made.id);
      push(table, made.id, { ...fields(row), task_id: taskId, ...made.patch });
    }
  };

  children('task_tags', (row, task) => {
    const tag = ref(ids, row.tag_id);
    return tag ? { id: taskTagId(task, tag), patch: { tag_id: tag } } : null;
  });
  children('task_completions', (row, task) => ({ id: completionId(task, String(row.occurrence_date)) }));
  let otherReminders = 0;
  children('reminders', (row) => {
    if (author(row) === self) return { id: newId(row.id) };
    otherReminders++;
    return null;
  });
  for (const d of t.task_dependencies) {
    const from = ref(taskIds, d.predecessor_id);
    const to = ref(taskIds, d.successor_id);
    if (from && to) push('task_dependencies', newId(d.id), { ...fields(d), predecessor_id: from, successor_id: to });
  }
  // Trwający odcinek (bez końca) należy do timera innego urządzenia — pomijany.
  children('time_entries', (row) => (row.ended_at ? { id: newId(row.id) } : null));
  children('attachments', (row) => (row.kind === 'link' ? { id: newId(row.id) } : null));
  children('task_participants', (row, task) => {
    const who = ref(ids, row.collaborator_id);
    return who ? { id: participantId(task, who), patch: { collaborator_id: who } } : null;
  });
  children('task_comments', (row) => {
    const by = author(row);
    const body = relink(ids, row.body) ?? '';
    const signed = by === self ? body : `${emailOf.get(by) ?? 'Inna osoba'}:\n${body}`;
    return { id: newId(row.id), patch: { body: signed.length <= MAX_COMMENT_LENGTH ? signed : body } };
  });
  for (const f of t.saved_filters) push('saved_filters', newId(f.id), { ...fields(f), scope_id: userId, query: importFilter(ids, f.query) });

  const files: WorkspaceImportFile[] = [];
  let missingFiles = 0;
  for (const a of t.attachments) {
    const taskId = a.kind === 'file' ? ref(taskIds, a.task_id) : null;
    if (!taskId) continue;
    if (!target.contents.has(a.id)) {
      missingFiles++;
      continue;
    }
    const id = newId(a.id);
    const fileName = String(a.name);
    files.push({ sourceId: a.id, id, taskId, storagePath: attachmentPath(userId, taskId, id, fileName), name: fileName, mime: (a.mime as string | null) || 'application/octet-stream' });
  }
  return { workspaceId, ops, files, missingFiles, otherReminders };
}

export interface WorkspaceFileCounts {
  lists: number;
  tasks: number;
  tags: number;
  collaborators: number;
  comments: number;
  files: number;
  fileBytes: number;
  links: number;
  people: number;
}

/** Liczby do podsumowania eksportu i podglądu importu. */
export function workspaceFileCounts(file: WorkspaceFile): WorkspaceFileCounts {
  const t = file.tables;
  const files = t.attachments.filter((a) => a.kind === 'file');
  return {
    lists: t.lists.length,
    tasks: t.tasks.length,
    tags: t.tags.length,
    collaborators: t.collaborators.length,
    comments: t.task_comments.length,
    files: files.length,
    fileBytes: files.reduce((sum, a) => sum + (Number(a.size_bytes) || 0), 0),
    links: t.attachments.length - files.length,
    people: file.accounts.length + file.invites.length,
  };
}
