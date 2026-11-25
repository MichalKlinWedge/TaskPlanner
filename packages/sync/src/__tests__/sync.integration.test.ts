/**
 * PoC-1 — scenariusze synchronizacji z SPECYFIKACJA §6 „Testy” na lokalnym Supabase.
 * Dwa urządzenia tego samego użytkownika (telefon, web), trzecie z przesuniętym zegarem,
 * obcy użytkownik. `npm run test:sync` (wymaga `npm run supabase -- start`).
 */
import { advanceFocus, completionId, FOCUS_IDLE, focusEntryId, focusStepOps, inboxId, parseFocusState, pauseFocus, READONLY_LIST_NOTE, startFocus, uuidv7 } from '@taskplanner/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { READONLY_SCOPE_MESSAGE } from '../engine.ts';
import { purgeTasks } from '../purge.ts';
import { createDevice, createUser, waitFor, type Device, type TestUser } from './helpers/devices.ts';

let user: TestUser;
let phone: Device;
let web: Device;
const devices: Device[] = [];
const workspace = () => uuidv7();
let W: string;
let L: string;

const open = async (u: TestUser, name: string, options?: Parameters<typeof createDevice>[2]) => {
  const device = await createDevice(u, name, options);
  devices.push(device);
  return device;
};

const row = async (device: Device, table: 'tasks' | 'task_completions', id: string) => device.engine.get(table, id);
const serverTask = async (device: Device, id: string) => (await device.client.from('tasks').select('*').eq('id', id).single()).data;

/** Nowe zadanie na telefonie, wysłane i pobrane przez web. */
async function sharedTask(title: string, extra: Record<string, unknown> = {}) {
  const id = uuidv7();
  await phone.engine.mutate('tasks', id, { list_id: L, title, ...extra });
  await phone.engine.sync();
  await web.engine.sync();
  return id;
}

beforeEach(async () => {
  user = await createUser('wlasciciel');
  phone = await open(user, 'phone');
  web = await open(user, 'web');
  W = workspace();
  L = inboxId(W);
  await phone.engine.mutate('workspaces', W, { name: 'Dom' });
  await phone.engine.mutate('lists', L, { scope_id: W, kind: 'inbox', name: 'Inbox' });
  await phone.engine.sync();
  await web.engine.sync();
});

afterEach(async () => {
  for (const device of devices.splice(0)) await device.close();
});

