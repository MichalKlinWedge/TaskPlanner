/**
 * Kalendarz „TaskPlanner” (Etap 12): zadania z godziną z wybranych przestrzeni ↔ wydarzenia jednego
 * kalendarza Google utworzonego przez aplikację. Klient `service_role`, bez Deno — działa też w Node.
 *
 * Jeden przebieg (`syncTaskCalendar`, pod dzierżawą kalendarza):
 *   1. zmiany z Google (`syncToken`; po 410 pełna lista) → zadania przez `calendar_task_apply` (HLC serwera);
 *      własne zapisy wracają z tym samym `etag` albo znacznikiem `tpRev` i są pomijane,
 *   2. uzgodnienie zadania → wydarzenia: brakujące wstawiane z identyfikatorem z id zadania (powtórka = 409,
 *      nie duplikat), zmienione — `PATCH` z `If-Match` (412 = ktoś zmienił w Google: najpierw scalenie),
 *      zbędne (zadanie bez godziny, usunięte, anulowane, przestrzeń wyłączona) — usuwane.
 * Każde wywołanie liczy wszystko od stanu w bazie, więc zgubiony sygnał nadrabia następny przebieg.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { googleToken, watchCalendar, type AccountRow, type CalendarRow } from './calendar-sync.ts';
import {
  CALENDAR_WRITE_SCOPE,
  deleteEvent,
  getEvent,
  GoogleError,
  insertCalendar,
  insertEvent,
  listCalendars,
  listEvents,
  patchEvent,
  type GoogleConfig,
  type GoogleEvent,
} from './google.ts';
import {
  desiredProjection,
  eventBody,
  eventChange,
  eventIdForTask,
  eventTaskId,
  isOwnContent,
  needsWrite,
  projectTask,
  TASK_COLUMNS,
  taskFromEvent,
  taskPatch,
  taskZone,
  type CalendarContext,
  type TaskForCalendar,
  type TaskProjection,
} from './task-events.ts';
import { DAY_MS, zonedParts } from './time.ts';

export const TASK_CALENDAR_NAME = 'TaskPlanner';
export const DEFAULT_ZONE = 'Europe/Warsaw';
export const WRITE_SCOPE_ERROR = 'Brak zgody na zapis w Google — połącz konto ponownie, żeby wysyłać zadania do kalendarza „TaskPlanner”.';
/** Starsze zadania nie dostają nowych wydarzeń (istniejące są dalej uzgadniane). */
const CREATE_FROM_DAYS = 30;

/** Znacznik kalendarza w jego opisie: po utracie wiersza w bazie przejmujemy go zamiast tworzyć drugi. */
export const calendarMarker = (userId: string) => `taskplanner:${userId}`;

interface ProfileRow {
  id: string;
  settings: { timeZone?: string; defaultDurationMin?: number } | null;
  calendar_sync: { accountId: string; workspaceIds: string[] } | null;
}

interface LinkRow {
  calendar_id: string;
  task_id: string;
  external_id: string;
  etag: string | null;
  pushed: TaskProjection;
}

export interface TaskSyncResult {
  calendarId: string;
  busy?: boolean;
  full?: boolean;
  /** Zmiany z Google zapisane w zadaniach. */
  pulled: number;
  /** Nowe zadania z wydarzeń dodanych w Google. */
  imported: number;
  /** Własne zapisy rozpoznane po `etag` / znaczniku. */
  echoes: number;
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
}

export interface TaskSyncOptions {
  webhookUrl?: string | null;
}

const check = <T>({ data, error }: { data: T; error: { message: string } | null }, what: string): T => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

async function loadProfile(db: SupabaseClient, userId: string): Promise<ProfileRow | null> {
  return check(await db.from('profiles').select('id, settings, calendar_sync').eq('id', userId).maybeSingle(), 'profiles') as ProfileRow | null;
}

