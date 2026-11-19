"use client";

/**
 * „Plan dnia” obok „Dziś” (M9, M11): oś godzin z blokami zadań (z godziną) i spotkaniami z kalendarzy
 * zewnętrznych, wolne okna w godzinach pracy, linia „teraz”, wiersz „cały dzień” i lista konfliktów.
 * Wszystko z `core/time-blocking.ts` (`blocksForDay`, `conflicts`, `freeSlots`, `blockLanes`); układanie
 * bloków przeciąganiem — w kalendarzu (`#/calendar`).
 */
import { addDays, blockLanes, blocksForDay, conflictIds, conflicts, freeSlots, localDateTimeAt, plural, PRIORITY, zonedInstant, type Block, type ProfileSettings, type ViewContext } from "@taskplanner/core";
import { useEffect, useMemo, useState } from "react";

import type { AppData } from "@/lib/app-data";
import { useCalendarEvents } from "@/lib/calendar-events";

import { useAppEnv } from "./app-env";

/** Pikseli na minutę osi (48 px na godzinę). */
const PX = 0.8;
const HOUR = 60;

const toMin = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Minuty od północy dnia dla „teraz” (co minutę). */
function useNowMinute(dayStartMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return Math.round((now - dayStartMs) / 60_000);
}

export function DayPlan({ data, ctx, settings }: { data: AppData; ctx: ViewContext; settings: ProfileSettings }) {
  const { store, openTask, select } = useAppEnv();
  const { today, timeZone } = ctx;
  const tasks = useMemo(() => data.tasks.filter((t) => t.kind === "task" && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId)), [data.tasks, ctx.workspaceId]);
  const range = useMemo(() => ({ from: today, to: addDays(today, 1) }), [today]);
  const events = useCalendarEvents(store, range, timeZone);
  const dayStart = zonedInstant(today, "00:00", timeZone).getTime();
  const nowMin = useNowMinute(dayStart);

  const plan = useMemo(() => {
    const day = blocksForDay(tasks, events.list, today, { timeZone, defaultDurationMin: settings.defaultDurationMin });
    const list = conflicts(day.timed);
    return { day, list, hot: conflictIds(list), free: freeSlots(day, settings.workHours, { timeZone }), lanes: blockLanes(day.timed) };
  }, [tasks, events.list, today, timeZone, settings.defaultDurationMin, settings.workHours]);

  const { day } = plan;
  // Oś: godziny pracy, poszerzone o bloki spoza nich (pełne godziny).
  const first = Math.min(toMin(settings.workHours.start), ...day.timed.map((b) => b.startMin));
  const last = Math.max(toMin(settings.workHours.end), ...day.timed.map((b) => b.endMin));
  const from = Math.max(0, Math.floor(first / HOUR) * HOUR);
  const to = Math.min(day.dayMinutes, Math.ceil(last / HOUR) * HOUR);
  const y = (min: number) => (Math.min(Math.max(min, from), to) - from) * PX;
  const hours = Array.from({ length: (to - from) / HOUR + 1 }, (_, i) => from + i * HOUR);
  const clock = (b: Pick<Block, "startAt">) => localDateTimeAt(b.startAt, timeZone).slice(11);
  const taskById = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);

  const open = (id: string) => {
    select(id);
    openTask(id);
  };

  return (
    <aside className="mt-6 text-sm lg:sticky lg:top-0 lg:mt-0 lg:self-start" aria-label="Plan dnia" data-testid="day-plan">
      <header className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Plan dnia</h2>
        <span className="text-xs text-[var(--muted)]">{plural(day.timed.filter((b) => !b.passive).length, ["blok", "bloki", "bloków"])}</span>
        <a href="#/calendar" className="ml-auto text-xs text-[var(--accent)] hover:underline">
          Ułóż w kalendarzu →
        </a>
      </header>

      {plan.list.length ? (
        <section className="mb-2 rounded-md border border-[var(--danger)]/40 bg-red-50 p-2 text-xs dark:bg-red-950/30" aria-label="Konflikty">
          <h3 className="mb-1 font-semibold text-[var(--danger)]">⚠ {plural(plan.list.length, ["konflikt", "konflikty", "konfliktów"])}</h3>
          <ul className="flex flex-col gap-0.5">
            {plan.list.map((c) => (
              <li key={`${c.a.kind}:${c.a.id}|${c.b.kind}:${c.b.id}`}>
                {clock(c.b)} {c.a.title} ↔ {c.b.title} <span className="text-[var(--muted)]">· {c.overlapMin} min</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {day.allDay.length ? (
        <ul className="mb-2 flex flex-wrap gap-1 text-xs" aria-label="Cały dzień">
          {day.allDay.slice(0, 8).map((item) => (
            <li key={`${item.kind}:${item.id}`} className={`max-w-full truncate rounded px-1.5 py-0.5 ${item.kind === "event" ? "tp-plan-event border border-[var(--line)]" : "bg-black/5 dark:bg-white/10"}`}>
              {item.kind === "task" ? (
                <button type="button" className="truncate" onClick={() => open(item.id)}>
                  {item.title}
                </button>
              ) : (
                item.title
              )}
            </li>
          ))}
          {day.allDay.length > 8 ? <li className="px-1 text-[var(--muted)]">+{day.allDay.length - 8}</li> : null}
        </ul>
      ) : null}

      <div className="relative ml-10 border-l border-[var(--line)]" style={{ height: (to - from) * PX }}>
        {hours.map((h) => (
          <div key={h} className="absolute right-0 left-0 border-t border-[var(--line)]" style={{ top: y(h) }}>
            <span className="absolute -left-10 -translate-y-1/2 text-[10px] text-[var(--muted)]">{String(Math.floor(h / 60) % 24).padStart(2, "0")}:00</span>
          </div>
        ))}
        {plan.free.map((s) => (
          <div key={s.startMin} className="absolute right-0 left-0 bg-green-500/10" style={{ top: y(s.startMin), height: y(s.endMin) - y(s.startMin) }} title="Wolne" />
        ))}
        {day.timed.map((b) => {
          const lane = plan.lanes.get(`${b.kind}:${b.id}`) ?? { lane: 0, lanes: 1 };
          const task = b.kind === "task" ? taskById.get(b.id) : undefined;
          const source = b.kind === "event" ? events.info.get(b.id) : undefined;
          const hot = plan.hot.has(b.id) && !b.passive && !b.virtual;
          const style = {
            top: y(b.startMin),
            height: Math.max(14, y(b.endMin) - y(b.startMin) - 1),
            left: `${(lane.lane / lane.lanes) * 100}%`,
            width: `calc(${100 / lane.lanes}% - 2px)`,
            borderLeftColor: task ? PRIORITY[task.priority]?.color : (source?.color ?? undefined),
          };
          const label = `${clock(b)} ${b.title}`;
          const cls = `absolute ml-0.5 overflow-hidden rounded border border-l-4 px-1 text-left text-[11px] leading-tight ${b.kind === "event" ? "tp-plan-event border-[var(--line)]" : "border-[var(--line)] bg-[var(--surface)] shadow-sm"} ${b.passive ? "opacity-50 line-through" : ""} ${b.virtual ? "border-dashed opacity-70" : ""} ${hot ? "outline-2 outline-[var(--danger)]" : ""}`;
          const title = `${label}${source ? `\n${[source.calendar, source.location].filter(Boolean).join(" · ")}` : ""}`;
          return b.kind === "task" ? (
            <button key={`task:${b.id}`} type="button" className={cls} style={style} title={title} onClick={() => open(b.id)}>
              {hot ? "⚠ " : ""}
              {label}
            </button>
          ) : (
            <div key={`event:${b.id}`} className={cls} style={style} title={title}>
              {hot ? "⚠ " : ""}
              {label}
            </div>
          );
        })}
        {nowMin >= from && nowMin <= to ? <div className="pointer-events-none absolute right-0 -left-1 z-10 border-t-2 border-[var(--danger)]" style={{ top: y(nowMin) }} aria-label="Teraz" /> : null}
      </div>
      {!day.timed.length ? <p className="mt-2 text-xs text-[var(--muted)]">Brak bloków z godziną — przeciągnij zadania na godziny w kalendarzu.</p> : null}
    </aside>
  );
}