describe('PoC-1: synchronizacja w obie strony', () => {
  it('powrót własnej zmiany z serwera nie budzi słuchaczy (widoki nie czytają drugi raz)', async () => {
    const id = await sharedTask('Echo');
    await phone.engine.sync();
    let calls = 0;
    const off = phone.engine.watch(['tasks'], () => calls++);
    await phone.engine.mutate('tasks', id, { status: 'done', completed_at: new Date().toISOString() });
    expect(calls).toBe(1);
    const before = await row(phone, 'tasks', id);
    await phone.engine.sync();
    // Serwer zwraca ten sam wiersz z nową wersją, `updated_at` i `completed_at` w zapisie `+00:00`.
    expect((await row(phone, 'tasks', id))?.row_version).toBeGreaterThan(Number(before?.row_version));
    expect(calls).toBe(1);
    await phone.engine.mutate('tasks', id, { status: 'todo', completed_at: null });
    await phone.engine.sync();
    expect(calls).toBe(2);
    off();
  });

  it('zadanie z telefonu offline trafia na web po powrocie sieci', async () => {
    phone.net.online = false;
    const id = uuidv7();
    await phone.engine.mutate('tasks', id, { list_id: L, title: 'Kupić mleko' });
    expect((await row(phone, 'tasks', id))?.scope_id).toBe(W);
    await expect(phone.engine.sync()).rejects.toThrow(/brak sieci/);
    expect(await phone.engine.pendingCount()).toBe(1);

    phone.net.online = true;
    const start = Date.now();
    await phone.engine.sync();
    await web.engine.sync();
    expect(Date.now() - start).toBeLessThan(5000);
    expect((await row(web, 'tasks', id))?.title).toBe('Kupić mleko');
    expect(await phone.engine.pendingCount()).toBe(0);
  });

  it('edycje różnych pól offline na dwóch urządzeniach — obie zachowane', async () => {
    const id = await sharedTask('Raport');
    phone.net.online = web.net.online = false;
    await phone.engine.mutate('tasks', id, { title: 'Raport kwartalny' });
    await web.engine.mutate('tasks', id, { priority: 1 });
    phone.net.online = web.net.online = true;
    await phone.engine.sync();
    await web.engine.sync();
    await phone.engine.sync();
    for (const device of [phone, web]) expect(await row(device, 'tasks', id)).toMatchObject({ title: 'Raport kwartalny', priority: 1 });
    expect(await serverTask(phone, id)).toMatchObject({ title: 'Raport kwartalny', priority: 1 });
  });

  it.each([
    ['później zapisana wysłana pierwsza', true],
    ['później zapisana wysłana druga', false],
  ])('to samo pole — wygrywa późniejszy HLC (%s)', async (_label, laterFirst) => {
    const id = await sharedTask('Tytuł');
    phone.net.online = web.net.online = false;
    await phone.engine.mutate('tasks', id, { title: 'Wcześniej' });
    web.clock.offset = 1000;
    await web.engine.mutate('tasks', id, { title: 'Później' });
    phone.net.online = web.net.online = true;
    const [first, second] = laterFirst ? [web, phone] : [phone, web];
    await first.engine.sync();
    await second.engine.sync();
    await first.engine.sync();
    for (const device of [phone, web]) expect((await row(device, 'tasks', id))?.title).toBe('Później');
    expect((await serverTask(phone, id))?.title).toBe('Później');
  });

  it('usunięcie kontra późniejsza edycja — zadanie usunięte, edycja zachowana na przywrócenie', async () => {
    const id = await sharedTask('Do usunięcia');
    phone.net.online = web.net.online = false;
    await phone.engine.remove('tasks', id);
    web.clock.offset = 1000;
    await web.engine.mutate('tasks', id, { title: 'Poprawione' });
    phone.net.online = web.net.online = true;
    await web.engine.sync();
    await phone.engine.sync();
    await web.engine.sync();
    for (const device of [phone, web]) {
      const task = await row(device, 'tasks', id);
      expect(task?.deleted_at).not.toBeNull();
      expect(task?.title).toBe('Poprawione');
    }
  });

  it('przeniesienie w cykl na dwóch urządzeniach — drugie odrzucone i cofnięte do wersji serwera', async () => {
    const x = await sharedTask('X');
    const y = await sharedTask('Y');
    phone.net.online = web.net.online = false;
    await phone.engine.mutate('tasks', x, { parent_id: y });
    await web.engine.mutate('tasks', y, { parent_id: x });
    expect((await row(web, 'tasks', y))?.parent_id).toBe(x);
    phone.net.online = web.net.online = true;
    await phone.engine.sync();
    await web.engine.sync();
    expect(web.rejected.map((r) => r.code)).toEqual(['TP002']);
    expect((await row(web, 'tasks', y))?.parent_id).toBeNull();
    expect((await row(web, 'tasks', x))?.parent_id).toBe(y);
    expect(await web.engine.rejectedOps()).toHaveLength(1);
    expect(await web.engine.pendingCount()).toBe(0);
  });

  it('podwójne ukończenie wystąpienia offline — jeden wiersz', async () => {
    const id = await sharedTask('Podlać kwiaty', { recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=WE', anchor: '2026-11-18' } });
    phone.net.online = web.net.online = false;
    const completion = completionId(id, '2026-11-18');
    await phone.engine.mutate('task_completions', completion, { task_id: id, occurrence_date: '2026-11-18', kind: 'done' });
    await web.engine.mutate('task_completions', completion, { task_id: id, occurrence_date: '2026-11-18', kind: 'done' });
    phone.net.online = web.net.online = true;
    await phone.engine.sync();
    await web.engine.sync();
    const { count } = await phone.client.from('task_completions').select('*', { count: 'exact', head: true }).eq('task_id', id);
    expect(count).toBe(1);
    expect(await row(web, 'task_completions', completion)).toMatchObject({ task_id: id, scope_id: W });
  });

  it('500 operacji offline wysłanych w < 10 s', async () => {
    phone.net.online = false;
    for (let i = 0; i < 500; i++) await phone.engine.mutate('tasks', uuidv7(), { list_id: L, title: `Zadanie ${i}` });
    phone.net.online = true;
    const start = Date.now();
    await phone.engine.sync();
    const elapsed = Date.now() - start;
    console.log(`500 operacji: ${elapsed} ms`);
    expect(elapsed).toBeLessThan(10_000);
    await web.engine.sync();
    const n = await web.engine.db.all<{ n: number }>('select count(*) as n from tasks where list_id = ?', [L]);
    expect(n[0]?.n).toBe(500);
  });

  it('Realtime: zmiana z telefonu dochodzi na web sama; zgubiony sygnał nadrobiony przy ponownym połączeniu', async () => {
    // Najpierw gotowość subskrypcji (ona sama wywołuje jedno pobranie), dopiero potem zmiana —
    // inaczej zadanie mogłoby przyjść z pobrania po SUBSCRIBED, a nie z sygnału zmiany.
    const before = web.stats.pulls;
    web.engine.start();
    await waitFor(async () => web.stats.pulls > before, 10_000, 'pobranie po SUBSCRIBED');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterReady = web.stats.pulls;

    const id = uuidv7();
    await phone.engine.mutate('tasks', id, { list_id: L, title: 'Przez Realtime' });
    const start = Date.now();
    await phone.engine.sync();
    await waitFor(async () => (await row(web, 'tasks', id))?.title === 'Przez Realtime', 10_000, 'zadanie na webie');
    console.log(`Realtime: ${Date.now() - start} ms od wysłania z telefonu`);
    expect(web.stats.pulls).toBeGreaterThan(afterReady);

    web.engine.stop();
    await web.client.removeAllChannels();
    await phone.engine.mutate('tasks', id, { title: 'Bez sygnału' });
    await phone.engine.sync();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await row(web, 'tasks', id))?.title).toBe('Przez Realtime');
    web.engine.start();
    await waitFor(async () => (await row(web, 'tasks', id))?.title === 'Bez sygnału', 10_000, 'pobranie po ponownym SUBSCRIBED');
  });

  it('zegar urządzenia +1 dzień nie wygrywa z późniejszą edycją z innego urządzenia', async () => {
    const id = await sharedTask('Zegar');
    const skewed = await open(user, 'skewed');
    await skewed.engine.sync();
    skewed.clock.offset = 24 * 3600 * 1000;
    await skewed.engine.mutate('tasks', id, { title: 'Z przyszłości' });
    await skewed.engine.sync();
    expect((await serverTask(phone, id))?.title).toBe('Z przyszłości');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await phone.engine.sync();
    await phone.engine.mutate('tasks', id, { title: 'Teraz' });
    await phone.engine.sync();
    await skewed.engine.sync();
    for (const device of [phone, skewed]) expect((await row(device, 'tasks', id))?.title).toBe('Teraz');
  });

  it('obcy użytkownik nie widzi przestrzeni i nie zmieni zadania', async () => {
    const id = await sharedTask('Prywatne');
    const stranger = await open(await createUser('obcy'), 'stranger');
    await stranger.engine.sync();
    expect(await row(stranger, 'tasks', id)).toBeUndefined();
    await stranger.engine.mutate('tasks', id, { title: 'Włamanie' });
    await stranger.engine.sync();
    expect(stranger.rejected.map((r) => r.code)).toEqual(['TP003']);
    expect((await serverTask(phone, id))?.title).toBe('Prywatne');
    expect(await row(stranger, 'tasks', id)).toBeUndefined();
  });
});

