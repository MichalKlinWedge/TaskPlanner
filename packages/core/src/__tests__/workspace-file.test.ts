/**
 * Plik przestrzeni (eksport / import, v1.x): układ i odczyt po kawałku, walidacja, plan importu
 * z nowymi id, scalanie tagów i osób, autorzy, role i załączniki.
 */
import { describe, expect, it } from 'vitest';

import { BackupError } from '../backup.ts';
import { collaboratorId, completionId, inboxId, tagId, taskTagId } from '../ids.ts';
import {
  base64ToBytes,
  bytesToBase64,
  createWorkspaceFile,
  importedWorkspaceName,
  readWorkspaceFile,
  WORKSPACE_FILE_TAIL,
  workspaceFileCounts,
  workspaceFileEntry,
  workspaceFileHead,
  workspaceFilePeople,
  workspaceImportPlan,
  type WorkspaceFile,
  type WorkspaceImportTarget,
} from '../workspace-file.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = id(1);
const ANNA = id(2);
const GONE = id(3);
const IMPORTER = id(4);
const W = id(10);
const INBOX = inboxId(W);
const L = id(11);
const [T1, T2, T3] = [id(21), id(22), id(23)];
const [G1, G2] = [id(31), id(32)];
const C = id(41);
const FILE = id(51);

const task = (tid: string, extra: Record<string, unknown> = {}) => ({
  id: tid,
  list_id: L,
  title: `Zadanie ${tid.slice(-2)}`,
  kind: 'task',
  status: 'todo',
  priority: 4,
  sort_key: 'a',
  postpone_count: 0,
  created_by: ME,
  ...extra,
});

