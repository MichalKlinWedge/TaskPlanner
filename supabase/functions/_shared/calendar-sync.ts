/**
 * Synchronizacja kalendarzy zewnętrznych do `calendar_events` (klient `service_role`): Google przez
 * `events.list` z `syncToken` i kanały `watch`, ICS przez pobranie całego pliku z `If-None-Match`.
 * Zapisuje tylko zmienione wiersze (etag), więc powtórka nie podbija wersji. Bez Deno — działa też w Node.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { syncWindow, type EventRow, type SyncWindow } from './calendar.ts';
import {
  ensureAccessToken,
  GoogleError,
  listCalendars,
  listEvents,
  mapGoogleEvent,
  stopChannel,
  watchEvents,
  type Channel,
  type GoogleConfig,
  type GoogleSecret,
} from './google.ts';
import { expandIcs, parseIcs } from './ics.ts';

export interface AccountRow {
  id: string;
  user_id: string;
  provider: 'google' | 'ics';
  label: string;
  external_id: string;
  status: string;
  sync_state: Record<string, unknown>;
}

export interface CalendarRow {
  id: string;
  account_id: string;
  user_id: string;
  external_id: string;
  name: string;
  visible: boolean;
  sync_state: { syncToken?: string; channel?: Channel; etag?: string; lastModified?: string; hash?: string };
  last_synced_at: string | null;
}

export interface SyncResult {
  calendarId: string;
  upserted: number;
  deleted: number;
  full: boolean;
  skipped?: boolean;
  warnings?: string[];
}

const check = <T>({ data, error }: { data: T; error: { message: string } | null }, what: string): T => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

// ── Zapis wydarzeń ───────────────────────────────────────────────────────────────────────────

/**
 * `full`: `rows` to komplet — reszta żywych wydarzeń kalendarza jest usuwana. Inaczej usuwane są tylko
 * `removed` (zmiany z `syncToken`). Usunięcie = `deleted_at` (klient dostaje je jako przyrost).
 */
export async function saveEvents(db: SupabaseClient, calendar: Pick<CalendarRow, 'id'>, rows: EventRow[], opts: { full: boolean; removed?: string[] }): Promise<{ upserted: number; deleted: number }> {
  const existing = new Map<string, { etag: string | null; deleted_at: string | null }>();
  const load = async (ids?: string[]) => {
    let q = db.from('calendar_events').select('external_id, etag, deleted_at').eq('calendar_id', calendar.id);
    if (ids) q = q.in('external_id', ids);
    for (const r of check(await q, 'calendar_events') ?? []) existing.set(r.external_id, r);
  };
  if (opts.full) await load();
  else for (const part of chunks([...rows.map((r) => r.external_id), ...(opts.removed ?? [])], 100)) await load(part);

  const changed = rows.filter((r) => {
    const e = existing.get(r.external_id);
    return !e || e.etag !== r.etag || e.deleted_at !== null;
  });
  for (const part of chunks(changed, 500)) {
    check(
      await db.from('calendar_events').upsert(
        part.map((r) => ({ ...r, calendar_id: calendar.id, deleted_at: null })),
        { onConflict: 'calendar_id,external_id' },
      ),
      'upsert calendar_events',
    );
  }

  const keep = new Set(rows.map((r) => r.external_id));
  const toDelete = (opts.full ? [...existing.keys()].filter((id) => !keep.has(id)) : (opts.removed ?? []))
    .filter((id) => existing.get(id) && existing.get(id)!.deleted_at === null);
  const now = new Date().toISOString();
  for (const part of chunks(toDelete, 100)) {
    check(await db.from('calendar_events').update({ deleted_at: now }).eq('calendar_id', calendar.id).in('external_id', part), 'delete calendar_events');
  }
  return { upserted: changed.length, deleted: toDelete.length };
}

async function markAccount(db: SupabaseClient, accountId: string, patch: Record<string, unknown>) {
  check(await db.from('calendar_accounts').update(patch).eq('id', accountId), 'calendar_accounts');
}

async function saveCalendarState(db: SupabaseClient, calendar: CalendarRow, state: CalendarRow['sync_state']) {
  calendar.sync_state = state;
  check(await db.from('calendars').update({ sync_state: state, last_synced_at: new Date().toISOString() }).eq('id', calendar.id), 'calendars');
}

// ── Google ───────────────────────────────────────────────────────────────────────────────────