function context(profile: ProfileRow, calendar: CalendarRow): CalendarContext {
  const sync = profile.calendar_sync;
  const zone = profile.settings?.timeZone ?? calendar.sync_state.timeZone ?? DEFAULT_ZONE;
  return {
    zone,
    defaultDurationMin: profile.settings?.defaultDurationMin ?? 30,
    workspaceIds: new Set(sync && sync.accountId === calendar.account_id ? sync.workspaceIds : []),
  };
}

async function setWriteError(db: SupabaseClient, account: AccountRow, error: string | null) {
  if ((account.sync_state.writeError ?? null) === error) return;
  const { writeError: _w, ...rest } = account.sync_state;
  const sync_state = error ? { ...rest, writeError: error } : rest;
  check(await db.from('calendar_accounts').update({ sync_state, ...(error ? { last_error: error } : {}) }).eq('id', account.id), 'calendar_accounts');
  account.sync_state = sync_state;
}

/**
 * Kalendarz „TaskPlanner” wybranego konta: istniejący wiersz, przejęty po znaczniku albo nowo utworzony
 * w Google. `null` = nic do wysyłania, brak konta albo brak zgody na zapis (wtedy komunikat na koncie).
 */
export async function ensureTaskCalendar(db: SupabaseClient, cfg: GoogleConfig, profile: ProfileRow): Promise<CalendarRow | null> {
  const sync = profile.calendar_sync;
  if (!sync) return null;
  const existing = check(await db.from('calendars').select('*').eq('account_id', sync.accountId).eq('is_task_target', true).maybeSingle(), 'calendars') as CalendarRow | null;
  if (existing) return existing;
  if (!sync.workspaceIds.length) return null;
  const account = check(await db.from('calendar_accounts').select('*').eq('id', sync.accountId).eq('user_id', profile.id).eq('provider', 'google').maybeSingle(), 'calendar_accounts') as AccountRow | null;
  if (!account || account.status === 'revoked') return null;
  const scopes = (account.sync_state.scopes as string[] | undefined) ?? [];
  if (!scopes.includes(CALENDAR_WRITE_SCOPE)) {
    await setWriteError(db, account, WRITE_SCOPE_ERROR);
    return null;
  }
  const token = await googleToken(db, cfg, account.id);
  const entries = await listCalendars(cfg, token);
  const marker = calendarMarker(profile.id);
  const found = entries.find((e) => !e.deleted && e.description?.includes(marker));
  const zone = profile.settings?.timeZone ?? entries.find((e) => e.primary)?.timeZone ?? DEFAULT_ZONE;
  const externalId = found?.id ?? (await insertCalendar(cfg, token, {
    summary: TASK_CALENDAR_NAME,
    description: `Zadania z godziną z TaskPlanner — zmiany tutaj wracają do zadań. Nie zmieniaj tej linijki: ${marker}`,
    timeZone: zone,
  })).id;
  const row = check(
    await db.from('calendars').upsert(
      { account_id: account.id, external_id: externalId, name: found?.summaryOverride ?? found?.summary ?? TASK_CALENDAR_NAME, is_task_target: true, visible: true, sync_state: { timeZone: found?.timeZone ?? zone } },
      { onConflict: 'account_id,external_id' },
    ).select().single(),
    'upsert calendars',
  ) as CalendarRow;
  // Przejęty kalendarz mógł być wcześniej czytany jak zwykły — jego wydarzenia byłyby duplikatami zadań.
  check(await db.from('calendar_events').delete().eq('calendar_id', row.id), 'calendar_events');
  await setWriteError(db, account, null);
  return row;
}