describe('v1.x: definitywne usunięcie z kosza', () => {
  it('zadanie z podzadaniem i plikiem znika z serwera i obu urządzeń; usunięte osobno zostaje odpięte', async () => {
    const id = await sharedTask('Na zawsze');
    const child = await sharedTask('Krok', { parent_id: id });
    const earlier = await sharedTask('Krok usunięty wcześniej', { parent_id: id });
    const path = `${user.id}/${id}/plik.txt`;
    expect((await phone.client.storage.from('attachments').upload(path, new TextEncoder().encode('abc'), { contentType: 'text/plain' })).error).toBeNull();
    const attachment = uuidv7();
    await phone.engine.mutate('attachments', attachment, { task_id: id, kind: 'file', name: 'plik.txt', storage_path: path, mime: 'text/plain', size_bytes: 3 });
    await phone.engine.sync();
    const purge = (device: Device) => purgeTasks(device.client, [id], { sync: () => device.engine.sync() });

    // Poza koszem — odmowa; przeniesienie do kosza wysyła się przed usunięciem.
    await expect(purge(phone)).rejects.toMatchObject({ code: 'TP007' });
    await phone.engine.mutate('tasks', earlier, { deleted_at: '2026-11-20T08:00:00.000Z' });
    const at = '2026-11-21T08:00:00.000Z';
    await phone.engine.mutateMany([id, child].map((task) => ({ table: 'tasks' as const, id: task, patch: { deleted_at: at } })));
    await web.engine.sync();
    phone.net.online = false;
    await expect(purge(phone)).rejects.toThrow(/brak sieci/);
    phone.net.online = true;
    // Niewysłana zmiana drugiego urządzenia w usuwanym zadaniu przepada razem z nim.
    await web.engine.sync();
    await web.engine.mutate('tasks', child, { title: 'Zmienione w koszu' });

    expect(await purge(phone)).toBe(2);
    await web.engine.sync();
    await web.engine.sync();
    for (const device of [phone, web]) {
      expect(await row(device, 'tasks', id)).toBeUndefined();
      expect(await row(device, 'tasks', child)).toBeUndefined();
      expect(await device.engine.get('attachments', attachment)).toBeUndefined();
      expect(await row(device, 'tasks', earlier)).toMatchObject({ parent_id: null });
      expect((await row(device, 'tasks', earlier))?.deleted_at).toBeTruthy();
      expect(await device.engine.pendingCount()).toBe(0);
    }
    expect(await serverTask(phone, id)).toBeNull();
    expect((await phone.client.storage.from('attachments').list(`${user.id}/${id}`)).data).toEqual([]);
    // Powtórka (np. drugie urządzenie kliknęło to samo) niczego nie psuje.
    expect(await purge(web)).toBe(0);
  });
});

