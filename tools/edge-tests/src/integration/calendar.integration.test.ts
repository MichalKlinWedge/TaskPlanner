/**
 * PoC-6 — kalendarze: Google (OAuth → Vault → calendarList → events.list → watch → webhook → syncToken)
 * na fałszywym Google oraz ICS (dodanie, zmiana pliku, `pg_cron` → `pg_net` → funkcja).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeServices } from './fake-services.ts';
import { adminClient, createUser, fn, measure, sql, waitFor, type TestUser } from './helpers.ts';

const fake = new FakeServices();
const db = adminClient();
const PRIMARY = 'tester@gmail.com';
const at = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await fake.start();
  fake.addCalendar({ id: PRIMARY, summary: PRIMARY, primary: true, selected: true }, [
    { id: 'ev1', summary: 'Planowanie', start: { dateTime: at(1) }, end: { dateTime: at(1, 11) } },
    { id: 'ev2', summary: 'Urlop', start: { date: day(5) }, end: { date: day(7) } },
    { id: 'ev3', summary: 'Przegląd', start: { dateTime: at(2) }, end: { dateTime: at(2, 11) } },
    { id: 'ev4', summary: 'Stare', start: { dateTime: at(-60) }, end: { dateTime: at(-60, 11) } },
    { id: 'ev5', summary: 'Za rok', start: { dateTime: at(300) }, end: { dateTime: at(300, 11) } },
    { id: 'ev6', summary: 'Szkolenie', start: { dateTime: at(3) }, end: { dateTime: at(3, 12) } },
  ]);
  fake.addCalendar({ id: 'swieta@group.calendar.google.com', summary: 'Święta', selected: false }, [
    { id: 'h1', summary: 'Wigilia', start: { date: '2026-12-24' }, end: { date: '2026-12-25' } },
  ]);
});

afterAll(() => fake.stop());

const events = async (calendarId: string) => {
  const { data } = await db.from('calendar_events').select('*').eq('calendar_id', calendarId).is('deleted_at', null).order('external_id');
  return data ?? [];
};

describe('Google Calendar', () => {
  let user: TestUser;
  let accountId: string;
  let primaryId: string;

  it('OAuth: zgoda → token odświeżania w Vault → kalendarze → wydarzenia w oknie → kanał watch', async () => {
    user = await createUser('google');
    const start = await fn('calendar-sync/google/start', { jwt: user.jwt, body: '{}' });
    expect(start.status).toBe(200);
    const { url } = await start.json();
    const consent = new URL(url);
    expect(consent.searchParams.get('access_type')).toBe('offline');
    expect(consent.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:54521/functions/v1/calendar-sync/google/callback');

    const t0 = performance.now();
    const cb = await fetch(`${consent.searchParams.get('redirect_uri')}?code=good-code&state=${consent.searchParams.get('state')}`, { redirect: 'manual' });
    const page = await cb.text();
    measure('Google: połączenie konta (wymiana kodu + kalendarze + pełna synchronizacja + watch)', performance.now() - t0);
    expect(cb.status, page).toBe(200);
    expect(page).toContain('Połączono');

    const { data: acc } = await db.from('calendar_accounts').select('*').eq('user_id', user.id).single();
    accountId = acc!.id;
    expect(acc).toMatchObject({ provider: 'google', label: PRIMARY, status: 'active' });
    expect(acc!.secret_id).toBeTruthy();
    const { data: secret } = await db.rpc('account_secret_get', { p_account: accountId });
    expect(JSON.parse(secret)).toMatchObject({ refreshToken: 'rt-1' });

    const { data: cals } = await db.from('calendars').select('*').eq('account_id', accountId).order('name');
    expect(Object.fromEntries(cals!.map((c) => [c.name, c.visible]))).toEqual({ [PRIMARY]: true, 'Święta': false });
    primaryId = cals!.find((c) => c.external_id === PRIMARY)!.id;
    // Okno −30…+180: bez „Stare” i „Za rok”; stronicowanie po 3 (fałszywe Google).
    expect((await events(primaryId)).map((e) => e.external_id)).toEqual(['ev1', 'ev2', 'ev3', 'ev6']);
    expect((await events(cals!.find((c) => c.name === 'Święta')!.id))).toHaveLength(0);
    expect(fake.activeChannels(PRIMARY)).toHaveLength(1);
    expect(fake.activeChannels('swieta@group.calendar.google.com')).toHaveLength(0);
  });

  it('webhook: zmiana w Google → calendar_events (syncToken, tylko zmienione wiersze)', async () => {
    const before = Object.fromEntries((await events(primaryId)).map((e) => [e.external_id, e.row_version]));
    fake.upsertEvent(PRIMARY, { id: 'ev1', summary: 'Planowanie Q1', start: { dateTime: at(1, 9) }, end: { dateTime: at(1, 10) } });
    fake.deleteEvent(PRIMARY, 'ev3');
    fake.upsertEvent(PRIMARY, { id: 'ev7', summary: 'Nowe', start: { dateTime: at(4) }, end: { dateTime: at(4, 11) }, location: 'Sala 1' });
    const listsBefore = fake.counts.list;

    const t0 = performance.now();
    expect(await fake.notify(PRIMARY)).toEqual([200]);
    const after = await waitFor(async () => {
      const rows = await events(primaryId);
      return rows.some((e) => e.title === 'Planowanie Q1') && rows.some((e) => e.external_id === 'ev7') && rows;
    }, 10_000, 'zmiany z webhooka');
    measure('Google: powiadomienie watch → zapis w calendar_events', performance.now() - t0);

    expect(after.map((e) => e.external_id)).toEqual(['ev1', 'ev2', 'ev6', 'ev7']);
    expect(after.find((e) => e.external_id === 'ev7')).toMatchObject({ location: 'Sala 1', all_day: false });
    expect(after.find((e) => e.external_id === 'ev2')!.row_version).toBe(before.ev2); // niezmienione nie są przepisywane
    expect(fake.counts.list - listsBefore).toBe(1); // jedna strona przyrostu
    const { data: gone } = await db.from('calendar_events').select('deleted_at').eq('calendar_id', primaryId).eq('external_id', 'ev3').single();
    expect(gone!.deleted_at).not.toBeNull();
  });

  it('webhook: zły token kanału → 401, nieznany kanał → 200 bez zmian, „sync” → 200', async () => {
    const ch = fake.activeChannels(PRIMARY)[0]!;
    const hook = ch.address;
    const bad = await fetch(hook, { method: 'POST', headers: { 'x-goog-channel-id': ch.id, 'x-goog-channel-token': 'zly', 'x-goog-resource-state': 'exists' } });
    expect(bad.status).toBe(401);
    const unknown = await fetch(hook, { method: 'POST', headers: { 'x-goog-channel-id': crypto.randomUUID(), 'x-goog-resource-state': 'exists' } });
    expect(unknown.status).toBe(200);
    expect(await fake.notify(PRIMARY, 'sync')).toEqual([200]);
  });

  it('wygasły syncToken (410) → pełna synchronizacja, brakujące usunięte', async () => {
    fake.invalidateSyncTokens(PRIMARY);
    fake.deleteEvent(PRIMARY, 'ev6');
    await fake.notify(PRIMARY);
    const rows = await waitFor(async () => {
      const r = await events(primaryId);
      return !r.some((e) => e.external_id === 'ev6') && r;
    }, 10_000, 'pełna synchronizacja po 410');
    expect(rows.map((e) => e.external_id)).toEqual(['ev1', 'ev2', 'ev7']);
  });

  it('token dostępu wygasa → odświeżenie i zapis w Vault', async () => {
    // Następny token ważny 30 s (< 60 s zapasu) → każda synchronizacja odświeża.
    fake.expiresIn = 30;
    const { data: s1 } = await db.rpc('account_secret_get', { p_account: accountId });
    await db.rpc('account_secret_set', { p_account: accountId, p_secret: JSON.stringify({ ...JSON.parse(s1), expiresAt: Date.now() }) });
    const refreshes = fake.counts.refresh;
    const res = await fn('calendar-sync/accounts/sync', { jwt: user.jwt, body: JSON.stringify({ accountId }) });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.counts.refresh).toBe(refreshes + 1);
    const { data: s2 } = await db.rpc('account_secret_get', { p_account: accountId });
    expect(JSON.parse(s2).accessToken).not.toBe(JSON.parse(s1).accessToken);
    fake.expiresIn = 3600;
  });

  it('cron/renew: kanał bliski wygaśnięcia → nowy kanał, stary zatrzymany', async () => {
    const old = fake.activeChannels(PRIMARY)[0]!;
    const { data: cal } = await db.from('calendars').select('sync_state').eq('id', primaryId).single();
    await db.from('calendars').update({ sync_state: { ...cal!.sync_state, channel: { ...cal!.sync_state.channel, expiration: Date.now() + 3600_000 } } }).eq('id', primaryId);
    const res = await fn('calendar-sync/cron/renew', { cron: true });
    // Inne konta w lokalnej bazie (np. prawdziwe Google konta dev) mogą tu nie przejść przez fałszywe Google — liczy się nasz kanał.
    expect((await res.json()).renewed).toBeGreaterThanOrEqual(1);
    const active = fake.activeChannels(PRIMARY);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(old.id);
    expect(fake.channels.get(old.id)!.stopped).toBe(true);
    expect((await fn('calendar-sync/cron/renew')).status).toBe(401);
  });

  it('RLS: właściciel widzi konto bez sekretów, obcy nic; klient nie pisze', async () => {
    const own = await user.client.from('calendar_accounts').select('id, label, status');
    expect(own.data).toHaveLength(1);
    expect((await user.client.from('calendar_accounts').select('secret_id')).error?.message).toMatch(/permission denied/);
    expect((await user.client.from('calendars').select('sync_state')).error?.message).toMatch(/permission denied/);
    expect((await user.client.from('calendar_events').select('id')).data!.length).toBeGreaterThan(0);
    expect((await user.client.rpc('account_secret_get', { p_account: accountId })).error).not.toBeNull();
    expect((await user.client.from('calendar_events').update({ title: 'x' }).eq('calendar_id', primaryId)).error?.message).toMatch(/permission denied/);
    const stranger = await createUser('obcy');
    expect((await stranger.client.from('calendar_events').select('id')).data).toEqual([]);
    expect((await stranger.client.from('calendar_accounts').select('id')).data).toEqual([]);
    const steal = await fn('calendar-sync/accounts/sync', { jwt: stranger.jwt, body: JSON.stringify({ accountId }) });
    expect(steal.status).toBe(404);
  });

  it('zakres bez kalendarza na ekranie zgody → komunikat, bez konta', async () => {
    const other = await createUser('bez-zakresu');
    const { url } = await (await fn('calendar-sync/google/start', { jwt: other.jwt, body: '{}' })).json();
    const u = new URL(url);
    const cb = await fetch(`${u.searchParams.get('redirect_uri')}?code=no-calendar-scope&state=${u.searchParams.get('state')}`);
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain('Brak dostępu do kalendarza');
    expect((await db.from('calendar_accounts').select('id').eq('user_id', other.id)).data).toEqual([]);
    // Ten sam `state` drugi raz — nieważny.
    const again = await fetch(`${u.searchParams.get('redirect_uri')}?code=good-code&state=${u.searchParams.get('state')}`);
    expect(again.status).toBe(400);
  });

  it('odwołany token odświeżania → konto `revoked`', async () => {
    fake.refreshTokenRevoked = true;
    const { data: s } = await db.rpc('account_secret_get', { p_account: accountId });
    await db.rpc('account_secret_set', { p_account: accountId, p_secret: JSON.stringify({ ...JSON.parse(s), expiresAt: 0 }) });
    const res = await fn('calendar-sync/accounts/sync', { jwt: user.jwt, body: JSON.stringify({ accountId }) });
    expect(res.status).toBe(500);
    const { data: acc } = await db.from('calendar_accounts').select('status, last_error').eq('id', accountId).single();
    expect(acc!.status).toBe('revoked');
    fake.refreshTokenRevoked = false;
  });

  it('odłączenie: kanały zatrzymane, token odwołany, wydarzenia i sekret Vault usunięte', async () => {
    const { data: acc } = await db.from('calendar_accounts').select('secret_id').eq('id', accountId).single();
    const res = await fn('calendar-sync/accounts/delete', { jwt: user.jwt, body: JSON.stringify({ accountId }) });
    expect(res.status).toBe(200);
    expect(fake.activeChannels(PRIMARY)).toHaveLength(0);
    expect(fake.counts.revoke).toBeGreaterThan(0);
    expect((await db.from('calendar_events').select('id').eq('calendar_id', primaryId)).data).toEqual([]);
    expect(sql(`select count(*) from vault.secrets where id = '${acc!.secret_id}'`)).toBe('0');
    fake.refreshTokenRevoked = false;
  });
});

const ICS = (summary: string, extra = '') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Firma (ICS)', 'X-WR-TIMEZONE:Europe/Warsaw',
  'BEGIN:VEVENT', 'UID:daily@firma', `DTSTART;TZID=Europe/Warsaw:${day(-40).replaceAll('-', '')}T091500`,
  `DTEND;TZID=Europe/Warsaw:${day(-40).replaceAll('-', '')}T093000`, 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', `SUMMARY:${summary}`, 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:one@firma', `DTSTART:${at(2).replace(/[-:]/g, '').slice(0, 15)}Z`, 'DURATION:PT1H', 'SUMMARY:Spotkanie z klientem', 'END:VEVENT',
  extra,
  'END:VCALENDAR',
].filter(Boolean).join('\r\n');

describe('ICS', () => {
  let user: TestUser;
  let calendarId: string;

  it('dodanie adresu: Vault, kalendarz z nazwą z pliku, rozwinięte wystąpienia', async () => {
    user = await createUser('ics');
    fake.setIcs('firma', ICS('Daily'));
    const res = await fn('calendar-sync/ics/add', { jwt: user.jwt, body: JSON.stringify({ url: fake.icsUrl('firma') }) });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    const { data: cal } = await db.from('calendars').select('*').eq('account_id', body.accountId).single();
    calendarId = cal!.id;
    expect(cal!.name).toBe('Firma (ICS)');
    const rows = await events(calendarId);
    expect(rows.find((e) => e.external_id === 'one@firma')).toBeTruthy();
    // Dni robocze w oknie −30…+180: ~150 wystąpień.
    expect(rows.filter((e) => e.external_id.startsWith('daily@firma/')).length).toBeGreaterThan(140);
    const { data: secret } = await db.rpc('account_secret_get', { p_account: body.accountId });
    expect(secret).toBe(fake.icsUrl('firma'));
    expect((await user.client.from('calendar_accounts').select('label')).data).toEqual([{ label: 'Firma (ICS)' }]);
  });

  it('niezmieniony plik → 304 (If-None-Match), bez zapisu', async () => {
    const before = fake.icsRequests.length;
    const res = await fn('calendar-sync/cron/poll', { cron: true });
    expect(res.status).toBe(200);
    expect(fake.icsRequests.slice(before), JSON.stringify(fake.icsRequests)).toEqual([{ name: 'firma', ifNoneMatch: expect.any(String), status: 304 }]);
  });

  it('zmiana pliku → pg_cron → pg_net → calendar-sync/cron/poll → calendar_events', async () => {
    expect(sql(`select schedule from cron.job where jobname = 'taskplanner-calendar-poll'`)).toBe('*/15 * * * *');
    fake.setIcs('firma', ICS('Daily standup', ['BEGIN:VEVENT', 'UID:new@firma', `DTSTART;VALUE=DATE:${day(10).replaceAll('-', '')}`, 'SUMMARY:Dzień firmy', 'END:VEVENT'].join('\r\n')));
    const t0 = performance.now();
    // To samo, co robi zadanie crona co 15 minut.
    sql(`select public.call_edge_function('calendar-sync/cron/poll')`);
    const rows = await waitFor(async () => {
      const r = await events(calendarId);
      return r.some((e) => e.external_id === 'new@firma') && r.every((e) => !e.external_id.startsWith('daily@') || e.title === 'Daily standup') && r;
    }, 30_000, 'ICS po cronie');
    measure('ICS: wywołanie z pg_cron (pg_net) → zapis w calendar_events', performance.now() - t0);
    expect(rows.find((e) => e.external_id === 'new@firma')).toMatchObject({ all_day: true, start_date: day(10) });
  });
});
