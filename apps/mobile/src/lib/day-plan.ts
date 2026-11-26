/**
 * Plan dnia na telefonie (widok dnia kalendarza i „Plan dnia” w „Dziś”) — jak `day-plan.tsx` na webie:
 * zadania bieżącej przestrzeni, nawyki z porą, wydarzenia kalendarzy, a z nich `core`: bloki, konflikty,
 * wolne okna w godzinach pracy i kolumny osi.
 */
import {
  addDays,
  blockLanes,
  blocksForDay,
  conflictIds,
  conflicts,
  freeSlots,
  habitSlots,
  listColor,
  zonedInstant,
  type Block,
  type CalendarEventLike,
  type Conflict,
  type DayPlan,
  type FreeSlot,
  type LocalDate,
  type ViewTask,
} from '@taskplanner/core';
import { useEffect, useMemo, useState } from 'react';

import type { AppData } from './app-data';
import { useCalendarEvents, type EventInfo } from './calendar-events';

export interface DayPlanModel {
  day: DayPlan;
  conflicts: Conflict[];
  hot: Set<string>;
  free: FreeSlot[];
  lanes: Map<string, { lane: number; lanes: number }>;
  /** Wydarzenia kalendarzy tego dnia (zajętość przy układaniu dnia). */
  events: readonly CalendarEventLike[];
  info: Map<string, EventInfo>;
  tasks: Map<string, ViewTask>;
  /** Kolor bloków listy (`listColor`: lista, przestrzeń) — id listy → kolor; `null` = domyślny. */
  listColors: Map<string, string | null>;
  /** Początek dnia (ms) — minuta „teraz” liczy się od niego. */
  dayStart: number;
}

const toMin = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** `hiddenCalendars` — kalendarze zewnętrzne ukryte w „Pokaż” kalendarza. */
export function useDayPlan(data: AppData, date: LocalDate, workspaceId: string | null, today: LocalDate, hiddenCalendars?: ReadonlySet<string>): DayPlanModel {
  const { timeZone, defaultDurationMin, workHours } = data.settings;
  const tasks = useMemo(() => data.tasks.filter((t) => t.kind === 'task' && (!workspaceId || t.workspaceId === workspaceId)), [data.tasks, workspaceId]);
  const range = useMemo(() => ({ from: date, to: addDays(date, 1) }), [date]);
  const events = useCalendarEvents(range, timeZone, hiddenCalendars);
  const habits = useMemo(
    () => habitSlots(data.tasks.filter((t) => !workspaceId || t.workspaceId === workspaceId), data.habitCompletions, date, addDays(date, 1), today),
    [data.tasks, data.habitCompletions, workspaceId, date, today],
  );
  const byId = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  const listColors = useListColors(data);
  return useMemo(() => {
    const day = blocksForDay(tasks, events.list, date, { timeZone, defaultDurationMin, habits });
    const list = conflicts(day.timed);
    return {
      day,
      conflicts: list,
      hot: conflictIds(list),
      free: freeSlots(day, workHours, { timeZone }),
      lanes: blockLanes(day.timed),
      events: events.list,
      info: events.info,
      tasks: byId,
      listColors,
      dayStart: zonedInstant(date, '00:00', timeZone).getTime(),
    };
  }, [tasks, events, habits, byId, listColors, date, timeZone, defaultDurationMin, workHours]);
}

/** Kolory bloków list (jak na webie i w „Pokaż”): id listy → kolor listy albo przestrzeni. */
export function useListColors(data: Pick<AppData, 'lists' | 'workspaces'>): Map<string, string | null> {
  return useMemo(() => {
    const workspaces = new Map(data.workspaces.map((w) => [w.id, w]));
    return new Map(data.lists.map((l) => [l.id, listColor(l, workspaces.get(l.workspaceId))]));
  }, [data.lists, data.workspaces]);
}

/** Zakres osi: godziny pracy poszerzone o bloki spoza nich (pełne godziny, w granicach dnia). */
export function axisRange(plan: DayPlanModel, workHours: { start: string; end: string }): { from: number; to: number } {
  const first = Math.min(toMin(workHours.start), ...plan.day.timed.map((b: Block) => b.startMin));
  const last = Math.max(toMin(workHours.end), ...plan.day.timed.map((b: Block) => b.endMin));
  return { from: Math.max(0, Math.floor(first / 60) * 60), to: Math.min(plan.day.dayMinutes, Math.ceil(last / 60) * 60) };
}

/** Minuta „teraz” od początku dnia (co minutę). */
export function useNowMinute(dayStart: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return Math.round((now - dayStart) / 60_000);
}
