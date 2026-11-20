/**
 * Etap 12 — dwukierunkowa synchronizacja zadań z kalendarzem „Task Planner” na fałszywym Google:
 * wybór przestrzeni → kalendarz w Google, zadanie → wydarzenie (wyzwalacz → pg_net → `tasks/flush`),
 * zmiana w Google → zadanie (kanał `watch` → HLC serwera), pętle, konflikty (`If-Match`), usunięcia,
 * powtórki (`watch`, `syncToken`, 410, cron) — 0 duplikatów i 0 zgubionych zmian.
 */
import { uuidv7 } from '@taskplanner/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eventIdForTask } from '../../../../supabase/functions/_shared/task-events.ts';
import { zonedParts, zonedToInstant } from '../../../../supabase/functions/_shared/time.ts';
import { FakeServices, type StoredEvent } from './fake-services.ts';
import { adminClient, createUser, createWorkspace, fn, measure, waitFor, type TestUser } from './helpers.ts';

const fake = new FakeServices();
const db = adminClient();
const PRIMARY = 'tester@gmail.com';
const ZONE = 'Europe/Warsaw';
const day = (n: number) => zonedParts(Date.now() + n * 86_400_000, ZONE).date;
const TOMORROW = day(1);
const at = (date: string, time: string, zone = ZONE) => zonedToInstant(date, time, zone);
const iso = (ms: number) => new Date(ms).toISOString();
/** Kryterium odbioru: zmiana dochodzi na drugą stronę w < 1 min (lokalnie oczekujemy sekund). */
const LIMIT_MS = 60_000;

let counter = 0;
const hlc = () => `${String(Date.now()).padStart(15, '0')}:${String(++counter % 100000).padStart(5, '0')}:t12dev`;

async function push(user: TestUser, ops: { table: string; id: string; set: Record<string, unknown> }[]) {
  const { data, error } = await user.client.rpc('push_changes', { p_ops: ops.map((o) => ({ op: uuidv7(), hlc: hlc(), ...o })) });
  if (error || data.rejected.length) throw new Error(`push_changes: ${error?.message ?? JSON.stringify(data.rejected)}`);
}

async function connectGoogle(user: TestUser, code = 'good-code'): Promise<string> {
  const { url } = await (await fn('calendar-sync/google/start', { jwt: user.jwt, body: '{}' })).json();
  const consent = new URL(url);
  const cb = await fetch(`${consent.searchParams.get('redirect_uri')}?code=${code}&state=${consent.searchParams.get('state')}`, { redirect: 'manual' });
  expect(cb.status, await cb.text()).toBe(200);
  const { data } = await db.from('calendar_accounts').select('id').eq('user_id', user.id).single();
  return data!.id;
}

const task = async (id: string) => (await db.from('tasks').select('*').eq('id', id).single()).data!;
const links = async (taskId: string) => (await db.from('calendar_task_links').select('*').eq('task_id', taskId)).data ?? [];

beforeAll(async () => {
  await fake.start();
  fake.addCalendar({ id: PRIMARY, summary: PRIMARY, primary: true, selected: true, timeZone: ZONE });
});
afterAll(() => fake.stop());