/** Wszystkie kalendarze zadań użytkownika (bieżący i dawne — te ostatnie tylko się opróżniają). */
export async function flushUser(db: SupabaseClient, cfg: GoogleConfig, userId: string, opts: TaskSyncOptions = {}): Promise<TaskSyncResult[]> {
  const profile = await loadProfile(db, userId);
  if (!profile) return [];
  await ensureTaskCalendar(db, cfg, profile);
  const targets = check(
    await db.from('calendars').select('*, calendar_accounts!inner(provider, status)').eq('user_id', userId).eq('is_task_target', true)
      .eq('calendar_accounts.provider', 'google').neq('calendar_accounts.status', 'revoked'),
    'calendars',
  ) as CalendarRow[];
  const results: TaskSyncResult[] = [];
  for (const target of targets) results.push(await syncTaskCalendar(db, cfg, target, opts));
  return results;
}

/** Użytkownicy, dla których cron uzgadnia kalendarz zadań. */
export async function taskCalendarUsers(db: SupabaseClient): Promise<string[]> {
  const withSync = check(await db.from('profiles').select('id').not('calendar_sync', 'is', null), 'profiles') as { id: string }[];
  const withTarget = check(await db.from('calendars').select('user_id').eq('is_task_target', true), 'calendars') as { user_id: string }[];
  return [...new Set([...withSync.map((p) => p.id), ...withTarget.map((c) => c.user_id)])];
}

/** Jeden kalendarz pod dzierżawą; zajęty — prośba o powtórkę dla posiadacza (`busy`). */
export async function syncTaskCalendar(db: SupabaseClient, cfg: GoogleConfig, calendar: CalendarRow, opts: TaskSyncOptions = {}): Promise<TaskSyncResult> {
  const holder = crypto.randomUUID();
  const empty = (): TaskSyncResult => ({ calendarId: calendar.id, pulled: 0, imported: 0, echoes: 0, created: 0, updated: 0, deleted: 0, conflicts: 0 });
  if (!check(await db.rpc('calendar_task_lock', { p_calendar: calendar.id, p_holder: holder }), 'calendar_task_lock')) return { ...empty(), busy: true };
  const total = empty();
  try {
    for (let pass = 0; pass < 5; pass++) {
      const fresh = check(await db.from('calendars').select('*').eq('id', calendar.id).maybeSingle(), 'calendars') as CalendarRow | null;
      if (!fresh) return total;
      const r = await new TaskCalendarRun(db, cfg, fresh, opts).run();
      for (const k of ['pulled', 'imported', 'echoes', 'created', 'updated', 'deleted', 'conflicts'] as const) total[k] += r[k];
      total.full ||= r.full;
      if (r.gone) return total;
      if (!check(await db.rpc('calendar_task_unlock', { p_calendar: calendar.id, p_holder: holder }), 'calendar_task_unlock')) return total;
    }
  } catch (error) {
    await db.from('calendar_task_runs').update({ holder: null, expires_at: null }).eq('calendar_id', calendar.id).eq('holder', holder);
    throw error;
  }
  await db.from('calendar_task_runs').update({ holder: null, expires_at: null }).eq('calendar_id', calendar.id).eq('holder', holder);
  return total;
}

class TaskCalendarRun {
  private readonly byTask = new Map<string, LinkRow>();
  private readonly byExternal = new Map<string, LinkRow>();
  private ctx!: CalendarContext;
  private profile!: ProfileRow;
  private token!: string;
  private readonly result = { pulled: 0, imported: 0, echoes: 0, created: 0, updated: 0, deleted: 0, conflicts: 0, full: false, gone: false };

  private readonly db: SupabaseClient;
  private readonly cfg: GoogleConfig;
  private readonly calendar: CalendarRow;
  private readonly opts: TaskSyncOptions;

  constructor(db: SupabaseClient, cfg: GoogleConfig, calendar: CalendarRow, opts: TaskSyncOptions) {
    this.db = db;
    this.cfg = cfg;
    this.calendar = calendar;
    this.opts = opts;
  }