describe('v1.x: współdzielona przestrzeń', () => {
  const share = async (email: string, role: 'editor' | 'viewer') => {
    const { data, error } = await phone.client.rpc('share_workspace', { p_scope: W, p_email: email, p_role: role });
    if (error) throw new Error(error.message);
    return (data as { token: string }).token;
  };
  const roleOf = async (device: Device) => (await device.engine.db.all<{ role: string }>('select role from _scopes where id = ?', [W]))[0]?.role;

  it('edytor i podgląd: przyjęcie, zapis edytora, podgląd tylko czyta, po usunięciu dane znikają', async () => {
    const id = await sharedTask('Wspólne');
    const editorUser = await createUser('edytor');
    const viewerUser = await createUser('podglad');
    const editor = await open(editorUser, 'editor');
    const viewer = await open(viewerUser, 'viewer');
    await share(editorUser.email, 'editor');
    const token = await share(viewerUser.email, 'viewer');

    // Przyjęcie z listy w aplikacji (edytor) i z linku (podgląd) — potem pełne pobranie nowego zakresu.
    const invites = (await editor.client.rpc('my_scope_invites')).data as { id: string }[];
    expect((await editor.client.rpc('accept_scope_invite', { p_id: invites[0]!.id })).error).toBeNull();
    expect((await viewer.client.rpc('accept_scope_invite', { p_token: token })).error).toBeNull();
    let viewerWorkspaceChanges = 0;
    const off = viewer.engine.watch(['workspaces'], () => viewerWorkspaceChanges++);
    await editor.engine.sync();
    await viewer.engine.sync();
    expect((await row(editor, 'tasks', id))?.title).toBe('Wspólne');
    expect((await row(viewer, 'tasks', id))?.title).toBe('Wspólne');
    expect(await roleOf(editor)).toBe('editor');
    expect(await roleOf(viewer)).toBe('viewer');
    expect(await roleOf(phone)).toBe('owner');
    expect(viewerWorkspaceChanges).toBeGreaterThan(0);
    off();

    await editor.engine.mutate('tasks', id, { title: 'Poprawione przez edytora' });
    await editor.engine.sync();
    await phone.engine.sync();
    expect((await row(phone, 'tasks', id))?.title).toBe('Poprawione przez edytora');
    expect(editor.rejected).toEqual([]);

    // Podgląd: zmiana odrzucona już lokalnie (nic w outboksie), nowe zadanie w tej przestrzeni też.
    await expect(viewer.engine.mutate('tasks', id, { title: 'Podgląd' })).rejects.toThrow(READONLY_SCOPE_MESSAGE);
    await expect(viewer.engine.mutate('tasks', uuidv7(), { list_id: L, title: 'Nowe' })).rejects.toThrow(READONLY_SCOPE_MESSAGE);
    expect(await viewer.engine.pendingCount()).toBe(0);
    expect((await row(viewer, 'tasks', id))?.title).toBe('Wspólne');

    // Własne przypomnienie: dopiero jako uczestnik; cudzego nie rusza, własne usunie także po odpięciu.
    const [person, participant, ownersReminder, own] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const remind = { task_id: id, kind: 'relative', offset_min: 15 };
    await phone.engine.mutate('reminders', ownersReminder, remind);
    await phone.engine.sync();
    await viewer.engine.sync();
    await expect(viewer.engine.mutate('reminders', own, remind)).rejects.toThrow(READONLY_SCOPE_MESSAGE);
    await phone.engine.mutateMany([
      { table: 'collaborators', id: person, patch: { name: `Podgląd ${person.slice(-6)}`, email: viewerUser.email } },
      { table: 'task_participants', id: participant, patch: { task_id: id, collaborator_id: person } },
    ]);
    await phone.engine.sync();
    await viewer.engine.sync();
    await viewer.engine.mutate('reminders', own, remind);
    await expect(viewer.engine.mutate('reminders', ownersReminder, { offset_min: 5 })).rejects.toThrow(READONLY_SCOPE_MESSAGE);
    await expect(viewer.engine.mutate('tasks', id, { title: 'Podgląd' })).rejects.toThrow(READONLY_SCOPE_MESSAGE);
    await viewer.engine.sync();
    expect(viewer.rejected).toEqual([]);
    const server = async () => (await phone.client.from('reminders').select('created_by, offset_min, deleted_at').eq('id', own)).data?.[0];
    expect(await server()).toMatchObject({ created_by: viewerUser.id, offset_min: 15, deleted_at: null });
    await phone.engine.mutate('task_participants', participant, { deleted_at: new Date().toISOString() });
    await phone.engine.sync();
    await viewer.engine.sync();
    await expect(viewer.engine.mutate('reminders', own, { offset_min: 30 })).rejects.toThrow(READONLY_SCOPE_MESSAGE);
    await viewer.engine.mutate('reminders', own, { deleted_at: new Date().toISOString() });
    await viewer.engine.sync();
    expect(viewer.rejected).toEqual([]);
    expect((await server())?.deleted_at).toBeTruthy();
    await phone.engine.mutate('collaborators', person, { deleted_at: new Date().toISOString() });

    // Zmiana roli na edytora odblokowuje zapis po najbliższym pobraniu.
    expect((await phone.client.rpc('set_scope_member_role', { p_scope: W, p_user: viewerUser.id, p_role: 'editor' })).error).toBeNull();
    await viewer.engine.sync();
    expect(await roleOf(viewer)).toBe('editor');
    await viewer.engine.mutate('tasks', id, { title: 'Już mogę' });
    await viewer.engine.sync();
    expect(viewer.rejected).toEqual([]);

    // Usunięcie z przestrzeni (właściciel) i opuszczenie (sam członek): wiersze znikają z urządzenia.
    expect((await phone.client.rpc('remove_scope_member', { p_scope: W, p_user: viewerUser.id })).error).toBeNull();
    expect((await editor.client.rpc('remove_scope_member', { p_scope: W, p_user: editorUser.id })).error).toBeNull();
    await viewer.engine.sync();
    await editor.engine.sync();
    for (const device of [viewer, editor]) {
      expect(await row(device, 'tasks', id)).toBeUndefined();
      expect(await device.engine.get('workspaces', W)).toBeUndefined();
      expect(await roleOf(device)).toBeUndefined();
    }
  });

  it('dostęp gości do list: ukryta znika i wraca, podgląd blokuje zapis edytora, przeniesienie na ukrytą = _gone', async () => {
    const visible = await sharedTask('Na Inboxie');
    const listV = uuidv7();
    const listH = uuidv7();
    const taskV = uuidv7();
    const taskH = uuidv7();
    const subH = uuidv7();
    const tagH = uuidv7();
    const reminderH = uuidv7();
    await phone.engine.mutateMany([
      { table: 'lists', id: listV, patch: { scope_id: W, kind: 'list', name: 'Do czytania', sort_key: 'b' } },
      { table: 'lists', id: listH, patch: { scope_id: W, kind: 'list', name: 'Tajna', sort_key: 'c' } },
      { table: 'tasks', id: taskV, patch: { list_id: listV, title: 'Czytaj' } },
      { table: 'tasks', id: taskH, patch: { list_id: listH, title: 'Tajne' } },
      { table: 'tasks', id: subH, patch: { parent_id: taskH, list_id: listH, title: 'Tajne podzadanie' } },
      { table: 'reminders', id: reminderH, patch: { task_id: taskH, kind: 'relative', offset_min: 15 } },
      { table: 'tags', id: tagH, patch: { name: `tajny-${tagH.slice(-6)}` } },
    ]);
    await phone.engine.sync();
    expect(phone.rejected).toEqual([]);
    const editorUser = await createUser('edytor-list');
    const editor = await open(editorUser, 'editor-list');
    await share(editorUser.email, 'editor');
    const invites = (await editor.client.rpc('my_scope_invites')).data as { id: string }[];
    expect((await editor.client.rpc('accept_scope_invite', { p_id: invites[0]!.id })).error).toBeNull();
    await editor.engine.sync();
    expect((await row(editor, 'tasks', taskH))?.title).toBe('Tajne');
    expect(await editor.engine.get('reminders', reminderH)).toBeDefined();

    // Edytor nie zmienia dostępu gości.
    await expect(editor.engine.mutate('lists', listV, { guest_access: 'view' })).rejects.toThrow(READONLY_LIST_NOTE);

    // Właściciel: „Do czytania” tylko do podglądu, „Tajna” ukryta → u edytora znika lista z zadaniami i dziećmi.
    await phone.engine.mutateMany([
      { table: 'lists', id: listV, patch: { guest_access: 'view' } },
      { table: 'lists', id: listH, patch: { guest_access: 'hidden' } },
    ]);
    await phone.engine.sync();
    await editor.engine.sync();
    expect(await editor.engine.get('lists', listH)).toBeUndefined();
    expect(await row(editor, 'tasks', taskH)).toBeUndefined();
    expect(await row(editor, 'tasks', subH)).toBeUndefined();
    expect(await editor.engine.get('reminders', reminderH)).toBeUndefined();
    expect((await editor.engine.get('lists', listV))?.guest_access).toBe('view');
    expect(await editor.engine.get('lists', L)).toBeDefined();

    // Lista tylko do podglądu: zmiana zadania, nowe zadanie i przeniesienie odrzucone lokalnie (nic w outboksie).
    await expect(editor.engine.mutate('tasks', taskV, { title: 'Nie wolno' })).rejects.toThrow(READONLY_LIST_NOTE);
    await expect(editor.engine.mutate('tasks', uuidv7(), { list_id: listV, title: 'Nowe' })).rejects.toThrow(READONLY_LIST_NOTE);
    await expect(editor.engine.mutate('tasks', visible, { list_id: listV })).rejects.toThrow(READONLY_LIST_NOTE);
    expect(await editor.engine.pendingCount()).toBe(0);
    await editor.engine.mutate('tasks', visible, { title: 'Inbox wolno' });
    await editor.engine.sync();
    expect(editor.rejected).toEqual([]);

    // Przeniesienie na ukrytą listę (właściciel) → znika u edytora w przyroście.
    await phone.engine.sync();
    await phone.engine.mutate('tasks', visible, { list_id: listH });
    await phone.engine.sync();
    await editor.engine.sync();
    expect(await row(editor, 'tasks', visible)).toBeUndefined();

    // Odsłonięcie: zakres od zera, wiersze wracają.
    await phone.engine.mutate('lists', listH, { guest_access: 'edit' });
    await phone.engine.sync();
    await editor.engine.sync();
    expect((await editor.engine.get('lists', listH))?.name).toBe('Tajna');
    expect((await row(editor, 'tasks', taskH))?.title).toBe('Tajne');
    expect((await row(editor, 'tasks', visible))?.title).toBe('Inbox wolno');
    expect(await editor.engine.get('reminders', reminderH)).toBeDefined();
    expect(editor.rejected).toEqual([]);
  });
});

