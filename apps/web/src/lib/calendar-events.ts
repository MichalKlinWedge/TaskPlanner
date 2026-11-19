"use client";

/**
 * Wydarzenia z kalendarzy zewnętrznych z lokalnej bazy (tylko widoczne kalendarze), nachodzące na dni
 * `[from, to)` — jako `CalendarEventLike` dla `core/time-blocking.ts` (kalendarz, plan dnia w „Dziś”).
 */
import { zonedInstant, type CalendarEventLike, type LocalDate } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import { useLocalQuery } from "./local-store";

export interface ExternalEvent extends Record<string, string | number | null> {
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
}

export function useCalendarEvents(store: TabStore | null, range: { from: LocalDate; to: LocalDate } | null, timeZone?: string): { list: CalendarEventLike[]; info: Map<string, ExternalEvent> } {
  const bounds = range ? [zonedInstant(range.from, "00:00", timeZone).toISOString(), zonedInstant(range.to, "00:00", timeZone).toISOString()] : ["", ""];
  const rows = useLocalQuery<ExternalEvent>(
    store,
    `select e.id, e.title, e.all_day, e.start_at, e.end_at, e.start_date, e.end_date, e.location, c.color, c.name as calendar
       from calendar_events e join calendars c on c.id = e.calendar_id
      where c.visible = 1 and ((e.all_day = 0 and e.start_at < ? and e.end_at > ?) or (e.all_day = 1 and e.start_date < ? and e.end_date > ?))`,
    [bounds[1]!, bounds[0]!, range?.to ?? "", range?.from ?? ""],
    ["calendar_events", "calendars"],
  ).rows;
  return useMemo(() => {
    const info = new Map<string, ExternalEvent>();
    const list: CalendarEventLike[] = rows.map((r) => {
      info.set(r.id, r);
      return { id: r.id, title: r.title || "(bez tytułu)", allDay: !!r.all_day, startAt: r.start_at, endAt: r.end_at, startDate: r.start_date, endDate: r.end_date };
    });
    return { list, info };
  }, [rows]);
}