  async run() {
    const profile = await loadProfile(this.db, this.calendar.user_id);
    if (!profile) return this.result;
    this.profile = profile;
    this.ctx = context(profile, this.calendar);
    this.token = await googleToken(this.db, this.cfg, this.calendar.account_id);
    for (const link of check(await this.db.from('calendar_task_links').select('*').eq('calendar_id', this.calendar.id), 'calendar_task_links') as LinkRow[]) {
      this.remember(link);
    }
    if (!(await this.pull())) return this.result;
    await this.push();
    if (this.opts.webhookUrl && !this.calendar.sync_state.channel && !this.calendar.sync_state.noWatch) {
      try {
        await watchCalendar(this.db, this.cfg, this.calendar, this.token, this.opts.webhookUrl);
      } catch (error) {
        if (!(error instanceof GoogleError && error.status === 400)) throw error;
        await this.saveState({ ...this.calendar.sync_state, noWatch: true });
      }
    }
    return this.result;
  }

  private remember(link: LinkRow) {
    this.byTask.set(link.task_id, link);
    this.byExternal.set(link.external_id, link);
  }

  private forget(link: LinkRow) {
    this.byTask.delete(link.task_id);
    this.byExternal.delete(link.external_id);
  }

  private async saveState(state: CalendarRow['sync_state']) {
    this.calendar.sync_state = state;
    check(await this.db.from('calendars').update({ sync_state: state, last_synced_at: new Date().toISOString() }).eq('id', this.calendar.id), 'calendars');
  }

  private async task(id: string): Promise<TaskForCalendar | null> {
    return check(await this.db.from('tasks').select(TASK_COLUMNS).eq('id', id).maybeSingle(), 'tasks') as TaskForCalendar | null;
  }

  // ── 1. Google → zadania ─────────────────────────────────────────────────────────────────────

  /** `false` = kalendarz zniknął z Google (wysyłanie wyłączone, wiersz usunięty). */
  private async pull(): Promise<boolean> {
    const syncToken = this.calendar.sync_state.syncToken ?? null;
    let page;
    try {
      try {
        page = await listEvents(this.cfg, this.token, this.calendar.external_id, syncToken, null, { singleEvents: false });
      } catch (error) {
        if (!(error instanceof GoogleError && error.gone && syncToken)) throw error;
        page = await listEvents(this.cfg, this.token, this.calendar.external_id, null, null, { singleEvents: false });
      }
    } catch (error) {
      if (!(error instanceof GoogleError && error.missing)) throw error;
      // Użytkownik usunął kalendarz „TaskPlanner” w Google: przestajemy wysyłać, zadania zostają.
      check(await this.db.rpc('calendar_sync_disable', { p_user: this.calendar.user_id, p_account: this.calendar.account_id }), 'calendar_sync_disable');
      check(await this.db.from('calendars').delete().eq('id', this.calendar.id), 'calendars');
      this.result.gone = true;
      return false;
    }
    this.result.full = page.full;
    const seen = new Set<string>();
    for (const ev of page.items) {
      seen.add(ev.id);
      await this.inbound(ev);
    }
    // Pełna lista nie zawiera usuniętych — powiązanie bez wydarzenia = usunięte w Google.
    if (page.full) {
      for (const link of [...this.byTask.values()]) {
        if (!seen.has(link.external_id)) await this.inbound({ id: link.external_id, status: 'cancelled' });
      }
    }
    const { syncToken: _old, ...rest } = this.calendar.sync_state;
    await this.saveState(page.nextSyncToken ? { ...rest, syncToken: page.nextSyncToken } : rest);
    return true;
  }