const sample = (): WorkspaceFile =>
  createWorkspaceFile({
    exportedAt: '2026-11-24T10:00:00.000Z',
    exportedBy: { userId: ME, email: 'ja@example.com' },
    workspace: { id: W, name: 'Dom', color: '#16a34a', sort_key: 'b', archived_at: '2026-11-01T10:00:00Z' },
    accounts: [
      { userId: ME, email: 'ja@example.com', role: 'owner' },
      { userId: ANNA, email: 'anna.nowak@example.com', role: 'viewer' },
    ],
    invites: [{ email: 'ola@example.com', role: 'editor' }],
    tables: {
      lists: [
        { id: INBOX, scope_id: W, kind: 'inbox', name: 'Inbox', sort_key: 'a', view_prefs: {} },
        {
          id: L,
          scope_id: W,
          kind: 'project',
          name: 'Remont',
          sort_key: 'b',
          guest_access: 'view',
          board_columns: [{ id: id(90), name: 'W toku' }],
          view_prefs: { view: 'kanban', columnTags: [G1, id(99)], filter: { tags: { ids: [G2], match: 'any' }, assignees: ['creator', C], lists: [id(98)] } },
        },
      ],
      tags: [
        { id: G1, scope_id: ME, name: 'Pilne', color: '#ef4444', sort_key: 'a', workspace_ids: [W] },
        { id: G2, scope_id: W, name: 'pilne', color: null, sort_key: 'n', workspace_ids: null },
      ],
      collaborators: [{ id: C, scope_id: ME, name: 'Jan Kowalski', email: 'jan@example.com', acronym: 'JK', archived_at: null, workspace_ids: null }],
      tasks: [
        task(T3, { parent_id: T2, derived_from: [T1, id(97)], created_by: ANNA }),
        task(T2, { assignee_id: C, board_column_id: id(90), description_md: `Zob. [#](#/task/${T1})` }),
        task(T1, { list_id: INBOX, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-20' }, due_date: '2026-11-24' }),
      ],
      task_tags: [
        { id: taskTagId(T1, G1), task_id: T1, tag_id: G1 },
        { id: taskTagId(T1, G2), task_id: T1, tag_id: G2 },
      ],
      task_completions: [{ id: completionId(T1, '2026-11-23'), task_id: T1, occurrence_date: '2026-11-23', kind: 'done', value: null, completed_at: '2026-11-23T10:00:00Z' }],
      reminders: [
        { id: id(61), task_id: T1, kind: 'relative', offset_min: 30, created_by: ME },
        { id: id(62), task_id: T1, kind: 'relative', offset_min: 10, created_by: ANNA },
      ],
      task_dependencies: [{ id: id(63), predecessor_id: T1, successor_id: T2, kind: 'finish_to_start', lag_days: 1 }],
      time_entries: [
        { id: id(64), task_id: T2, kind: 'manual', started_at: '2026-11-23T10:00:00Z', ended_at: '2026-11-23T11:00:00Z', pomodoro_index: null },
        { id: id(65), task_id: T2, kind: 'focus', started_at: '2026-11-24T10:00:00Z', ended_at: null, pomodoro_index: 0 },
      ],
      attachments: [
        { id: FILE, task_id: T2, kind: 'file', storage_path: `${ANNA}/${T2}/${FILE}-umowa.pdf`, name: 'Umowa ż.pdf', mime: 'application/pdf', size_bytes: 5, url: null, preview: null },
        { id: id(52), task_id: T2, kind: 'link', storage_path: null, name: 'example.com', mime: null, size_bytes: null, url: 'https://example.com', preview: null },
      ],
      task_participants: [{ id: id(66), task_id: T1, collaborator_id: C }],
      task_comments: [
        { id: id(67), task_id: T1, body: 'Moje', posted_at: '2026-11-23T10:00:00Z', edited_at: null, created_by: ME },
        { id: id(68), task_id: T1, body: 'Od Anny', posted_at: '2026-11-23T11:00:00Z', edited_at: null, created_by: ANNA },
        { id: id(69), task_id: T1, body: 'Dawny członek', posted_at: '2026-11-23T12:00:00Z', edited_at: null, created_by: GONE },
      ],
      saved_filters: [{ id: id(70), scope_id: ME, name: 'Dom pilne', icon: null, query: { workspaces: [W, id(96)], tags: { ids: [G1], match: 'all' } }, sort_key: 'a' }],
    },
  });

const BYTES = new Uint8Array([0, 255, 10, 13, 128]);
const text = (file: WorkspaceFile, contents: { attachmentId: string; data: string }[] = [{ attachmentId: FILE, data: bytesToBase64(BYTES) }]) =>
  workspaceFileHead(file) + contents.map((c, i) => workspaceFileEntry(c, i === 0)).join('') + WORKSPACE_FILE_TAIL;

async function read(source: string, size = 7) {
  const contents = new Map<string, Uint8Array>();
  const chunks = Array.from({ length: Math.ceil(source.length / size) }, (_, i) => source.slice(i * size, (i + 1) * size));
  const result = await readWorkspaceFile(chunks, (key, bytes) => void contents.set(key, bytes));
  return { ...result, contents };
}

const target = (extra: Partial<WorkspaceImportTarget> = {}): WorkspaceImportTarget => ({
  userId: ME,
  email: 'ja@example.com',
  importId: id(500),
  name: 'Dom (import)',
  lastSortKey: 'c',
  tags: [],
  collaborators: [],
  contents: new Set([FILE]),
  ...extra,
});

describe('plik przestrzeni', () => {
  it('jest poprawnym JSON-em i wraca bez zmian, czytany po kawałku', async () => {
    const file = sample();
    const source = text(file);
    expect((JSON.parse(source) as { files: unknown[] }).files).toHaveLength(1);
    const back = await read(source);
    expect(back.invalid).toEqual([]);
    expect(back.file).toEqual(file);
    expect(back.contents.get(FILE)).toEqual(BYTES);
  });

  it('bez załączników, z wcięciami i z końcami linii CRLF też się czyta', async () => {
    const file = sample();
    expect((await read(text(file, []))).file).toEqual(file);
    const pretty = await read(JSON.stringify(JSON.parse(text(file)), null, 2), 1000);
    expect(pretty.file).toEqual(file);
    expect(pretty.contents.get(FILE)).toEqual(BYTES);
    expect((await read(text(file).replace(/\n/g, '\r\n'))).contents.get(FILE)).toEqual(BYTES);
  });

  it('obcy, nowszy, ucięty plik i kopia konta — czytelny błąd', async () => {
    await expect(read('{"a":1}')).rejects.toThrow(BackupError);
    await expect(read(JSON.stringify({ format: 'taskplanner-backup', version: 1 }))).rejects.toThrow(/całego konta/);
    await expect(read(JSON.stringify({ ...sample(), version: 2 }))).rejects.toThrow(/nowszej wersji/);
    await expect(read(text(sample()).slice(0, -4))).rejects.toThrow(/niepełny/);
    await expect(read(text({ ...sample(), accounts: [{ userId: ME, email: 'x', role: 'owner' }] }))).rejects.toThrow(/Uszkodzony/);
  });

  it('zły wiersz i uszkodzona zawartość są pomijane z opisem; zawartość spoza załączników ignorowana', async () => {
    const file = sample();
    file.tables.tasks.push({ ...file.tables.tasks[0]!, id: id(29), priority: 9 });
    const back = await read(text(file, [{ attachmentId: FILE, data: bytesToBase64(new Uint8Array(3)) }, { attachmentId: id(77), data: 'AA==' }]));
    expect(back.invalid.map((i) => [i.table, i.id])).toEqual([
      ['tasks', id(29)],
      ['attachments', FILE],
    ]);
    expect(back.contents.size).toBe(0);
  });

  it('plik sprzed nowej kolumny: brakujące pole nie odrzuca wiersza', async () => {
    const raw = JSON.parse(text(sample())) as { tables: { tasks: Record<string, unknown>[]; lists: Record<string, unknown>[] } };
    for (const t of raw.tables.tasks) delete t.derived_from;
    for (const l of raw.tables.lists) delete l.guest_access;
    const back = await read(JSON.stringify(raw));
    expect(back.invalid).toEqual([]);
    expect(back.file.tables.lists[0]!.guest_access).toBe('edit');
  });

  it('base64: duże dane i zły zapis', () => {
    const big = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) % 256);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
    expect(base64ToBytes('nie base64 ✓')).toBeNull();
  });

  it('liczby do podglądu', () => {
    expect(workspaceFileCounts(sample())).toMatchObject({ lists: 2, tasks: 3, files: 1, fileBytes: 5, links: 1, people: 3, comments: 3 });
  });
});