describe('MVP-1: pełny model i stronicowanie', () => {
  it('przypomnienie, zależność i wpis czasu z telefonu na webie; zakres wyliczony lokalnie przed wysłaniem', async () => {
    const a = await sharedTask('Kupić płytki');
    const b = await sharedTask('Położyć płytki');
    const reminder = uuidv7();
    const dependency = uuidv7();
    const entry = uuidv7();
    phone.net.online = false;
    await phone.engine.mutate('reminders', reminder, { task_id: a, kind: 'relative', offset_min: 30 });
    await phone.engine.mutate('task_dependencies', dependency, { predecessor_id: a, successor_id: b });
    await phone.engine.mutate('time_entries', entry, { kind: 'manual', started_at: new Date().toISOString() });
    expect((await phone.engine.get('reminders', reminder))?.scope_id).toBe(W);
    expect((await phone.engine.get('task_dependencies', dependency))?.scope_id).toBe(W);
    expect((await phone.engine.get('time_entries', entry))?.scope_id).toBe(user.id);
    phone.net.online = true;
    await phone.engine.sync();
    expect(phone.rejected).toEqual([]);
    await web.engine.sync();
    expect((await web.engine.get('reminders', reminder))?.offset_min).toBe(30);
    expect((await web.engine.get('task_dependencies', dependency))?.successor_id).toBe(b);
    expect((await web.engine.get('time_entries', entry))?.scope_id).toBe(user.id);
    expect((await web.engine.get('profiles', user.id))?.scope_id).toBe(user.id);
  });

  it('pierwsza synchronizacja nowego urządzenia stronami daje te same wiersze', async () => {
    for (let i = 0; i < 25; i++) await phone.engine.mutate('tasks', uuidv7(), { list_id: L, title: `Zadanie ${i}`, board_sort_key: 'n' });
    await phone.engine.sync();
    const pages: number[] = [];
    const laptop = await open(user, 'laptop', { pullPageSize: 7, onPullProgress: (p) => pages.push(p.page) });
    await laptop.engine.sync();
    expect(pages.length).toBeGreaterThanOrEqual(4);
    const count = async (d: Device) => (await d.engine.db.all<{ n: number }>('select count(*) as n from tasks where list_id = ?', [L]))[0]?.n;
    expect(await count(laptop)).toBe(25);
    expect(await count(laptop)).toBe(await count(phone));
    const keys = await laptop.engine.db.all<{ k: string }>('select distinct board_sort_key as k from tasks where list_id = ?', [L]);
    expect(keys.map((r) => r.k)).toEqual(['n']);
  });

  it('hurtowy zapis strony: wiele porcji poleceń, niewysłana zmiana lokalna zostaje', async () => {
    const ids = Array.from({ length: 120 }, () => uuidv7());
    for (const [i, id] of ids.entries()) await phone.engine.mutate('tasks', id, { list_id: L, title: `Hurt ${i}`, priority: 2 });
    await phone.engine.sync();
    // Web zmienia offline tytuł jednego zadania; telefon w tym czasie zmienia mu priorytet.
    web.net.online = false;
    await web.engine.mutate('tasks', ids[5]!, { title: 'Zmiana z webu' });
    await phone.engine.mutate('tasks', ids[5]!, { priority: 4 });
    await phone.engine.sync();
    web.net.online = true;
    const pages: { rows: number; fetchMs: number; writeMs: number }[] = [];
    const laptop = await open(user, 'laptop2', { onPullProgress: (p) => pages.push(p) });
    await laptop.engine.sync();
    expect(pages.reduce((n, p) => n + p.rows, 0)).toBeGreaterThanOrEqual(122);
    expect(pages.every((p) => p.fetchMs >= 0 && p.writeMs >= 0)).toBe(true);
    const count = (await laptop.engine.db.all<{ n: number }>('select count(*) as n from tasks where list_id = ?', [L]))[0]?.n;
    expect(count).toBe(120);
    await web.engine.pull();
    const merged = await web.engine.get('tasks', ids[5]!);
    expect(merged).toMatchObject({ title: 'Zmiana z webu', priority: 4, scope_id: W });
    await web.engine.sync();
    expect(await serverTask(web, ids[5]!)).toMatchObject({ title: 'Zmiana z webu', priority: 4 });
  });
});