export async function readSecret<T>(db: SupabaseClient, accountId: string): Promise<T> {
  const value = check(await db.rpc('account_secret_get', { p_account: accountId }), 'account_secret_get');
  if (!value) throw new Error('Brak sekretu konta');
  return (typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : value) as T;
}

export async function writeSecret(db: SupabaseClient, accountId: string, secret: unknown): Promise<void> {
  check(await db.rpc('account_secret_set', { p_account: accountId, p_secret: typeof secret === 'string' ? secret : JSON.stringify(secret) }), 'account_secret_set');
}

/** Token dostępu konta Google; odświeżony zapisuje się w Vault, odwołany oznacza konto `revoked`. */
export async function googleToken(db: SupabaseClient, cfg: GoogleConfig, accountId: string): Promise<string> {
  const secret = await readSecret<GoogleSecret>(db, accountId);
  try {
    const r = await ensureAccessToken(cfg, secret);
    if (r.changed) await writeSecret(db, accountId, r.secret);
    return r.token;
  } catch (error) {
    if (error instanceof GoogleError && error.revoked) {
      await markAccount(db, accountId, { status: 'revoked', last_error: 'Dostęp odwołany — połącz konto ponownie' });
    }
    throw error;
  }
}

/** Lista kalendarzy konta → `calendars` (nowe: widoczne, jeśli zaznaczone w Google). */
export async function refreshGoogleCalendars(db: SupabaseClient, cfg: GoogleConfig, account: AccountRow, token: string): Promise<CalendarRow[]> {
  const entries = (await listCalendars(cfg, token)).filter((c) => !c.deleted);
  const known = check(await db.from('calendars').select('*').eq('account_id', account.id), 'calendars') as CalendarRow[];
  const byId = new Map(known.map((c) => [c.external_id, c]));
  const upserts = entries.map((e) => ({
    account_id: account.id,
    external_id: e.id,
    name: e.summaryOverride ?? e.summary,
    color: e.backgroundColor ?? null,
    visible: byId.get(e.id)?.visible ?? Boolean(e.selected || e.primary),
  }));
  if (upserts.length) check(await db.from('calendars').upsert(upserts, { onConflict: 'account_id,external_id' }), 'upsert calendars');
  return check(await db.from('calendars').select('*').eq('account_id', account.id), 'calendars') as CalendarRow[];
}

export async function syncGoogleCalendar(db: SupabaseClient, cfg: GoogleConfig, calendar: CalendarRow, token: string, window: SyncWindow = syncWindow(Date.now())): Promise<SyncResult> {
  let page;
  try {
    page = await listEvents(cfg, token, calendar.external_id, calendar.sync_state.syncToken ?? null, window);
  } catch (error) {
    if (!(error instanceof GoogleError && error.gone)) throw error;
    page = await listEvents(cfg, token, calendar.external_id, null, window);
  }
  const rows: EventRow[] = [];
  const removed: string[] = [];
  for (const item of page.items) {
    const row = mapGoogleEvent(item, window);
    if (row) rows.push(row);
    else removed.push(item.id);
  }
  const saved = await saveEvents(db, calendar, rows, { full: page.full, removed });
  const { syncToken: _old, ...rest } = calendar.sync_state;
  await saveCalendarState(db, calendar, page.nextSyncToken ? { ...rest, syncToken: page.nextSyncToken } : rest);
  return { calendarId: calendar.id, ...saved, full: page.full };
}

/** Nowy kanał `watch`; stary (jeśli był) zatrzymany dopiero po założeniu nowego — bez przerwy w powiadomieniach. */
export async function watchCalendar(db: SupabaseClient, cfg: GoogleConfig, calendar: CalendarRow, token: string, address: string, ttlSeconds?: number): Promise<Channel> {
  const old = calendar.sync_state.channel;
  const channel = await watchEvents(cfg, token, calendar.external_id, address, {
    id: crypto.randomUUID(),
    token: crypto.randomUUID().replaceAll('-', ''),
    ttlSeconds,
  });
  await saveCalendarState(db, calendar, { ...calendar.sync_state, channel });
  if (old) await stopChannel(cfg, token, old).catch((e) => console.warn('stop channel', e));
  return channel;
}

export async function unwatchCalendar(cfg: GoogleConfig, calendar: CalendarRow, token: string): Promise<void> {
  if (calendar.sync_state.channel) await stopChannel(cfg, token, calendar.sync_state.channel);
}

// ── ICS ──────────────────────────────────────────────────────────────────────────────────────

