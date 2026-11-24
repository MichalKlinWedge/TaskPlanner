/**
 * Eksport i import przestrzeni na lokalnym Supabase (v1.x): udostępniona przestrzeń z załącznikiem,
 * komentarzem gościa, tagami i współpracownikiem → plik JSON → nowa przestrzeń na tym samym i na
 * innym koncie, bez odrzuceń `push_changes`; plik załącznika wraca do Storage, role jako zaproszenia.
 * `npm run test:sync` (wymaga `npm run supabase -- start`).
 */
import {
  addCommentOps,
  attachmentPath,
  bytesToBase64,
  fileAttachmentPatch,
  inboxId,
  readWorkspaceFile,
  uuidv7,
  WORKSPACE_FILE_TAIL,
  workspaceFileEntry,
  workspaceFileHead,
  workspaceFilePeople,
  workspaceImportPlan,
  type WorkspaceFile,
} from '@taskplanner/core';
import { afterEach, describe, expect, it } from 'vitest';

import { applyBackupPlan } from '../backup.ts';
import { createFileQueue, memoryFileStore, supabaseUploader } from '../files.ts';
import { exportWorkspace, workspaceImportContext } from '../workspace-file.ts';
import { createDevice, createUser, type Device, type TestUser } from './helpers/devices.ts';
import { fillSample } from './helpers/sample-data.ts';

const devices: Device[] = [];
const open = async (user: TestUser, name: string) => {
  const device = await createDevice(user, name);
  devices.push(device);
  return device;
};

afterEach(async () => {
  for (const device of devices.splice(0)) await device.close();
});

const query = (device: Device) => device.engine.db.all.bind(device.engine.db);