  private async inbound(ev: GoogleEvent): Promise<void> {
    const linked = this.byExternal.get(ev.id);
    const taskId = linked?.task_id ?? eventTaskId(ev);
    if (!taskId) return this.importEvent(ev);
    const link = this.byTask.get(taskId);
    // Kopia wydarzenia (np. „Duplikuj” w Google) niesie ten sam taskId — zadanie ma już swoje wydarzenie.
    if (link && link.external_id !== ev.id) return;
    if (link && ev.etag && link.etag === ev.etag) {
      this.result.echoes++;
      return;
    }
    const task = await this.task(taskId);
    if (!task) {
      if (link) {
        check(await this.db.from('calendar_task_links').delete().eq('calendar_id', this.calendar.id).eq('task_id', taskId), 'calendar_task_links');
        this.forget(link);
      }
      return;
    }
    const base = link?.pushed ?? projectTask(task, this.ctx);
    const change = eventChange(ev, base?.zone ?? taskZone(task, this.ctx));
    // Usunięcie bez powiązania to echo naszego usunięcia (zadanie straciło godzinę, przestrzeń wyłączona…).
    if (!change || (change.kind === 'deleted' && !link)) return;
    const own = change.kind === 'timed' && isOwnContent(ev, change.theirs);
    if (own) this.result.echoes++;
    const patch = own ? {} : taskPatch(change, base, task, this.ctx);
    const next = change.kind === 'timed' ? { external_id: ev.id, etag: ev.etag ?? null, pushed: change.theirs } : null;
    if (!link && !next && !Object.keys(patch).length) return;
    try {
      check(await this.db.rpc('calendar_task_apply', { p_calendar: this.calendar.id, p_task: taskId, p_patch: patch, p_link: next }), 'calendar_task_apply');
    } catch (error) {
      // Zadanie z przestrzeni, do której właściciel kalendarza nie ma już dostępu — pomijamy.
      console.warn('calendar_task_apply', taskId, (error as Error).message);
      return;
    }
    if (Object.keys(patch).length) this.result.pulled++;
    if (link) this.forget(link);
    if (next) this.remember({ calendar_id: this.calendar.id, task_id: taskId, ...next });
  }

  /** Wydarzenie dodane w Google w kalendarzu „TaskPlanner” → zadanie w Inboxie pierwszej wybranej przestrzeni. */
  private async importEvent(ev: GoogleEvent): Promise<void> {
    const workspace = this.profile.calendar_sync?.workspaceIds.find((id) => this.ctx.workspaceIds.has(id));
    if (!workspace || ev.status === 'cancelled') return;
    const change = eventChange(ev, this.ctx.zone);
    if (change?.kind !== 'timed') return;
    const inbox = check(
      await this.db.from('lists').select('id').eq('scope_id', workspace).eq('kind', 'inbox').is('deleted_at', null).maybeSingle(),
      'lists',
    ) as { id: string } | null;
    if (!inbox) return;
    const pushed: TaskProjection = { ...change.theirs, marked: false };
    const taskId = check(
      await this.db.rpc('calendar_task_create', {
        p_calendar: this.calendar.id,
        p_task: taskFromEvent(ev, change.theirs, inbox.id, this.ctx),
        p_link: { external_id: ev.id, etag: ev.etag ?? null, pushed },
      }),
      'calendar_task_create',
    ) as string;
    this.result.imported++;
    this.remember({ calendar_id: this.calendar.id, task_id: taskId, external_id: ev.id, etag: ev.etag ?? null, pushed });
  }

  // ── 2. Zadania → Google ─────────────────────────────────────────────────────────────────────