describe('Etap 6: zapis wsadowy i zależności', () => {
  it('kilka zmian w jednej transakcji, błędne pole — nic nie zapisane; cykl zależności z dwóch urządzeń odrzucony (TP002)', async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    const ab = uuidv7();
    await phone.engine.mutateMany([
      { table: 'tasks', id: a, patch: { list_id: L, title: 'Pomiary', due_date: '2026-11-23' } },
      { table: 'tasks', id: b, patch: { list_id: L, title: 'Projekt', due_date: '2026-11-24' } },
      { table: 'task_dependencies', id: ab, patch: { predecessor_id: a, successor_id: b, kind: 'finish_to_start', lag_days: 1 } },
    ]);
    expect(await phone.engine.pendingCount()).toBe(3);
    expect((await phone.engine.get('task_dependencies', ab))?.scope_id).toBe(W);
    await expect(
      phone.engine.mutateMany([
        { table: 'tasks', id: a, patch: { title: 'Zmienione' } },
        { table: 'tasks', id: b, patch: { nope: 1 } },
      ]),
    ).rejects.toThrow(/Pola spoza tasks: nope/);
    expect((await row(phone, 'tasks', a))?.title).toBe('Pomiary');
    expect(await phone.engine.pendingCount()).toBe(3);
    await phone.engine.sync();
    expect(phone.rejected).toEqual([]);
    await web.engine.sync();
    expect((await web.engine.get('task_dependencies', ab))?.lag_days).toBe(1);

    // Web (offline) nie wie o zależności dodanej w międzyczasie na telefonie → cykl wykrywa dopiero serwer.
    const bc = uuidv7();
    const c = uuidv7();
    web.net.online = false;
    await phone.engine.mutateMany([
      { table: 'tasks', id: c, patch: { list_id: L, title: 'Zamówienie', due_date: '2026-11-25' } },
      { table: 'task_dependencies', id: bc, patch: { predecessor_id: b, successor_id: c } },
    ]);
    await phone.engine.sync();
    const ca = uuidv7();
    await web.engine.mutate('tasks', c, { title: 'Zamówienie (web)' });
    await web.engine.mutate('task_dependencies', ca, { predecessor_id: c, successor_id: a });
    web.net.online = true;
    await web.engine.sync();
    expect(web.rejected.map((r) => r.code)).toEqual(['TP002']);
    expect(await web.engine.get('task_dependencies', ca)).toBeUndefined();
  });
});