async function rpc<T>(device: Device, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await device.client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

type Sharing = { members: { userId: string; email: string; role: 'owner' | 'editor' | 'viewer' }[]; invites: { email: string; role: 'editor' | 'viewer' }[] };

/** Kolejka plików jak w aplikacji (Storage → wiersz `attachments`). */
const queueOf = (device: Device) =>
  createFileQueue({
    store: memoryFileStore(),
    upload: supabaseUploader(device.client),
    commit: async (f) => {
      await device.engine.mutateMany([{ table: 'attachments', id: f.id, patch: fileAttachmentPatch({ taskId: f.taskId, storagePath: f.storagePath, name: f.name, mime: f.mime, size: f.size }) }]);
    },
  });

async function exportText(device: Device, user: TestUser, workspaceId: string): Promise<string> {
  const sharing = await rpc<Sharing>(device, 'workspace_sharing', { p_scope: workspaceId });
  const file = await exportWorkspace(query(device), { workspaceId, userId: user.id, email: user.email, accounts: sharing.members, invites: sharing.invites });
  let out = workspaceFileHead(file);
  for (const [i, a] of file.tables.attachments.filter((x) => x.kind === 'file').entries()) {
    const { data, error } = await device.client.storage.from('attachments').download(String(a.storage_path));
    if (error) throw error;
    out += workspaceFileEntry({ attachmentId: a.id, data: bytesToBase64(new Uint8Array(await data.arrayBuffer())) }, i === 0);
  }
  return out + WORKSPACE_FILE_TAIL;
}

async function importText(device: Device, user: TestUser, text: string, name: string) {
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  const { file, invalid } = await readWorkspaceFile([text], (id, bytes) => void contents.set(id, bytes));
  expect(invalid).toEqual([]);
  const context = await workspaceImportContext(query(device), user.id);
  const plan = workspaceImportPlan(file, { userId: user.id, email: user.email, importId: uuidv7(), name, ...context, contents: new Set(contents.keys()) });
  await applyBackupPlan((ops) => device.engine.mutateMany(ops), plan);
  await device.engine.sync();
  const queue = queueOf(device);
  for (const { sourceId, ...f } of plan.files) await queue.enqueue({ ...f, size: contents.get(sourceId)!.length }, contents.get(sourceId)!);
  const uploaded = await queue.flush();
  await device.engine.sync();
  return { file, plan, uploaded };
}

const counts = (file: WorkspaceFile) => Object.fromEntries(Object.entries(file.tables).map(([table, rows]) => [table, rows.length]));

describe('eksport i import przestrzeni', () => {
  it('kopia na tym samym i na innym koncie: dane, załącznik, współpracownicy i role', async () => {
    const owner = await createUser('wlasciciel');
    const editor = await createUser('edytor');
    const invited = await createUser('zaproszony');
    const web = await open(owner, 'web');
    const { ids } = await fillSample(web.engine, owner.id);
    await web.engine.sync();
    const workspaceId = String((await web.engine.get('tasks', ids[1]!))!.scope_id);

    // Udostępnienie: edytor przyjmuje, podgląd czeka na odpowiedź.
    const { id: inviteId } = await rpc<{ id: string }>(web, 'share_workspace', { p_scope: workspaceId, p_email: editor.email, p_role: 'editor' });
    const guest = await open(editor, 'guest');
    await rpc(guest, 'accept_scope_invite', { p_id: inviteId });
    await guest.engine.sync();
    await rpc(web, 'share_workspace', { p_scope: workspaceId, p_email: invited.email, p_role: 'viewer' });

    // Gość: komentarz i własny tag na zadaniu; właściciel: plik.
    const comment = addCommentOps(ids[2]!, 'Uwaga gościa', '2026-11-20T10:00:00.000Z');
    if (!comment.ok) throw new Error(comment.error);
    const guestTag = uuidv7();
    await guest.engine.mutateMany([
      ...comment.ops,
      { table: 'tags', id: guestTag, patch: { name: 'od gościa', color: '#EF4444', sort_key: 'a' } },
      { table: 'task_tags', id: uuidv7(), patch: { task_id: ids[2]!, tag_id: guestTag } },
    ]);
    await guest.engine.sync();
    const bytes = Uint8Array.from({ length: 3000 }, (_, i) => i % 256);
    const fileId = uuidv7();
    const queue = queueOf(web);
    await queue.enqueue({ id: fileId, taskId: ids[2]!, storagePath: attachmentPath(owner.id, ids[2]!, fileId, 'umowa.bin'), name: 'umowa.bin', mime: 'application/octet-stream', size: bytes.length }, bytes);
    expect(await queue.flush()).toBe(1);
    await web.engine.sync();
    await web.engine.sync();
    expect([...web.rejected, ...guest.rejected]).toEqual([]);

    const text = await exportText(web, owner, workspaceId);
    expect(text).not.toContain('"token"');

    // To samo konto: pełna kopia obok oryginału.
    const copy = await importText(web, owner, text, 'Kopia');
    expect(web.rejected).toEqual([]);
    expect(await web.engine.pendingCount()).toBe(0);
    expect(copy.uploaded).toBe(1);
    const again = await exportWorkspace(query(web), { workspaceId: copy.plan.workspaceId, userId: owner.id, email: owner.email, accounts: [], invites: [] });
    const { saved_filters: _filters, ...before } = counts(copy.file);
    expect(counts(again)).toMatchObject(before);
    expect(again.tables.tags.map((t) => t.name).sort()).toEqual(copy.file.tables.tags.map((t) => t.name).sort());
    expect(again.tables.task_comments.map((c) => c.body)).toContain(`${editor.email}:\nUwaga gościa`);
    // Oryginał bez zmian.
    expect(counts(await exportWorkspace(query(web), { workspaceId, userId: owner.id, email: owner.email, accounts: [], invites: [] }))).toEqual(counts(copy.file));

    // Plik w Storage: nowa ścieżka, ta sama zawartość.
    const stored = again.tables.attachments.find((a) => a.kind === 'file')!;
    expect(stored.storage_path).not.toBe(copy.file.tables.attachments.find((a) => a.kind === 'file')!.storage_path);
    const { data: blob } = await web.client.storage.from('attachments').download(String(stored.storage_path));
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);

    // Role: zaproszenia do kopii z rolami z pliku; edytor przyjmuje i dostaje dane z plikiem.
    const people = workspaceFilePeople(copy.file, owner.email);
    expect(people.map((p) => [p.email, p.invite, p.pending, p.suggested])).toEqual([
      [editor.email, 'editor', false, true],
      [invited.email, 'viewer', true, true],
    ]);
    for (const p of people) await rpc(web, 'share_workspace', { p_scope: copy.plan.workspaceId, p_email: p.email, p_role: p.invite });
    const mine = await rpc<{ id: string; scopeId: string }[]>(guest, 'my_scope_invites');
    await rpc(guest, 'accept_scope_invite', { p_id: mine.find((i) => i.scopeId === copy.plan.workspaceId)!.id });
    await guest.engine.sync();
    const sharing = await rpc<Sharing>(web, 'workspace_sharing', { p_scope: copy.plan.workspaceId });
    expect(sharing.members.map((m) => [m.email, m.role])).toEqual([
      [owner.email, 'owner'],
      [editor.email, 'editor'],
    ]);
    expect(sharing.invites.map((i) => [i.email, i.role])).toEqual([[invited.email, 'viewer']]);
    expect((await query(guest)('select id from tasks where scope_id = ?', [copy.plan.workspaceId])).length).toBe(copy.file.tables.tasks.length);
    expect((await guest.client.storage.from('attachments').download(String(stored.storage_path))).error).toBeNull();

    // Inne konto (przeniesienie): nowe urządzenie pobiera to samo, Inbox ma id wyliczone z przestrzeni.
    const fresh = await createUser('nowe');
    const other = await open(fresh, 'other');
    await other.engine.sync();
    const moved = await importText(other, fresh, text, 'Przeniesiona');
    expect(other.rejected).toEqual([]);
    expect(moved.uploaded).toBe(1);
    const tablet = await open(fresh, 'tablet');
    await tablet.engine.sync();
    const pulled = await exportWorkspace(query(tablet), { workspaceId: moved.plan.workspaceId, userId: fresh.id, email: fresh.email, accounts: [], invites: [] });
    const { saved_filters: _other, ...expected } = counts(moved.file);
    expect(counts(pulled)).toMatchObject(expected);
    expect(pulled.tables.lists.find((l) => l.kind === 'inbox')!.id).toBe(inboxId(moved.plan.workspaceId));
    expect(pulled.tables.tasks.find((t) => t.title === 'Raport')!.assignee_id).toBe(pulled.tables.collaborators.find((c) => c.name === 'Anna')!.id);
  });
});