  private async desiredTasks(): Promise<TaskForCalendar[]> {
    const ids = [...this.ctx.workspaceIds];
    if (!ids.length) return [];
    const out: TaskForCalendar[] = [];
    for (let from = 0; ; from += 1000) {
      const rows = check(
        await this.db.from('tasks').select(TASK_COLUMNS).in('scope_id', ids).not('due_time', 'is', null).is('deleted_at', null)
          .order('id').range(from, from + 999),
        'tasks',
      ) as TaskForCalendar[];
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  private async push(): Promise<void> {
    const createFrom = zonedParts(Date.now() - CREATE_FROM_DAYS * DAY_MS, this.ctx.zone).date;
    const keep = new Set<string>();
    for (const task of await this.desiredTasks()) {
      const ours = desiredProjection(task, this.ctx);
      if (!ours) continue;
      const link = this.byTask.get(task.id);
      if (!link && task.due_date! < createFrom) continue;
      keep.add(task.id);
      if (!link) await this.create(task.id, ours);
      else if (needsWrite(ours, link.pushed)) await this.update(task, ours, link);
    }
    for (const link of [...this.byTask.values()]) {
      if (!keep.has(link.task_id)) await this.remove(link);
    }
  }

  private async saveLink(taskId: string, ev: GoogleEvent, pushed: TaskProjection) {
    const link: LinkRow = { calendar_id: this.calendar.id, task_id: taskId, external_id: ev.id, etag: ev.etag ?? null, pushed };
    check(await this.db.from('calendar_task_links').upsert(link, { onConflict: 'calendar_id,task_id' }), 'calendar_task_links');
    const old = this.byTask.get(taskId);
    if (old) this.forget(old);
    this.remember(link);
  }

  private async create(taskId: string, ours: TaskProjection) {
    const id = eventIdForTask(taskId);
    const body = eventBody(taskId, ours);
    let ev: GoogleEvent;
    try {
      ev = await insertEvent(this.cfg, this.token, this.calendar.external_id, { id, ...body });
    } catch (error) {
      // To samo zadanie wysłane wcześniej (przerwany przebieg, wydarzenie usunięte w Google i przywracane).
      if (!(error instanceof GoogleError && error.duplicate)) throw error;
      ev = await patchEvent(this.cfg, this.token, this.calendar.external_id, id, body);
    }
    await this.saveLink(taskId, ev, ours);
    this.result.created++;
  }

  private async update(task: TaskForCalendar, ours: TaskProjection, link: LinkRow, retry = true): Promise<void> {
    try {
      const ev = await patchEvent(this.cfg, this.token, this.calendar.external_id, link.external_id, eventBody(task.id, ours), link.etag);
      await this.saveLink(task.id, ev, ours);
      this.result.updated++;
    } catch (error) {
      if (!(error instanceof GoogleError)) throw error;
      if (error.missing) return this.inbound({ id: link.external_id, status: 'cancelled' });
      if (!error.stale || !retry) throw error;
      // Zmienione w Google od ostatniego odczytu: najpierw scalenie tej zmiany, potem to, co zostało z naszej.
      this.result.conflicts++;
      await this.inbound(await getEvent(this.cfg, this.token, this.calendar.external_id, link.external_id));
      const fresh = await this.task(task.id);
      const next = fresh && desiredProjection(fresh, this.ctx);
      const nextLink = this.byTask.get(task.id);
      if (!fresh || !next) {
        if (nextLink) await this.remove(nextLink);
      } else if (!nextLink) {
        await this.create(task.id, next);
      } else if (needsWrite(next, nextLink.pushed)) {
        await this.update(fresh, next, nextLink, false);
      }
    }
  }

  private async remove(link: LinkRow, retry = true): Promise<void> {
    try {
      await deleteEvent(this.cfg, this.token, this.calendar.external_id, link.external_id, link.etag);
    } catch (error) {
      if (!(error instanceof GoogleError)) throw error;
      if (error.stale && retry) {
        // Zmienione w Google, a zadanie już bez wydarzenia: scalenie (może przywrócić godzinę), potem decyzja od nowa.
        this.result.conflicts++;
        await this.inbound(await getEvent(this.cfg, this.token, this.calendar.external_id, link.external_id));
        const fresh = await this.task(link.task_id);
        const next = fresh && desiredProjection(fresh, this.ctx);
        const nextLink = this.byTask.get(link.task_id);
        if (next && nextLink) {
          if (needsWrite(next, nextLink.pushed)) await this.update(fresh!, next, nextLink, false);
          return;
        }
        if (nextLink) return this.remove(nextLink, false);
        return;
      }
      if (!error.missing) throw error;
    }
    check(await this.db.from('calendar_task_links').delete().eq('calendar_id', this.calendar.id).eq('task_id', link.task_id), 'calendar_task_links');
    this.forget(link);
    this.result.deleted++;
  }
}
