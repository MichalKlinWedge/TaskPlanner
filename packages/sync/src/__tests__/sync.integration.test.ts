/**
 * PoC-1 — scenariusze synchronizacji z SPECYFIKACJA §6 „Testy” na lokalnym Supabase.
 * Dwa urządzenia tego samego użytkownika (telefon, web), trzecie z przesuniętym zegarem,
 * obcy użytkownik. `npm run test:sync` (wymaga `npm run supabase -- start`).
 */
import { completionId, inboxId, uuidv7 } from '@taskplanner/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
