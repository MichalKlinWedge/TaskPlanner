/**
 * Etap 5 — kalendarze zewnętrzne w lokalnej bazie: `calendar_accounts` / `calendars` /
 * `calendar_events` przychodzą w `pull_changes` tylko do odczytu (bez sekretów), usunięte wydarzenie
 * i odłączone konto (nagrobek) znikają z urządzenia. `npm run test:sync`.
 */
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, expect, inject, it } from 'vitest';

import { createDevice, createUser, type Device, type TestUser } from './helpers/devices.ts';

let user: TestUser;
let web: Device;
const admin = () => {
  const { url, serviceKey } = inject('supabase');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const check = <T>(result: { data: T; error: { message: string } | null }): NonNullable<T> => {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null || result.data === undefined) throw new Error('brak danych');
  return result.data;
};

beforeEach(async () => {
  user = await createUser('kalendarz');
  web = await createDevice(user, 'web');
});

afterEach(async () => {
  await web.close();
});

it('konto, kalendarz i wydarzenia na urządzeniu; usunięcie wydarzenia i odłączenie konta', async () => {
  // Wcześniejsza synchronizacja (zakres osobisty już ma wersję) — kalendarz dochodzi przyrostowo.
  await web.engine.sync();
  const db = admin();
  const account = check(await db.from('calendar_accounts').insert({ user_id: user.id, provider: 'ics', external_id: 'abc', label: 'Firma', sync_state: { secret: 'x' } }).select().single());
  const calendar = check(await db.from('calendars').insert({ account_id: account.id, external_id: 'ics', name: 'Firma', color: '#123456', sync_state: { etag: 'e' } }).select().single());
  const start = new Date(Date.now() + 86_400_000);
  const events = check(
    await db
      .from('calendar_events')
      .insert([
        { calendar_id: calendar.id, external_id: 'e1', title: 'Spotkanie', all_day: false, start_date: null, end_date: null, start_at: start.toISOString(), end_at: new Date(start.getTime() + 3_600_000).toISOString(), etag: 'tajne' },
        { calendar_id: calendar.id, external_id: 'e2', title: 'Urlop', all_day: true, start_date: '2026-12-01', end_date: '2026-12-03', start_at: null, end_at: null, etag: null },
      ])
      .select(),
  );

  await web.engine.sync();
  expect(await web.engine.get('calendar_accounts', account.id)).toMatchObject({ label: 'Firma', provider: 'ics', scope_id: user.id });
  expect(await web.engine.get('calendars', calendar.id)).toMatchObject({ name: 'Firma', visible: 1, account_id: account.id });
  const e1 = await web.engine.get('calendar_events', events[0]!.id);
  expect(e1).toMatchObject({ title: 'Spotkanie', all_day: 0, calendar_id: calendar.id });
  expect(e1).not.toHaveProperty('etag');
  expect(await web.engine.get('calendar_events', events[1]!.id)).toMatchObject({ all_day: 1, start_date: '2026-12-01', end_date: '2026-12-03' });

  // Usunięte wydarzenie (synchronizacja przyrostowa ustawia `deleted_at`).
  check(await db.from('calendar_events').update({ deleted_at: new Date().toISOString() }).eq('id', events[1]!.id).select());
  await web.engine.sync();
  expect(await web.engine.get('calendar_events', events[1]!.id)).toBeUndefined();

  // Odłączenie konta: kaskada na serwerze, nagrobek → konto, kalendarz i wydarzenia znikają.
  check(await db.from('calendar_accounts').delete().eq('id', account.id).select());
  await web.engine.sync();
  expect(await web.engine.get('calendar_accounts', account.id)).toBeUndefined();
  expect(await web.engine.get('calendars', calendar.id)).toBeUndefined();
  expect(await web.engine.get('calendar_events', events[0]!.id)).toBeUndefined();
});

it('pierwsza synchronizacja nowego urządzenia: bez nagrobków, z istniejącymi kalendarzami', async () => {
  const db = admin();
  const gone = check(await db.from('calendar_accounts').insert({ user_id: user.id, provider: 'ics', external_id: 'old', label: 'Stare' }).select().single());
  check(await db.from('calendar_accounts').delete().eq('id', gone.id).select());
  const account = check(await db.from('calendar_accounts').insert({ user_id: user.id, provider: 'google', external_id: 'ja@example.com', label: 'ja@example.com' }).select().single());
  const phone = await createDevice(user, 'phone');
  try {
    await phone.engine.sync();
    expect(await phone.engine.get('calendar_accounts', account.id)).toMatchObject({ provider: 'google' });
    expect(await phone.engine.get('calendar_accounts', gone.id)).toBeUndefined();
  } finally {
    await phone.close();
  }
});
