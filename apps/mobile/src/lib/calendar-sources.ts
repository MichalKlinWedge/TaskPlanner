/**
 * „Pokaż” w kalendarzu (jak `calendar-sources.tsx` na webie): ukryte listy (zadania, nawyki) i ukryte
 * kalendarze zewnętrzne połączone na serwerze — per urządzenie w kv-store `calendar.hidden`; nowa lista
 * i nowy kalendarz są widoczne. Kalendarze telefonu wybiera osobno „📱” (`calendar-events.ts`).
 */
import Storage from 'expo-sqlite/kv-store';
import { useState } from 'react';

import { useLocalQuery } from './local-query';

const KEY = 'calendar.hidden';

export interface CalendarHidden {
  lists: ReadonlySet<string>;
  calendars: ReadonlySet<string>;
}

const ids = (value: unknown): Set<string> => new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);

function read(): CalendarHidden {
  try {
    const v = JSON.parse(Storage.getItemSync(KEY) ?? '{}') as { lists?: unknown; calendars?: unknown };
    return { lists: ids(v.lists), calendars: ids(v.calendars) };
  } catch {
    return { lists: new Set(), calendars: new Set() };
  }
}

export function useCalendarHidden(): [CalendarHidden, (next: CalendarHidden) => void] {
  const [hidden, setHidden] = useState(read);
  return [
    hidden,
    (next) => {
      Storage.setItemSync(KEY, JSON.stringify({ lists: [...next.lists], calendars: [...next.calendars] }));
      setHidden(next);
    },
  ];
}

export interface ExternalCalendar extends Record<string, string | null> {
  id: string;
  name: string;
  color: string | null;
}

/** Kalendarze zewnętrzne widoczne na koncie (bez kalendarza „Task Planner” — jego wydarzenia to zadania). */
export const useExternalCalendars = (): ExternalCalendar[] =>
  useLocalQuery(['calendars'], (engine) => engine.db.all<ExternalCalendar>('select id, name, color from calendars where visible = 1 and is_task_target = 0 order by name')) ?? [];
