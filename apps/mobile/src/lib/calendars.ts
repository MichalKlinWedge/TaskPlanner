/**
 * Kalendarze zewnętrzne (M18) na telefonie: konta i kalendarze z lokalnej bazy (tylko do odczytu — przychodzą
 * synchronizacją, `calendar_accounts` / `calendars` / `calendar_events`), działania przez Edge Function
 * `calendar-sync` (JWT użytkownika, te same trasy co web `apps/web/src/lib/calendars.ts`). Podłączanie kont
 * (OAuth Google, adres ICS) i odłączanie zostaje na webie; tu widoczność kalendarza i odświeżenie konta.
 */
import { CalendarSync } from '@taskplanner/core';
import type { SqlRow } from '@taskplanner/sync';

import { sessionUser } from './config';
import { useLocalQuery } from './local-query';
import { supabaseClient, syncNow } from './sync';

export interface CalendarAccount {
  id: string;
  provider: string;
  label: string;
  status: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface ServerCalendar {
  id: string;
  accountId: string;
  name: string;
  color: string | null;
  visible: boolean;
  isTaskTarget: boolean;
  events: number;
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!sessionUser().online) throw new Error('Kalendarze zmienia się po zalogowaniu, z siecią.');
  const { data, error } = await supabaseClient().functions.invoke(`calendar-sync/${path}`, { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const reply = context ? ((await context.json().catch(() => null)) as { error?: string } | null) : null;
    throw new Error(reply?.error ?? error.message);
  }
  // Zmienione wiersze (tylko do odczytu) wracają do lokalnej bazy od razu, nie przy następnej synchronizacji.
  await syncNow().catch(() => undefined);
  return data as T;
}

export const syncCalendarAccount = (accountId: string) => call('accounts/sync', { accountId });
export const setCalendarVisible = (calendarId: string, visible: boolean) => call('calendars/update', { calendarId, visible });

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseCalendarSync(value: unknown): CalendarSync | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = CalendarSync.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Konta i kalendarze serwera z lokalnej bazy (działa offline) oraz wybór „Zadania z godziną → Google” z profilu. */
export function useCalendarAccounts(): { accounts: CalendarAccount[]; calendars: ServerCalendar[]; taskSync: CalendarSync | null } | undefined {
  return useLocalQuery(['calendar_accounts', 'calendars', 'calendar_events', 'profiles'], async (engine) => {
    const [accounts, calendars, profile] = await Promise.all([
      engine.db.all<SqlRow>('select id, provider, label, status, last_synced_at, last_error from calendar_accounts order by created_at, id'),
      engine.db.all<SqlRow>(
        'select c.id, c.account_id, c.name, c.color, c.visible, c.is_task_target, (select count(*) from calendar_events e where e.calendar_id = c.id) as events from calendars c order by c.name, c.id',
      ),
      engine.db.all<SqlRow>('select calendar_sync from profiles where id = ?', [engine.userId]),
    ]);
    return {
      accounts: accounts.map((a) => ({
        id: String(a.id),
        provider: String(a.provider),
        label: String(a.label),
        status: String(a.status),
        lastSyncedAt: text(a.last_synced_at),
        lastError: text(a.last_error),
      })),
      calendars: calendars.map((c) => ({
        id: String(c.id),
        accountId: String(c.account_id),
        name: String(c.name),
        color: text(c.color),
        visible: !!c.visible,
        isTaskTarget: !!c.is_task_target,
        events: Number(c.events) || 0,
      })),
      taskSync: parseCalendarSync(profile[0]?.calendar_sync),
    };
  });
}