export function normalizeIcsUrl(raw: string): string {
  const url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Adres ICS musi być http(s)');
  return url.toString();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchIcs(url: string, state: CalendarRow['sync_state'] = {}): Promise<{ notModified: true } | { notModified: false; text: string; etag: string | null; lastModified: string | null }> {
  const headers: Record<string, string> = { accept: 'text/calendar, */*' };
  if (state.etag) headers['if-none-match'] = state.etag;
  if (state.lastModified) headers['if-modified-since'] = state.lastModified;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`ICS: HTTP ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw new Error('ICS: to nie jest plik iCalendar');
  return { notModified: false, text, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}

export async function syncIcsCalendar(db: SupabaseClient, account: AccountRow, calendar: CalendarRow, window: SyncWindow = syncWindow(Date.now())): Promise<SyncResult> {
  const url = await readSecret<string>(db, account.id);
  const got = await fetchIcs(url, calendar.sync_state);
  if (got.notModified) {
    await saveCalendarState(db, calendar, calendar.sync_state);
    return { calendarId: calendar.id, upserted: 0, deleted: 0, full: true, skipped: true };
  }
  const hash = await sha256Hex(got.text);
  const state = { etag: got.etag ?? undefined, lastModified: got.lastModified ?? undefined, hash };
  // Ten sam plik, a okno przesuwa się o dzień: liczymy od nowa najwyżej raz na dobę.
  const sameDay = calendar.last_synced_at && Date.now() - Date.parse(calendar.last_synced_at) < 86_400_000;
  if (calendar.sync_state.hash === hash && sameDay) {
    await saveCalendarState(db, calendar, state);
    return { calendarId: calendar.id, upserted: 0, deleted: 0, full: true, skipped: true };
  }
  const parsed = parseIcs(got.text);
  const { events, warnings } = expandIcs(parsed, window);
  const saved = await saveEvents(db, calendar, events, { full: true });
  if (parsed.name && parsed.name !== calendar.name) check(await db.from('calendars').update({ name: parsed.name }).eq('id', calendar.id), 'calendars');
  await saveCalendarState(db, calendar, state);
  return { calendarId: calendar.id, ...saved, full: true, warnings };
}

// ── Całe konto ───────────────────────────────────────────────────────────────────────────────

export interface SyncAccountOptions {
  cfg?: GoogleConfig;
  /** Adres webhooka dla `watch`; brak = bez kanałów (np. lokalnie po http). */
  webhookUrl?: string | null;
  /** Odśwież listę kalendarzy Google. */
  calendars?: boolean;
  /** Tylko kalendarze nieodświeżone od tylu ms (cron jako zapas dla `watch`). */
  staleMs?: number;
}

export async function syncAccount(db: SupabaseClient, account: AccountRow, opts: SyncAccountOptions = {}): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  try {
    if (account.provider === 'ics') {
      const cals = check(await db.from('calendars').select('*').eq('account_id', account.id), 'calendars') as CalendarRow[];
      for (const cal of cals) results.push(await syncIcsCalendar(db, account, cal));
    } else {
      const cfg = opts.cfg!;
      const token = await googleToken(db, cfg, account.id);
      const cals = opts.calendars
        ? await refreshGoogleCalendars(db, cfg, account, token)
        : (check(await db.from('calendars').select('*').eq('account_id', account.id), 'calendars') as CalendarRow[]);
      for (const cal of cals) {
        if (!cal.visible) {
          if (cal.sync_state.channel) {
            await unwatchCalendar(cfg, cal, token);
            const { channel: _c, ...rest } = cal.sync_state;
            await saveCalendarState(db, cal, rest);
          }
          continue;
        }
        if (opts.staleMs && cal.last_synced_at && Date.now() - Date.parse(cal.last_synced_at) < opts.staleMs) continue;
        results.push(await syncGoogleCalendar(db, cfg, cal, token));
        if (opts.webhookUrl && !cal.sync_state.channel) await watchCalendar(db, cfg, cal, token, opts.webhookUrl);
      }
    }
    await markAccount(db, account.id, { status: 'active', last_error: null, last_synced_at: new Date().toISOString() });
  } catch (error) {
    const revoked = error instanceof GoogleError && error.revoked;
    await markAccount(db, account.id, { status: revoked ? 'revoked' : 'error', last_error: String((error as Error).message ?? error).slice(0, 500) });
    throw error;
  }
  return results;
}
