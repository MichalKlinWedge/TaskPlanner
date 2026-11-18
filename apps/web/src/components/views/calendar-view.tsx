"use client";

import plLocale from "@fullcalendar/core/locales/pl";
import type { DatesSetArg, EventChangeArg, EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { Draggable, type EventReceiveArg } from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLocalQuery } from "@/lib/local-store";

import { afterPaint, formatDrag, syntheticDrag } from "./perf";

interface Row extends Record<string, string | number | null> {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DEFAULT_BLOCK = 30;

/** Kalendarz (FullCalendar): bloki zadań z godziną, wiersz „cały dzień”, przeciąganie z panelu (time-blocking). */
export function CalendarView({ store, onRendered }: { store: TabStore; onRendered: (ms: number | null) => void }) {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [measure, setMeasure] = useState<string | null>(null);
  const panel = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const { rows, ms } = useLocalQuery<Row>(
    store,
    "select id, title, due_date, due_time, duration_min from tasks where deleted_at is null and kind = 'task' and due_date >= ? and due_date < ? and status not in ('done','cancelled')",
    range ? [range.from, range.to] : ["", ""],
    ["tasks"],
  );
  const unscheduled = useLocalQuery<Row>(
    store,
    "select id, title, due_date, due_time, duration_min from tasks where deleted_at is null and kind = 'task' and due_date is null and status = 'todo' order by sort_key limit 40",
    [],
    ["tasks"],
  ).rows;

  const events = useMemo<EventInput[]>(
    () =>
      rows.map((r) => {
        if (!r.due_time) return { id: r.id, title: r.title, start: r.due_date!, allDay: true };
        const start = new Date(`${r.due_date}T${r.due_time}:00`);
        return { id: r.id, title: r.title, start, end: new Date(start.getTime() + (r.duration_min ?? DEFAULT_BLOCK) * 60_000) };
      }),
    [rows],
  );

  useEffect(() => {
    if (!panel.current) return;
    // Zadania bez terminu z panelu bocznego → przeciągnięcie na godzinę (time-blocking).
    const draggable = new Draggable(panel.current, {
      itemSelector: "[data-task]",
      eventData: (el) => ({ title: el.textContent ?? "", duration: { minutes: Number(el.getAttribute("data-duration")) || DEFAULT_BLOCK }, create: true, extendedProps: { taskId: el.getAttribute("data-task") } }),
    });
    return () => draggable.destroy();
  }, []);

  useEffect(() => {
    if (range && ms !== null) afterPaint(() => onRendered(ms));
  }, [range, ms, onRendered]);

  const save = (id: string, start: Date | null, end: Date | null, allDay: boolean) => {
    if (!start) return;
    void store.mutate("tasks", id, {
      due_date: localDate(start),
      due_time: allDay ? null : localTime(start),
      ...(allDay || !end ? {} : { duration_min: Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000)) }),
    });
  };

  const onReceive = (info: EventReceiveArg) => {
    const taskId = info.event.extendedProps.taskId as string;
    save(taskId, info.event.start, info.event.end, info.event.allDay);
    info.event.remove(); // pojawi się z lokalnej bazy
  };
  const onChange = (info: EventChangeArg) => save(info.event.id, info.event.start, info.event.end, info.event.allDay);

  const runMeasure = async () => {
    const event = root.current?.querySelector(".fc-timegrid-event");
    const slot = root.current?.querySelector(".fc-timegrid-col:nth-child(4) ");
    if (!event || !slot) return setMeasure("brak bloku w tygodniu");
    const box = slot.getBoundingClientRect();
    setMeasure("mierzę…");
    const result = await syntheticDrag(event, { x: box.left + box.width / 2, y: box.top + box.height * 0.6 }, { kind: "mouse" });
    setMeasure(formatDrag(result));
  };

  return (
    <div ref={root} className="flex gap-3">
      <aside className="w-56 shrink-0 text-xs">
        <h3 className="mb-1 font-semibold">Bez terminu (przeciągnij na godzinę)</h3>
        <ul ref={panel} className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto">
          {unscheduled.map((t) => (
            <li key={t.id} data-task={t.id} data-duration={t.duration_min ?? ""} className="cursor-grab rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1">
              {t.title}
            </li>
          ))}
        </ul>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center gap-3 text-xs">
          <span>{rows.length} zadań w zakresie · zapytanie {ms?.toFixed(1) ?? "—"} ms</span>
          <button type="button" className="rounded border px-2 py-0.5" onClick={() => void runMeasure()}>
            Zmierz przeciąganie
          </button>
          <span data-testid="calendar-drag">{measure}</span>
        </div>
        <FullCalendar
          plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{ left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth" }}
          locale={plLocale}
          firstDay={1}
          height="75vh"
          slotMinTime="06:00:00"
          slotMaxTime="22:00:00"
          nowIndicator
          editable
          droppable
          dayMaxEvents={4}
          events={events}
          datesSet={(arg: DatesSetArg) => setRange({ from: localDate(arg.start), to: localDate(arg.end) })}
          eventReceive={onReceive}
          eventChange={onChange}
        />
      </div>
    </div>
  );
}