describe('plan importu przestrzeni', () => {
  const planOf = (extra: Partial<WorkspaceImportTarget> = {}, file = sample()) => {
    const plan = workspaceImportPlan(file, target(extra));
    const of = (table: string) => plan.ops.filter((o) => o.table === table);
    const byTitle = (title: string) => of('tasks').find((o) => o.patch.title === title)!;
    return { ...plan, of, byTitle };
  };

  it('nowa przestrzeń z nowymi id, żaden wiersz nie wskazuje na stare', () => {
    const plan = planOf();
    expect(plan.ops[0]).toMatchObject({ table: 'workspaces', id: plan.workspaceId, patch: { name: 'Dom (import)', archived_at: null } });
    expect(plan.of('lists').map((o) => o.id)).toContain(inboxId(plan.workspaceId));
    const dump = JSON.stringify([plan.ops, plan.files.map((f) => ({ ...f, sourceId: null }))]);
    for (const old of [W, INBOX, L, T1, T2, T3, G1, G2, C, FILE, ANNA, id(52), id(61), id(63), id(64), id(67), id(70)]) expect(dump, old).not.toContain(old);
    // Ten sam `importId` = te same wiersze; inny import = osobna kopia.
    expect(planOf().ops).toEqual(plan.ops);
    expect(planOf({ importId: id(501) }).workspaceId).not.toBe(plan.workspaceId);
  });

  it('struktura: rodzic przed podzadaniem, zależność, „wynika z”, kolumna tablicy, link w opisie, cykl z historią', () => {
    const plan = planOf();
    const [t1, t2, t3] = [plan.byTitle('Zadanie 21'), plan.byTitle('Zadanie 22'), plan.byTitle('Zadanie 23')];
    expect(plan.of('tasks').indexOf(t2)).toBeLessThan(plan.of('tasks').indexOf(t3));
    expect(t3.patch).toMatchObject({ parent_id: t2.id, derived_from: [t1.id] });
    expect(t2.patch).toMatchObject({ board_column_id: id(90), description_md: `Zob. [#](#/task/${t1.id})` });
    expect(plan.of('task_dependencies')[0]!.patch).toMatchObject({ predecessor_id: t1.id, successor_id: t2.id, lag_days: 1 });
    expect(plan.of('task_completions')[0]).toMatchObject({ id: completionId(t1.id, '2026-11-23'), patch: { task_id: t1.id } });
    expect(plan.of('lists').find((o) => o.patch.name === 'Remont')!.patch).toMatchObject({ scope_id: plan.workspaceId, guest_access: 'view', board_columns: [{ id: id(90), name: 'W toku' }] });
    // Trwający odcinek timera nie wraca, zamknięty tak.
    expect(plan.of('time_entries')).toHaveLength(1);
  });

  it('tagi o tej samej nazwie scalone, filtry i ustawienia widoku przepisane', () => {
    const plan = planOf();
    const tag = tagId(ME, 'Pilne');
    expect(plan.of('tags')).toEqual([{ table: 'tags', id: tag, patch: expect.objectContaining({ scope_id: ME, color: '#ef4444', workspace_ids: [plan.workspaceId] }) }]);
    expect(plan.of('task_tags').map((o) => o.id)).toEqual([taskTagId(plan.byTitle('Zadanie 21').id, tag)]);
    const jan = collaboratorId(ME, 'Jan Kowalski');
    expect(plan.of('lists').find((o) => o.patch.name === 'Remont')!.patch.view_prefs).toEqual({
      view: 'kanban',
      columnTags: [tag],
      filter: { tags: { ids: [tag], match: 'any' }, assignees: ['creator', jan] },
    });
    expect(plan.of('saved_filters')[0]!.patch).toMatchObject({ scope_id: ME, query: { workspaces: [plan.workspaceId], tags: { ids: [tag], match: 'all' } } });
  });

  it('istniejący tag i współpracownik zostają, z dopisaną przestrzenią tylko przy ograniczonej widoczności', () => {
    const plan = planOf({
      tags: [{ id: id(300), name: 'PILNE', sortKey: 'k', workspaceIds: [id(301)] }],
      collaborators: [{ id: id(302), name: 'jan kowalski', email: null, workspaceIds: null }],
    });
    expect(plan.of('tags')).toEqual([{ table: 'tags', id: id(300), patch: { workspace_ids: [id(301), plan.workspaceId] } }]);
    expect(plan.byTitle('Zadanie 22').patch.assignee_id).toBe(id(302));
    expect(plan.of('collaborators').map((o) => o.id)).not.toContain(id(302));
  });

  it('autorzy: podpis cudzego komentarza, odpowiedzialny = twórca, tylko własne przypomnienia', () => {
    const plan = planOf();
    expect(plan.of('task_comments').map((o) => o.patch.body)).toEqual(['Moje', 'anna.nowak@example.com:\nOd Anny', 'Inna osoba:\nDawny członek']);
    const anna = collaboratorId(ME, 'Anna Nowak');
    expect(plan.byTitle('Zadanie 23').patch.assignee_id).toBe(anna);
    expect(plan.byTitle('Zadanie 21').patch.assignee_id).toBeNull();
    expect(plan.of('collaborators').find((o) => o.id === anna)!.patch).toMatchObject({ email: 'anna.nowak@example.com' });
    expect(plan.of('reminders').map((o) => o.patch.offset_min)).toEqual([30]);
    expect(plan.otherReminders).toBe(1);
  });

  it('import przez członka z pliku: „ja” to jego konto', () => {
    const plan = planOf({ userId: IMPORTER, email: 'Anna.Nowak@example.com' });
    expect(plan.of('reminders').map((o) => o.patch.offset_min)).toEqual([10]);
    expect(plan.byTitle('Zadanie 23').patch.assignee_id).toBeNull();
    expect(plan.of('task_comments')[0]!.patch.body).toBe('ja@example.com:\nMoje');
  });

  it('pliki do kolejki ze ścieżką importującego, link jako wiersz, brak zawartości policzony', () => {
    const plan = planOf({ userId: IMPORTER, email: 'nowe@example.com' });
    const f = plan.files[0]!;
    expect(f).toMatchObject({ sourceId: FILE, name: 'Umowa ż.pdf', mime: 'application/pdf', taskId: plan.byTitle('Zadanie 22').id });
    expect(f.storagePath).toBe(`${IMPORTER}/${f.taskId}/${f.id}-Umowa-z.pdf`);
    expect(plan.of('attachments').map((o) => o.patch.kind)).toEqual(['link']);
    expect(planOf({ contents: new Set() })).toMatchObject({ files: [], missingFiles: 1 });
  });

  it('przestrzeń bez Inboxa dostaje Inbox, drugi Inbox staje się listą', () => {
    const none = sample();
    none.tables.lists = none.tables.lists.filter((l) => l.kind !== 'inbox');
    const plan = planOf({}, none);
    expect(plan.of('lists').filter((o) => o.patch.kind === 'inbox')).toHaveLength(1);
    expect(plan.of('tasks').map((o) => o.patch.title)).not.toContain('Zadanie 21');
    const two = sample();
    two.tables.lists.push({ ...two.tables.lists[0]!, id: id(12) });
    expect(planOf({}, two).of('lists').map((o) => o.patch.kind)).toEqual(['inbox', 'project', 'list']);
  });
});

describe('role i nazwa', () => {
  it('osoby do zaproszenia: bez importującego, właściciel jako edytor, dawne konto nieproponowane', () => {
    expect(workspaceFilePeople(sample(), 'ja@example.com')).toEqual([
      { email: 'anna.nowak@example.com', role: 'viewer', invite: 'viewer', pending: false, suggested: true },
      { email: 'ola@example.com', role: 'editor', invite: 'editor', pending: true, suggested: true },
    ]);
    expect(workspaceFilePeople(sample(), 'ola@example.com').map((p) => [p.email, p.invite, p.suggested])).toEqual([
      ['ja@example.com', 'editor', false],
      ['anna.nowak@example.com', 'viewer', true],
    ]);
  });

  it('zajęta nazwa dostaje dopisek, długa mieści się w limicie', () => {
    expect(importedWorkspaceName('Dom', [])).toBe('Dom');
    expect(importedWorkspaceName('Dom', ['dom', 'Dom (import)'])).toBe('Dom (import 2)');
    expect(importedWorkspaceName('x'.repeat(100), ['x'.repeat(100)])).toHaveLength(100);
  });
});