describe('Etap 7: timer skupienia', () => {
  it('aktywny timer widoczny na drugim urządzeniu; koniec etapu doliczony na obu — te same wpisy', async () => {
    const task = await sharedTask('Raport');
    const t0 = new Date('2026-11-19T09:00:00Z');
    const newId = focusEntryId(user.id);
    const start = startFocus(FOCUS_IDLE, { taskId: task, now: t0, newId });
    await web.engine.mutateMany(focusStepOps(user.id, start));
    await web.engine.sync();
    expect(web.rejected).toEqual([]);
    await phone.engine.sync();
    const seen = parseFocusState((await phone.engine.get('profiles', user.id))?.focus);
    expect(seen).toEqual(start.state);
    const entry = await phone.engine.get('time_entries', start.state.entryId!);
    expect(entry).toMatchObject({ task_id: task, kind: 'focus', ended_at: null, pomodoro_index: 1, scope_id: W });

    // Oba urządzenia (offline) doliczają koniec pracy niezależnie — po synchronizacji jedna przerwa.
    web.net.online = false;
    phone.net.online = false;
    const later = new Date(t0.getTime() + 26 * 60_000);
    const onWeb = advanceFocus(start.state, later, { newId });
    const onPhone = advanceFocus(seen, new Date(later.getTime() + 60_000), { newId });
    await web.engine.mutateMany(focusStepOps(user.id, onWeb));
    await phone.engine.mutateMany(focusStepOps(user.id, onPhone));
    web.net.online = true;
    phone.net.online = true;
    await web.engine.sync();
    await phone.engine.sync();
    await web.engine.sync();
    const entries = (await web.client.from('time_entries').select('id, kind, started_at, ended_at, pomodoro_index').order('started_at')).data ?? [];
    expect(entries.map((e) => `${e.kind}#${e.pomodoro_index}:${e.ended_at ? 'closed' : 'open'}`)).toEqual(['focus#1:closed', 'break#1:open']);
    expect(Date.parse(entries[0]!.ended_at!)).toBe(t0.getTime() + 25 * 60_000);

    // Pauza na telefonie → web widzi pauzę.
    const paused = pauseFocus(onPhone.state, new Date(later.getTime() + 120_000));
    await phone.engine.mutateMany(focusStepOps(user.id, paused));
    await phone.engine.sync();
    await web.engine.sync();
    expect(parseFocusState((await web.engine.get('profiles', user.id))?.focus)).toMatchObject({ phase: 'short_break', paused: true });
    // Timer nie nadpisuje ustawień (osobne pole profilu).
    expect(((await web.engine.get('profiles', user.id))?.settings as Record<string, unknown> | undefined)?.focus ?? null).not.toEqual(paused.state);
  });
});