describe('Kalendarz „Task Planner” (Etap 12)', () => {
  let user: TestUser;
  let accountId: string;
  let work: Awaited<ReturnType<typeof createWorkspace>>;
  let home: Awaited<ReturnType<typeof createWorkspace>>;
  let targetId: string;
  let tp: string;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const t3 = uuidv7();
  const t4 = uuidv7();
  const t5 = uuidv7();

  const live = () => fake.liveEvents(tp);
  const eventFor = (taskId: string): StoredEvent | undefined => live().find((e) => e.extendedProperties?.private?.taskId === taskId);
  const settle = () => new Promise((r) => setTimeout(r, 1500));

  it('wybór przestrzeni → kalendarz „Task Planner” w Google (raz), kanał watch, bez wydarzeń w calendar_events', async () => {
    user = await createUser('zadania-kalendarz');
    accountId = await connectGoogle(user);
    work = await createWorkspace(user, 'Praca');
    home = await createWorkspace(user, 'Dom');
    await push(user, [{ table: 'profiles', id: user.id, set: { settings: { timeZone: ZONE, onboarded: true } } }]);
    await push(user, [{ table: 'profiles', id: user.id, set: { calendar_sync: { accountId, workspaceIds: [work.id] } } }]);

    const target = await waitFor(async () => (await db.from('calendars').select('*').eq('account_id', accountId).eq('is_task_target', true).maybeSingle()).data, 20_000, 'kalendarz zadań');
    targetId = target.id;
    tp = target.external_id;
    expect(fake.counts.createCalendar).toBe(1);
    expect(fake.calendars.get(tp)!.entry).toMatchObject({ summary: 'Task Planner', timeZone: ZONE });
    expect(fake.calendars.get(tp)!.entry.description).toContain(`taskplanner:${user.id}`);
    await waitFor(async () => fake.activeChannels(tp).length === 1, 10_000, 'kanał watch');

    // Ponowne połączenie konta (lista kalendarzy) nie robi z „Task Planner” zwykłego kalendarza ani drugiego kalendarza.
    expect((await fn('calendar-sync/accounts/sync', { jwt: user.jwt, body: JSON.stringify({ accountId }) })).status).toBe(200);
    expect(fake.counts.createCalendar).toBe(1);
    const { data: cals } = await db.from('calendars').select('id, is_task_target').eq('account_id', accountId);
    expect(cals!.filter((c) => c.is_task_target)).toHaveLength(1);
    // Ręczne ukrycie kalendarza zadań — nie (wyłącza się wyborem przestrzeni).
    expect((await fn('calendar-sync/calendars/update', { jwt: user.jwt, body: JSON.stringify({ calendarId: targetId, visible: false }) })).status).toBe(400);
  });

  it('zadanie z godziną → wydarzenie < 1 min; bez godziny, inna przestrzeń, anulowane — bez wydarzeń', async () => {
    const t0 = performance.now();
    await push(user, [
      { table: 'tasks', id: t1, set: { list_id: work.inbox, title: 'Raport', due_date: TOMORROW, due_time: '10:00', duration_min: 45 } },
      { table: 'tasks', id: t2, set: { list_id: work.inbox, title: 'Bez godziny', due_date: TOMORROW } },
      { table: 'tasks', id: t3, set: { list_id: home.inbox, title: 'Domowe', due_date: TOMORROW, due_time: '18:00' } },
      { table: 'tasks', id: t4, set: { list_id: work.inbox, title: 'Telekonferencja', due_date: TOMORROW, due_time: '09:00', time_zone: 'America/New_York' } },
      { table: 'tasks', id: t5, set: { list_id: work.inbox, title: 'Anulowane', due_date: TOMORROW, due_time: '11:00', status: 'cancelled' } },
    ]);
    const ev = await waitFor(async () => eventFor(t1) && eventFor(t4) && eventFor(t1), LIMIT_MS, 'wydarzenia zadań', 100);
    const ms = performance.now() - t0;
    measure('Etap 12: zadanie z godziną (push_changes) → wydarzenie w Google', ms);
    expect(ms).toBeLessThan(LIMIT_MS);

    expect(ev.id).toBe(eventIdForTask(t1));
    expect(ev.summary).toBe('Raport');
    expect(Date.parse(ev.start.dateTime!)).toBe(at(TOMORROW, '10:00'));
    expect(Date.parse(ev.end.dateTime!)).toBe(at(TOMORROW, '10:45'));
    expect(ev.start.timeZone).toBe(ZONE);
    expect(ev.extendedProperties!.private).toMatchObject({ taskId: t1, tpSource: 'taskplanner' });
    // Strefa zadania: 9:00 w Nowym Jorku, czas domyślny 30 min.
    const ny = eventFor(t4)!;
    expect(Date.parse(ny.start.dateTime!)).toBe(at(TOMORROW, '09:00', 'America/New_York'));
    expect(Date.parse(ny.end.dateTime!) - Date.parse(ny.start.dateTime!)).toBe(30 * 60_000);
    expect(ny.start.timeZone).toBe('America/New_York');
    await settle();
    expect(live().map((e) => e.extendedProperties?.private?.taskId).sort()).toEqual([t1, t4].sort());

    // Klient: kalendarz zadań przychodzi w pull_changes, jego wydarzenia — nie (zadanie byłoby dwa razy).
    const { data: pulled } = await user.client.rpc('pull_changes', { p_since: {} });
    expect(pulled.tables.calendars.find((c: { id: string }) => c.id === targetId)).toMatchObject({ is_task_target: true });
    expect(pulled.tables.calendar_events.filter((e: { calendar_id: string }) => e.calendar_id === targetId)).toEqual([]);
  });

  it('przesunięcie i zmiana długości w Google → zadanie < 1 min (HLC serwera), bez echa do Google', async () => {
    const writes = fake.writes.length;
    fake.editEvent(tp, eventIdForTask(t1), { start: { dateTime: iso(at(TOMORROW, '12:30')) }, end: { dateTime: iso(at(TOMORROW, '13:00')) } });
    const t0 = performance.now();
    expect(await fake.notify(tp)).toEqual([200]);
    const row = await waitFor(async () => {
      const t = await task(t1);
      return t.due_time === '12:30' && t.duration_min === 30 && t;
    }, LIMIT_MS, 'godzina z Google', 100);
    const ms = performance.now() - t0;
    measure('Etap 12: przesunięcie wydarzenia w Google (watch) → godzina zadania', ms);
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(row.due_date).toBe(TOMORROW);
    expect(row.title).toBe('Raport');
    expect(row.field_clock.due_time).toMatch(/:server$/);
    expect(row.field_clock.title).toMatch(/:t12dev$/);
    await settle();
    expect(fake.writes.slice(writes)).toEqual([]);
    expect((await links(t1))[0].etag).toBe(eventFor(t1)!.etag);
  });

  it('zmiana w aplikacji → wydarzenie; powiadomienie o własnym zapisie nie zmienia zadania', async () => {
    await push(user, [{ table: 'tasks', id: t1, set: { due_time: '15:00', title: 'Raport kwartalny' } }]);
    const ev = await waitFor(async () => {
      const e = eventFor(t1);
      return e && e.summary === 'Raport kwartalny' && Date.parse(e.start.dateTime!) === at(TOMORROW, '15:00') && e;
    }, LIMIT_MS, 'zmiana zadania w Google', 100);
    expect(Date.parse(ev.end.dateTime!)).toBe(at(TOMORROW, '15:30'));
    const before = await task(t1);
    expect(await fake.notify(tp)).toEqual([200]);
    await settle();
    expect((await task(t1)).row_version).toBe(before.row_version);
  });

  it('równoległe zmiany: tytuł w Google w trakcie zapisu, długość w aplikacji → If-Match 412 → obie zostają', async () => {
    fake.beforeWrite.set(eventIdForTask(t1), () => fake.editEvent(tp, eventIdForTask(t1), { summary: 'Raport Q4' }));
    await push(user, [{ table: 'tasks', id: t1, set: { duration_min: 90 } }]);
    const ev = await waitFor(async () => {
      const e = eventFor(t1);
      return e && Date.parse(e.end.dateTime!) - Date.parse(e.start.dateTime!) === 90 * 60_000 && e;
    }, LIMIT_MS, 'długość w Google', 100);
    expect(ev.summary).toBe('Raport Q4');
    const row = await task(t1);
    expect(row).toMatchObject({ title: 'Raport Q4', duration_min: 90, due_time: '15:00' });
    expect(fake.writes.some((w) => w.eventId === eventIdForTask(t1) && w.status === 412)).toBe(true);
  });

  it('usunięcie wydarzenia w Google → zadanie bez godziny (termin zostaje), wydarzenie nie wraca', async () => {
    const writes = fake.writes.length;
    fake.deleteEvent(tp, eventIdForTask(t1));
    await fake.notify(tp);
    const row = await waitFor(async () => {
      const t = await task(t1);
      return t.due_time === null && t;
    }, LIMIT_MS, 'zadanie bez godziny', 100);
    expect(row).toMatchObject({ due_date: TOMORROW, deleted_at: null, status: 'todo', title: 'Raport Q4' });
    expect(await links(t1)).toEqual([]);
    await settle();
    expect(eventFor(t1)).toBeUndefined();
    expect(fake.writes.slice(writes)).toEqual([]);
  });

  it('ponowna godzina → to samo wydarzenie przywrócone (409 → zmiana), bez duplikatu', async () => {
    const writes = fake.writes.length;
    await push(user, [{ table: 'tasks', id: t1, set: { due_time: '08:15' } }]);
    const ev = await waitFor(async () => eventFor(t1), LIMIT_MS, 'przywrócone wydarzenie', 100);
    expect(ev.id).toBe(eventIdForTask(t1));
    expect(Date.parse(ev.start.dateTime!)).toBe(at(TOMORROW, '08:15'));
    expect(fake.writes.slice(writes).map((w) => `${w.method}:${w.status}`)).toEqual(['insert:409', 'patch:200']);
    expect(live().filter((e) => e.extendedProperties?.private?.taskId === t1)).toHaveLength(1);
  });

  it('zadanie anulowane, usunięte albo przeniesione do niewysyłanej przestrzeni → wydarzenie usunięte', async () => {
    const t6 = uuidv7();
    await push(user, [{ table: 'tasks', id: t6, set: { list_id: work.inbox, title: 'Do przeniesienia', due_date: TOMORROW, due_time: '16:00' } }]);
    await waitFor(async () => eventFor(t6), LIMIT_MS, 'wydarzenie t6', 100);
    await push(user, [
      { table: 'tasks', id: t4, set: { status: 'cancelled' } },
      { table: 'tasks', id: t6, set: { list_id: home.inbox } },
    ]);
    await waitFor(async () => !eventFor(t4) && !eventFor(t6), LIMIT_MS, 'usunięte wydarzenia', 100);
    expect(await links(t4)).toEqual([]);
    // Zadania zostają z godziną (zmiana tylko po stronie Google).
    expect((await task(t6)).due_time).toBe('16:00');
    await push(user, [{ table: 'tasks', id: t1, set: { deleted_at: new Date().toISOString() } }]);
    await waitFor(async () => !eventFor(t1), LIMIT_MS, 'usunięte zadanie', 100);
    await push(user, [{ table: 'tasks', id: t1, set: { deleted_at: null } }]);
    await waitFor(async () => eventFor(t1), LIMIT_MS, 'przywrócone zadanie', 100);
  });

  it('wydarzenie dodane w Google → zadanie w Inboxie; powtórki, 410 i cron — bez duplikatów', async () => {
    fake.upsertEvent(tp, { id: 'usr0dentysta', summary: 'Dentysta', start: { dateTime: iso(at(day(2), '14:00')) }, end: { dateTime: iso(at(day(2), '15:00')) } });
    await fake.notify(tp);
    const created = await waitFor(async () => {
      const { data } = await db.from('tasks').select('*').eq('source->>eventId', 'usr0dentysta');
      return data && data.length > 0 ? data : null;
    }, LIMIT_MS, 'zadanie z wydarzenia', 100);
    expect(created).toHaveLength(1);
    const [row] = created;
    expect(row).toMatchObject({ list_id: work.inbox, title: 'Dentysta', due_date: day(2), due_time: '14:00', duration_min: 60, source: { kind: 'calendar', eventId: 'usr0dentysta' } });
    expect(row.field_clock.title).toMatch(/:server$/);
    // Wydarzenie dostaje znacznik źródła (taskId) w tym samym przebiegu.
    await waitFor(async () => fake.calendars.get(tp)!.events.get('usr0dentysta')!.extendedProperties?.private?.taskId === row.id, LIMIT_MS, 'znacznik', 100);

    await fake.notify(tp);
    await fake.notify(tp);
    fake.invalidateSyncTokens(tp);
    await fake.notify(tp);
    await settle();
    const writes = fake.writes.length;
    for (let i = 0; i < 2; i++) expect((await fn('calendar-sync/tasks/flush', { cron: true, body: JSON.stringify({ userId: user.id }) })).status).toBe(200);
    expect((await fn('calendar-sync/cron/poll', { cron: true })).status).toBe(200);
    expect(fake.writes.slice(writes)).toEqual([]);
    expect((await db.from('tasks').select('id').eq('source->>eventId', 'usr0dentysta')).data).toHaveLength(1);
  });

  it('odnowiony kanał watch i powtórzone powiadomienia: 0 zapisów, 0 duplikatów, każde zadanie = jedno wydarzenie', async () => {
    const { data: cal } = await db.from('calendars').select('sync_state').eq('id', targetId).single();
    await db.from('calendars').update({ sync_state: { ...cal!.sync_state, channel: { ...cal!.sync_state.channel, expiration: Date.now() + 3600_000 } } }).eq('id', targetId);
    expect((await (await fn('calendar-sync/cron/renew', { cron: true })).json()).renewed).toBeGreaterThanOrEqual(1);
    expect(fake.activeChannels(tp)).toHaveLength(1);
    const writes = fake.writes.length;
    await fake.notify(tp);
    await fake.notify(tp);
    await settle();
    expect(fake.writes.slice(writes)).toEqual([]);

    const ids = live().map((e) => e.extendedProperties?.private?.taskId);
    expect(new Set(ids).size).toBe(ids.length);
    const { data: timed } = await db.from('tasks').select('id').eq('scope_id', work.id).not('due_time', 'is', null).is('deleted_at', null).neq('status', 'cancelled');
    expect(ids.sort()).toEqual(timed!.map((t) => t.id).sort());
    const { data: all } = await db.from('calendar_task_links').select('task_id, external_id, etag').eq('calendar_id', targetId);
    expect(all!.map((l) => l.task_id).sort()).toEqual(timed!.map((t) => t.id).sort());
    for (const l of all!) expect(l.etag).toBe(fake.calendars.get(tp)!.events.get(l.external_id)!.etag);
  });

  it('wyłączenie przestrzeni → wydarzenia znikają z Google, zadania bez zmian', async () => {
    const before = await task(t1);
    await push(user, [{ table: 'profiles', id: user.id, set: { calendar_sync: { accountId, workspaceIds: [] } } }]);
    await waitFor(async () => live().length === 0, LIMIT_MS, 'puste wydarzenia', 100);
    expect((await task(t1)).due_time).toBe(before.due_time);
    expect((await db.from('calendar_task_links').select('task_id').eq('calendar_id', targetId)).data).toEqual([]);
  });

  it('kalendarz „Task Planner” usunięty w Google → wysyłanie wyłączone, zadania zostają', async () => {
    await push(user, [{ table: 'profiles', id: user.id, set: { calendar_sync: { accountId, workspaceIds: [work.id] } } }]);
    await waitFor(async () => eventFor(t1), LIMIT_MS, 'wydarzenia po włączeniu', 100);
    fake.calendars.delete(tp);
    expect((await fn('calendar-sync/tasks/flush', { cron: true, body: JSON.stringify({ userId: user.id }) })).status).toBe(200);
    const { data: profile } = await db.from('profiles').select('calendar_sync, field_clock').eq('id', user.id).single();
    expect(profile!.calendar_sync).toBeNull();
    expect(profile!.field_clock.calendar_sync).toMatch(/:server$/);
    expect((await db.from('calendars').select('id').eq('id', targetId)).data).toEqual([]);
    expect((await task(t1)).due_time).toBe('08:15');
  });
});

describe('Konto bez zgody na zapis', () => {
  it('wybór przestrzeni → komunikat na koncie, bez kalendarza w Google', async () => {
    const user = await createUser('tylko-odczyt');
    const created = fake.counts.createCalendar;
    const accountId = await connectGoogle(user, 'read-only-code');
    const ws = await createWorkspace(user, 'Praca');
    await push(user, [{ table: 'profiles', id: user.id, set: { calendar_sync: { accountId, workspaceIds: [ws.id] } } }]);
    const acc = await waitFor(async () => {
      const { data } = await user.client.from('calendar_accounts').select('status, last_error').eq('id', accountId).single();
      return data?.last_error && data;
    }, 20_000, 'komunikat o zgodzie');
    expect(acc.last_error).toContain('Brak zgody na zapis');
    // Odświeżenie konta nie kasuje komunikatu.
    expect((await fn('calendar-sync/accounts/sync', { jwt: user.jwt, body: JSON.stringify({ accountId }) })).status).toBe(200);
    expect((await user.client.from('calendar_accounts').select('last_error').eq('id', accountId).single()).data!.last_error).toContain('Brak zgody na zapis');
    expect(fake.counts.createCalendar).toBe(created);
  });
});
