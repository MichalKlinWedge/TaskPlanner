/**
 * Wydarzenia z kalendarzy telefonu (`expo-calendar`, tylko odczyt) i bloki zadań z godziną —
 * wspólne źródło dla widoku calendar-kit i własnej osi dnia.
 */
import * as Calendar from 'expo-calendar';

import { todayTasks } from './tasks';
import { fromLocal, localToday } from './time';

export interface DayItem {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color: string;
  /** Zadanie (przeciągane) albo wydarzenie z kalendarza (tylko do odczytu). */
  taskId: string | null;
}

export interface DeviceEvents {
  granted: boolean;
  calendars: number;
  items: DayItem[];
  ms: number;
  error?: string;
}

export async function deviceEvents(from: Date, to: Date): Promise<DeviceEvents> {
  const { granted } = await Calendar.requestCalendarPermissions();
  if (!granted) return { granted, calendars: 0, items: [], ms: 0 };
  // Pomiar bez czasu okna z prośbą o zgodę.
  const start = Date.now();
  try {
    const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
    const events = calendars.length ? await Calendar.listEvents(calendars, from, to) : [];
    const color = new Map(calendars.map((c) => [c.id, c.color ?? '#71717a']));
    return {
      granted,
      calendars: calendars.length,
      ms: Date.now() - start,
      items: events.map((e) => ({
        id: `event:${e.id}:${String(e.startDate)}`,
        title: e.title || '(bez tytułu)',
        start: new Date(e.startDate as string | Date),
        end: new Date(e.endDate as string | Date),
        allDay: !!e.allDay,
        color: color.get(e.calendarId) ?? '#71717a',
        taskId: null,
      })),
    };
  } catch (error) {
    return { granted, calendars: 0, items: [], ms: Date.now() - start, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Zadania z godziną na dziś jako bloki (domyślnie 30 min). */
export async function taskBlocks(today = localToday()): Promise<DayItem[]> {
  return (await todayTasks(today))
    .filter((t) => t.due_time && t.due_date === today && t.status !== 'done')
    .map((t) => {
      const start = fromLocal(t.due_date!, t.due_time!);
      return { id: `task:${t.id}`, title: t.title, start, end: new Date(start.getTime() + (t.duration_min ?? 30) * 60_000), allDay: false, color: '#2563eb', taskId: t.id };
    });
}
