/**
 * Wydarzenia dla kalendarza i „Planu dnia” (Etap 5) jako `CalendarEventLike` dla `core/time-blocking.ts`:
 * kalendarze zewnętrzne z lokalnej bazy (`calendar_events` z `pull_changes`, tylko widoczne — to samo
 * zapytanie co na webie) i kalendarze telefonu (`expo-calendar`, tylko odczyt, tylko wybrane w
 * „Kalendarze telefonu”). Domyślnie żaden kalendarz telefonu nie jest wybrany: ten sam Google
 * połączony na serwerze i zsynchronizowany w telefonie pokazałby każde wydarzenie dwa razy.
 */
import { compareText, zonedInstant, type CalendarEventLike, type LocalDate } from '@taskplanner/core';
import * as Calendar from 'expo-calendar';
import { useFocusEffect } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { reportError } from './error-log';
import { useLocalQuery } from './local-query';

export interface EventInfo {
  color: string | null;
  calendar: string;
  location: string | null;
  /** Z kalendarza telefonu (a nie z połączonego na serwerze). */
  device: boolean;
}

export interface CalendarEvents {
  list: CalendarEventLike[];
  info: Map<string, EventInfo>;
}

interface ServerEvent extends Record<string, string | number | null> {
  id: string;
  title: string;
  all_day: number;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  color: string | null;
  calendar: string;
  calendar_id: string;
}

const DEVICE_KEY = 'calendar.device';
let deviceIds: string[] = (() => {
  try {
    const value: unknown = JSON.parse(Storage.getItemSync(DEVICE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
})();
const listeners = new Set<() => void>();

/** Id kalendarzy telefonu pokazywanych w kalendarzu i „Planie dnia”. */
export const useDeviceCalendarIds = (): string[] =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => deviceIds,
  );

export function setDeviceCalendarIds(ids: readonly string[]) {
  deviceIds = [...ids];
  Storage.setItemSync(DEVICE_KEY, JSON.stringify(deviceIds));
  for (const listener of listeners) listener();
}

export interface DeviceCalendar {
  id: string;
  title: string;
  account: string;
  color: string | null;
}

/** Kalendarze telefonu (z prośbą o zgodę); `null` — bez zgody. */
export async function deviceCalendars(): Promise<DeviceCalendar[] | null> {
  const { granted } = await Calendar.requestCalendarPermissions();
  if (!granted) return null;
  const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
  return calendars
    .map((c) => ({ id: c.id, title: c.title || '(bez nazwy)', account: c.source?.name ?? c.ownerAccount ?? '', color: c.color ?? null }))
    .sort((a, b) => compareText(a.account, b.account) || compareText(a.title, b.title));
}

/** Data całodniowego wydarzenia z Androida (północ UTC) — bez przesuwania przez strefę urządzenia. */
const utcDate = (value: string | Date) => new Date(value).toISOString().slice(0, 10) as LocalDate;

async function loadDeviceEvents(ids: readonly string[], from: Date, to: Date): Promise<CalendarEvents> {
  const empty: CalendarEvents = { list: [], info: new Map() };
  if (!ids.length) return empty;
  // Bez prośby o zgodę — o zgodę pyta tylko wybór kalendarzy.
  if (!(await Calendar.getCalendarPermissions()).granted) return empty;
  const calendars = (await Calendar.getCalendars(Calendar.EntityTypes.EVENT)).filter((c) => ids.includes(c.id));
  if (!calendars.length) return empty;
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const events = await Calendar.listEvents(calendars, from, to);
  const info = new Map<string, EventInfo>();
  const list = events.map((e): CalendarEventLike => {
    // Wystąpienia serii mają to samo id — początek odróżnia je w zakresie.
    const id = `device:${e.id}:${new Date(e.startDate).getTime()}`;
    const calendar = byId.get(e.calendarId);
    info.set(id, { color: calendar?.color ?? null, calendar: calendar?.title ?? '', location: e.location || null, device: true });
    const busy = e.availability !== Calendar.Availability.FREE;
    if (e.allDay) return { id, title: e.title || '(bez tytułu)', allDay: true, startDate: utcDate(e.startDate), endDate: utcDate(e.endDate), busy };
    return { id, title: e.title || '(bez tytułu)', allDay: false, startAt: new Date(e.startDate).toISOString(), endAt: new Date(e.endDate).toISOString(), busy };
  });
  return { list, info };
}

/**
 * Wydarzenia kalendarzy zewnętrznych i wybranych kalendarzy telefonu nachodzące na dni `[from, to)`;
 * `hidden` — id kalendarzy zewnętrznych ukrytych w „Pokaż” kalendarza.
 */
export function useCalendarEvents(range: { from: LocalDate; to: LocalDate }, timeZone?: string, hidden?: ReadonlySet<string>): CalendarEvents {
  const start = zonedInstant(range.from, '00:00', timeZone).toISOString();
  const end = zonedInstant(range.to, '00:00', timeZone).toISOString();
  const rows = useLocalQuery(
    ['calendar_events', 'calendars'],
    (engine) =>
      engine.db.all<ServerEvent>(
        `select e.id, e.title, e.all_day, e.start_at, e.end_at, e.start_date, e.end_date, e.location, c.color, c.name as calendar, e.calendar_id
           from calendar_events e join calendars c on c.id = e.calendar_id
          where c.visible = 1 and ((e.all_day = 0 and e.start_at < ? and e.end_at > ?) or (e.all_day = 1 and e.start_date < ? and e.end_date > ?))`,
        [end, start, range.to, range.from],
      ),
    [start, end, range.from, range.to],
  );

  const ids = useDeviceCalendarIds();
  const [device, setDevice] = useState<CalendarEvents>({ list: [], info: new Map() });
  const [tick, setTick] = useState(0);
  // Kalendarz telefonu nie daje sygnału zmiany — odczyt przy wejściu na ekran i powrocie do aplikacji.
  useFocusEffect(useCallback(() => setTick((t) => t + 1), []));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => state === 'active' && setTick((t) => t + 1));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    let alive = true;
    loadDeviceEvents(ids, new Date(start), new Date(end))
      .then((result) => alive && setDevice(result))
      .catch((error) => reportError('error', error, { where: 'kalendarz telefonu' }));
    return () => {
      alive = false;
    };
  }, [ids, start, end, tick]);

  return useMemo(() => {
    const info = new Map(device.info);
    const list: CalendarEventLike[] = (rows ?? []).filter((r) => !hidden?.has(r.calendar_id)).map((r) => {
      info.set(r.id, { color: r.color, calendar: r.calendar, location: r.location, device: false });
      return { id: r.id, title: r.title || '(bez tytułu)', allDay: !!r.all_day, startAt: r.start_at, endAt: r.end_at, startDate: r.start_date as LocalDate | null, endDate: r.end_date as LocalDate | null };
    });
    return { list: [...list, ...device.list], info };
  }, [rows, device, hidden]);
}
