"use client";

/**
 * Kalendarz (M11) na webie: FullCalendar dzień / tydzień / miesiąc nad `core/time-blocking.ts`
 * (`calendarEntries` — bloki zadań z godziną, wiersz „cały dzień”, przyszłe wystąpienia serii,
 * konflikty; `freeSlotTimes` — wolne okna w godzinach pracy w widoku dnia). Time-blocking: panel
 * zadań bez godziny → przeciągnięcie na godzinę (`scheduleBlockPatch`), rozciąganie bloku
 * (`resizeBlockPatch`), blok z powrotem na panel zdejmuje godzinę (`unscheduleBlockPatch`).
 * Klik w puste miejsce otwiera szybkie dodawanie na ten dzień i godzinę (`onAdd`). Wysokość wiersza
 * (15 min / 30 min / 1 h) przełącza się nad siatką dnia i tygodnia; przeciąganie zawsze co 15 min.
 * „Pokaż” (`calendar-sources.tsx`) wybiera listy i kalendarze zewnętrzne w widoku.
 *
 * Czas zadań jest pływający, więc kalendarz pracuje w „UTC” jako zegarze ściennym (bez stref) —
 * „teraz” to zegar ścienny strefy z ustawień.
 */
import plLocale from "@fullcalendar/core/locales/pl";
import type { CalendarOptions, DatesSetArg, DurationInput, EventClickArg, EventDropArg, EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { Draggable, type DateClickArg, type DropArg, type EventDragStopArg, type EventResizeDoneArg } from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import {
  applyFilter,
  CALENDAR_SLOTS,
  calendarEntries,
  clickedTime,
  formatMinutes,
  habitSlots,
  isEmptyFilter,
  matchesFilter,
  datesPatch,
  freeSlotTimes,
  isOpen,
  localDateTimeAt,
  parseCalendarSlot,
  PRIORITY,
  relativeDay,
  resizeBlockPatch,
  scheduleBlockPatch,
  selectInbox,
  selectToday,
  unscheduleBlockPatch,
  type CalendarSlot,
  type FilterQuery,
  type LocalDate,
  type ProfileSettings,
  type QuickAddSlot,
  type TaskOp,
  type ViewContext,
  type ViewTask,
} from "@taskplanner/core";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { AppData } from "@/lib/app-data";
import { useCalendarEvents } from "@/lib/calendar-events";
import { useRoute } from "@/lib/route";

import { useAppEnv } from "./app-env";
import { CalendarSources, readCalendarHidden, storeCalendarHidden, useExternalCalendars, type CalendarHidden } from "./calendar-sources";
import { FilterBar, type Field as FilterField } from "./filter-bar";
import { useTaskActions } from "./task-item";
import { Select } from "./ui";

type CalendarView = "timeGridDay" | "timeGridWeek" | "dayGridMonth";

const VIEWS: readonly CalendarView[] = ["timeGridDay", "timeGridWeek", "dayGridMonth"];
const VIEW_KEY = "tp-calendar-view";
/** Wysokość wiersza siatki w minutach (per przeglądarka). */
const SLOT_KEY = "tp-calendar-slot";
const SLOT_DURATION: Record<CalendarSlot, string> = { 15: "00:15:00", 30: "00:30:00", 60: "01:00:00" };
/** Etykiety godzin: „09”; przy 15 min także połówki, więc pełny zapis „09:00” / „09:30”. */
const SLOT_LABEL: CalendarOptions["slotLabelFormat"] = { hour: "2-digit", minute: "2-digit", omitZeroMinute: true };
const SLOT_LABEL_FULL: CalendarOptions["slotLabelFormat"] = { hour: "2-digit", minute: "2-digit" };
/** Panel zadań zwinięty ręcznie (per przeglądarka); bez tego przy wejściu zwija się sam, gdy wszystkie źródła są puste. */
const PANEL_KEY = "tp-calendar-panel-closed";

function readPanelClosed(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === "1";
  } catch {
    return false;
  }
}
/** Termin i godzina to sama treść kalendarza. */
const HIDDEN_FILTERS: readonly FilterField[] = ["due", "hasTime"];
/** Ile zadań panel rysuje (reszta — zawęź źródło albo filtr). */
const PANEL_LIMIT = 100;

/** Data / godzina z daty FullCalendar w trybie „UTC = zegar ścienny”. */
const wallDate = (d: Date) => d.toISOString().slice(0, 10) as LocalDate;
const wallMinutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

function readView(): CalendarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.includes(v as CalendarView) ? (v as CalendarView) : "timeGridWeek";
  } catch {
    return "timeGridWeek";
  }
}

function readSlot(): CalendarSlot {
  try {
    return parseCalendarSlot(localStorage.getItem(SLOT_KEY));
  } catch {
    return parseCalendarSlot(null);
  }
}

/** Pola terminu do „Cofnij”. */
const datesBefore = (t: ViewTask): Record<string, unknown> => ({ start_date: t.startDate, due_date: t.dueDate, due_time: t.dueTime, duration_min: t.durationMin });
const pick = (all: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, all[k] ?? null]));

const PANEL_SOURCES = (data: AppData) => ["today", "inbox", "none", ...data.savedFilters.map((f) => `filter:${f.id}`)];

/** Źródło panelu: „Dziś i zaległe”, Inbox albo zapisany filtr (`filter:<id>`). */
function panelTasks(source: string, data: AppData, ctx: ViewContext): ViewTask[] {
  const noTime = (t: ViewTask) => t.kind === "task" && isOpen(t) && !t.dueTime;
  if (source === "today") {
    const view = selectToday(data.tasks, ctx, { completed: "hidden" });
    return [...view.overdue, ...view.today].filter(noTime);
  }
  if (source === "inbox") return selectInbox(data.tasks, new Set(data.lists.filter((l) => l.kind === "inbox").map((l) => l.id)), ctx).filter(noTime);
  if (source === "none") return data.tasks.filter((t) => noTime(t) && !t.dueDate && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId)).sort((a, b) => a.priority - b.priority || (a.sortKey < b.sortKey ? -1 : 1));
  const filter = data.savedFilters.find((f) => `filter:${f.id}` === source);
  return filter ? applyFilter(data.tasks, filter.query, ctx.today).filter((t) => noTime(t) && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId)) : [];
}

/**
 * FullCalendar zamrożony na czas przeciągania / rozciągania bloku. Nowe opcje (każdy render ekranu, np. po
 * synchronizacji) wymieniają jego kontekst, a upuszczenie z innym kontekstem niż przy ostatnim ruchu myszy
 * traktuje jak przeniesienie do innego kalendarza: blok się przesuwa, ale `eventDrop` nie przychodzi i zapis ginie.
 */
const HeldCalendar = memo(
  function HeldCalendar({ calendarRef, options }: { calendarRef: RefObject<FullCalendar | null>; held: RefObject<boolean>; options: CalendarOptions }) {
    return <FullCalendar ref={calendarRef} {...options} />;
  },
  (_, next) => next.held.current,
);

export function CalendarScreen({ data, ctx, settings, onAdd }: { data: AppData; ctx: ViewContext; settings: ProfileSettings; onAdd: (slot: QuickAddSlot) => void }) {
  const { openTask, select, store } = useAppEnv();
  const [, navigate] = useRoute();
  const { run } = useTaskActions();
  const [view, setView] = useState<CalendarView>(readView);
  const [slot, setSlot] = useState<CalendarSlot>(readSlot);
  const [range, setRange] = useState<{ from: LocalDate; to: LocalDate } | null>(null);
  const [source, setSource] = useState("today");
  // Listy i kalendarze zewnętrzne ukryte przez „Pokaż” — poza widokiem i poza wyliczeniami (konflikty, wolne okna, panel).
  const [hidden, setHiddenState] = useState<CalendarHidden>(readCalendarHidden);
  const setHidden = (next: CalendarHidden) => {
    setHiddenState(next);
    storeCalendarHidden(next);
  };
  const externalCalendars = useExternalCalendars();
  // Filtr ukrywa bloki zadań i pozycje panelu; kolizje i wolne okna liczą się z całości.
  const [filter, setFilter] = useState<FilterQuery>({});
  const shown = useMemo(() => (isEmptyFilter(filter) ? null : matchesFilter(filter, ctx.today)), [filter, ctx.today]);
  // Przy wejściu: zwinięty, gdy zwinięto go ręcznie albo wszystkie źródła są puste (potem nie znika sam,
  // np. po przeciągnięciu ostatniego zadania — wtedy nadal przyjmuje blok do zdjęcia godziny).
  const [panelOpen, setPanelOpen] = useState(() => !readPanelClosed() && PANEL_SOURCES(data).some((s) => panelTasks(s, data, ctx).length));
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const calendar = useRef<FullCalendar>(null);
  const held = useRef(false);
  const [, setReleases] = useState(0);
  const hold = () => {
    held.current = true;
  };
  // Po obsłużeniu upuszczenia (`eventDrop` / `eventResize` przychodzi zaraz po „stop”): render ze zmianami z czasu przeciągania.
  const release = () => {
    setTimeout(() => {
      held.current = false;
      setReleases((n) => n + 1);
    }, 0);
  };
  const timeZone = ctx.timeZone;
  const duration = settings.defaultDurationMin;

  const inView = useMemo(() => {
    const lists = hidden.lists;
    return (t: ViewTask) => (!ctx.workspaceId || t.workspaceId === ctx.workspaceId) && !(t.listId && lists.has(t.listId));
  }, [ctx.workspaceId, hidden.lists]);
  const tasks = useMemo(() => data.tasks.filter((t) => t.kind === "task" && inView(t)), [data.tasks, inView]);
  const byId = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  // Obsługa upuszczenia pochodzi sprzed zamrożenia kalendarza, a zadanie mogło się w międzyczasie zmienić.
  const latest = useRef(byId);
  useEffect(() => {
    latest.current = byId;
  }, [byId]);
  // Nawyki z porą — bloki do odczytu (odhacza się je w „Dziś” / „Cykliczne”); klik otwiera nawyk.
  const habits = useMemo(
    () => (range ? habitSlots(data.tasks.filter(inView), data.habitCompletions, range.from, range.to, ctx.today) : []),
    [data.tasks, data.habitCompletions, range, inView, ctx.today],
  );

  // Wydarzenia z kalendarzy zewnętrznych (widoczne kalendarze) nachodzące na zakres widoku.
  const allEvents = useCalendarEvents(store, range, timeZone);
  const calendarEvents = useMemo(
    () => (hidden.calendars.size ? { ...allEvents, list: allEvents.list.filter((e) => !hidden.calendars.has(allEvents.info.get(e.id)?.calendar_id ?? "")) } : allEvents),
    [allEvents, hidden.calendars],
  );

  const events = useMemo<EventInput[]>(() => {
    if (!range) return [];
    const entries = calendarEntries(tasks, calendarEvents.list, range.from, range.to, { timeZone, defaultDurationMin: duration, habits });
    const visible = shown ? entries.filter((e) => e.kind !== "task" || (byId.has(e.id) && shown(byId.get(e.id)!))) : entries;
    const out: EventInput[] = visible.map((e) => {
      const task = e.kind === "task" ? byId.get(e.id) : undefined;
      const source = e.kind === "event" ? calendarEvents.info.get(e.id) : undefined;
      const color = task ? (PRIORITY[task.priority]?.color ?? PRIORITY[4].color) : (source?.color ?? undefined);
      return {
        ...(source && { backgroundColor: "var(--surface)", textColor: "var(--foreground)" }),
        id: e.key,
        title: `${e.conflict ? "⚠ " : ""}${e.kind === "habit" ? (e.habitState === "done" ? "✓ " : "◎ ") : e.virtual ? "↻ " : ""}${e.title}`,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        editable: e.kind === "task" && !e.virtual && !e.passive,
        durationEditable: e.kind === "task" && !e.virtual && !e.passive && !e.allDay,
        borderColor: e.conflict ? "var(--danger)" : color,
        classNames: [`tp-${e.kind}`, e.passive ? "tp-passive" : "", e.virtual ? "tp-virtual" : "", e.conflict ? "tp-conflict" : ""].filter(Boolean),
        extendedProps: { taskId: e.kind === "task" ? e.id : null, habitId: e.kind === "habit" ? e.id : null, conflict: e.conflict, hint: source ? [source.calendar, source.location].filter(Boolean).join(" · ") : e.kind === "habit" ? "Cykliczne" : null },
      };
    });
    // Wolne okna w godzinach pracy — tylko w widoku dnia (M11).
    if (view === "timeGridDay") {
      for (const slot of freeSlotTimes(tasks, calendarEvents.list, range.from, settings.workHours, { timeZone, defaultDurationMin: duration, habits })) {
        out.push({ id: `free:${slot.start}`, start: slot.start, end: slot.end, display: "background", classNames: ["tp-free"], title: "Wolne" });
      }
    }
    return out;
  }, [range, tasks, byId, shown, habits, calendarEvents, timeZone, duration, view, settings.workHours]);

  const conflictCount = useMemo(() => events.filter((e) => e.extendedProps?.conflict).length, [events]);
  const candidates = useMemo(() => {
    const all = panelTasks(source, data, ctx).filter(inView);
    return shown ? all.filter(shown) : all;
  }, [source, data, ctx, shown, inView]);
  const togglePanel = () => {
    setPanelOpen(!panelOpen);
    try {
      localStorage.setItem(PANEL_KEY, panelOpen ? "1" : "0");
    } catch {
      // Bez pamięci przeglądarki — do odświeżenia.
    }
  };

  // Inna szerokość panelu → FullCalendar przelicza kolumny.
  useEffect(() => {
    calendar.current?.getApi().updateSize();
  }, [panelOpen]);

  // Inna wysokość wiersza → u góry siatki zostaje ta sama godzina (gdy mieściła się cała doba — początek pracy).
  const scrollAfter = useRef<DurationInput | null>(null);
  const changeSlot = (next: CalendarSlot) => {
    if (next === slot) return;
    const scroller = grid.current?.querySelector(".fc-timegrid-body")?.closest(".fc-scroller");
    if (scroller) {
      const scrollable = scroller.scrollHeight > scroller.clientHeight + 1;
      scrollAfter.current = scrollable ? { minutes: Math.round((scroller.scrollTop / scroller.scrollHeight) * 1440) } : `${settings.workHours.start}:00`;
    }
    setSlot(next);
    try {
      localStorage.setItem(SLOT_KEY, String(next));
    } catch {
      // Bez pamięci przeglądarki — do odświeżenia.
    }
  };
  useEffect(() => {
    if (scrollAfter.current === null) return;
    calendar.current?.getApi().scrollToTime(scrollAfter.current);
    scrollAfter.current = null;
  }, [slot]);

  // Zadania z panelu → przeciąganie do kalendarza (bez tworzenia zdarzenia — pojawi się z lokalnej bazy).
  useEffect(() => {
    if (!panelOpen || !list.current) return;
    const draggable = new Draggable(list.current, {
      itemSelector: "[data-task]",
      eventData: (el) => ({ title: el.getAttribute("data-title") ?? "", duration: { minutes: Number(el.getAttribute("data-duration")) || duration }, create: false }),
    });
    return () => draggable.destroy();
  }, [duration, panelOpen]);

  /** Zapis terminu z kalendarza; `false` — nic się nie zmienia. */
  const schedule = (task: ViewTask, start: Date, allDay: boolean, durationMin?: number): boolean => {
    const date = wallDate(start);
    const patch = allDay ? datesPatch(task, { due_date: date, due_time: null }) : scheduleBlockPatch(task, date, wallMinutes(start), { durationMin, defaultDurationMin: duration });
    if (!Object.keys(patch).length || Object.entries(patch).every(([k, v]) => datesBefore(task)[k] === v)) return false;
    const ops: TaskOp[] = [{ table: "tasks", id: task.id, patch }];
    const when = `${relativeDay(date, ctx.today)}${allDay ? "" : ` ${String(patch.due_time)}`}`;
    void run(ops, { text: `„${task.title}” → ${when}`, undo: [{ table: "tasks", id: task.id, patch: pick(datesBefore(task), Object.keys(patch)) }] });
    return true;
  };

  const onDrop = (info: DropArg) => {
    const task = latest.current.get(info.draggedEl.getAttribute("data-task") ?? "");
    if (task) schedule(task, info.date, info.allDay);
  };

  const onEventDrop = (info: EventDropArg) => {
    const task = latest.current.get(String(info.event.extendedProps.taskId));
    if (!task || !info.event.start) return info.revert();
    // Z wiersza „cały dzień” na godzinę — szacunek / domyślny czas; między godzinami — długość bloku zostaje.
    const length = info.event.end && !info.oldEvent.allDay ? Math.round((info.event.end.getTime() - info.event.start.getTime()) / 60_000) : undefined;
    // Blok zostaje w nowym miejscu, a lokalna baza zaraz to potwierdzi (bez mignięcia w starym).
    if (!schedule(task, info.event.start, info.event.allDay, length)) info.revert();
  };

  const onResize = (info: EventResizeDoneArg) => {
    const task = latest.current.get(String(info.event.extendedProps.taskId));
    const { start, end } = info.event;
    if (!task || !start || !end) return info.revert();
    const patch = resizeBlockPatch(0, Math.round((end.getTime() - start.getTime()) / 60_000));
    void run([{ table: "tasks", id: task.id, patch }], { text: `„${task.title}” — ${String(patch.duration_min)} min`, undo: [{ table: "tasks", id: task.id, patch: { duration_min: task.durationMin } }] });
  };

  // Blok upuszczony na panel → bez godziny (dzień i szacunek zostają).
  const onDragStop = (info: EventDragStopArg) => {
    release();
    const box = panel.current?.getBoundingClientRect();
    const { clientX: x, clientY: y } = info.jsEvent;
    if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return;
    const task = latest.current.get(String(info.event.extendedProps.taskId));
    if (!task?.dueTime) return;
    void run([{ table: "tasks", id: task.id, patch: unscheduleBlockPatch() }], { text: `„${task.title}” — bez godziny`, undo: [{ table: "tasks", id: task.id, patch: { due_time: task.dueTime } }] });
  };

  const onClick = (info: EventClickArg) => {
    const habitId = info.event.extendedProps.habitId as string | null;
    if (habitId) return navigate({ view: "habit", id: habitId });
    const id = info.event.extendedProps.taskId as string | null;
    if (!id) return;
    select(id);
    openTask(id);
  };

  // Puste miejsce: wiersz siatki pod kursorem; wiersz „cały dzień” i miesiąc — sam dzień.
  const onDateClick = (info: DateClickArg) => {
    // Dotyk: bez emulowanego `mousedown`, który trafiłby w tło świeżo otwartego okna i je zamknął.
    if (info.jsEvent.type === "touchend" && info.jsEvent.cancelable) info.jsEvent.preventDefault();
    onAdd({ date: wallDate(info.date), ...(!info.allDay && { time: clickedTime(wallMinutes(info.date), slot) }) });
  };

  const onDates = (arg: DatesSetArg) => {
    const next = { from: wallDate(arg.start), to: wallDate(arg.end) };
    setRange((r) => (r && r.from === next.from && r.to === next.to ? r : next));
    const type = arg.view.type as CalendarView;
    setView(type);
    try {
      localStorage.setItem(VIEW_KEY, type);
    } catch {
      // Bez pamięci przeglądarki — do odświeżenia.
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 lg:flex-row">
      {/* Zwinięty: wąski pasek — nadal przyjmuje blok upuszczony do zdjęcia godziny. */}
      {!panelOpen ? (
        <aside ref={panel} className="flex shrink-0 rounded-lg bg-black/5 text-sm lg:w-9 dark:bg-white/5" aria-label="Zadania bez godziny" data-testid="calendar-panel">
          <button
            type="button"
            onClick={togglePanel}
            aria-expanded={false}
            title="Pokaż zadania bez godziny"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-[var(--muted)] hover:bg-black/5 hover:text-[var(--foreground)] lg:flex-col lg:py-2 dark:hover:bg-white/5"
          >
            <span aria-hidden>»</span>
            <span className="lg:[writing-mode:vertical-rl]">Zadania bez godziny</span>
            {candidates.length ? <span className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-1.5 text-[10px] leading-4">{candidates.length}</span> : null}
          </button>
        </aside>
      ) : (
      <aside ref={panel} className="flex shrink-0 flex-col gap-2 rounded-lg bg-black/5 p-2 text-sm lg:w-64 dark:bg-white/5" aria-label="Zadania bez godziny" data-testid="calendar-panel">
        <div className="flex gap-1">
          <Select aria-label="Źródło zadań" value={source} onChange={(e) => setSource(e.target.value)} className="min-w-0 flex-1 py-1 text-xs">
            <option value="today">Dziś i zaległe</option>
            <option value="inbox">Inbox</option>
            <option value="none">Bez terminu</option>
            {data.savedFilters.map((f) => (
              <option key={f.id} value={`filter:${f.id}`}>
                {f.name}
              </option>
            ))}
          </Select>
          <button
            type="button"
            onClick={togglePanel}
            aria-expanded
            aria-label="Zwiń panel zadań bez godziny"
            title="Zwiń panel zadań bez godziny"
            className="shrink-0 rounded-md px-2 text-[var(--muted)] hover:bg-black/5 hover:text-[var(--foreground)] dark:hover:bg-white/5"
          >
            «
          </button>
        </div>
        <p className="px-1 text-xs text-[var(--muted)]">Przeciągnij na godzinę. Blok upuszczony tutaj traci godzinę. Klik w puste miejsce kalendarza dodaje zadanie.</p>
        <ul ref={list} className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto lg:max-h-[calc(100dvh-14rem)]">
          {candidates.slice(0, PANEL_LIMIT).map((t) => (
            <li
              key={t.id}
              data-task={t.id}
              data-title={t.title}
              data-duration={t.durationMin ?? ""}
              onClick={() => {
                select(t.id);
                openTask(t.id);
              }}
              style={{ borderLeftColor: PRIORITY[t.priority]?.color }}
              className="cursor-grab rounded border border-l-4 border-[var(--line)] bg-[var(--surface)] px-2 py-1"
            >
              <div className="break-words">{t.title}</div>
              <div className="text-xs text-[var(--muted)]">
                {t.dueDate ? relativeDay(t.dueDate, ctx.today) : "bez terminu"}
                {t.durationMin ? ` · ${t.durationMin} min` : ""}
              </div>
            </li>
          ))}
          {!candidates.length ? <li className="px-1 py-2 text-xs text-[var(--muted)]">Brak zadań bez godziny.</li> : null}
          {candidates.length > PANEL_LIMIT ? <li className="px-1 text-xs text-[var(--muted)]">…i {candidates.length - PANEL_LIMIT} więcej — zawęź źródło.</li> : null}
        </ul>
      </aside>
      )}
      <div ref={grid} className="tp-calendar min-w-0 flex-1" data-testid="calendar">
        <FilterBar query={filter} onChange={setFilter} hide={HIDDEN_FILTERS}>
          <CalendarSources data={data} workspaceId={ctx.workspaceId ?? null} calendars={externalCalendars} hidden={hidden} onChange={setHidden} />
          {view !== "dayGridMonth" ? (
            <div className="ml-auto flex overflow-hidden rounded-md border border-[var(--line)] text-xs" role="group" aria-label="Wysokość wiersza" title="Ile czasu obejmuje jeden wiersz siatki">
              {CALENDAR_SLOTS.map((s) => (
                <button key={s} type="button" aria-pressed={slot === s} className={`px-2.5 py-1 ${slot === s ? "bg-[var(--accent)] text-white" : "hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => changeSlot(s)}>
                  {formatMinutes(s)}
                </button>
              ))}
            </div>
          ) : null}
        </FilterBar>
        {conflictCount ? (
          <p className="mb-2 text-xs text-[var(--danger)]" role="status">
            ⚠ Nakładające się bloki w widocznym zakresie: {conflictCount}
          </p>
        ) : null}
        <HeldCalendar
          calendarRef={calendar}
          held={held}
          options={{
            plugins: [timeGridPlugin, dayGridPlugin, interactionPlugin],
            initialView: view,
            initialDate: ctx.today,
            timeZone: "UTC",
            now: () => localDateTimeAt(new Date(), timeZone),
            headerToolbar: { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth" },
            locale: plLocale,
            firstDay: ctx.firstDayOfWeek ?? 1,
            height: "calc(100dvh - 11rem)",
            scrollTime: `${settings.workHours.start}:00`,
            businessHours: { daysOfWeek: settings.workHours.days.map((d) => d % 7), startTime: settings.workHours.start, endTime: settings.workHours.end },
            slotDuration: SLOT_DURATION[slot],
            slotLabelFormat: slot === 15 ? SLOT_LABEL_FULL : SLOT_LABEL,
            expandRows: true,
            snapDuration: "00:15:00",
            nowIndicator: true,
            editable: true,
            droppable: true,
            dayMaxEvents: 4,
            events,
            datesSet: onDates,
            drop: onDrop,
            eventDrop: onEventDrop,
            eventResize: onResize,
            eventDragStart: hold,
            eventDragStop: onDragStop,
            eventResizeStart: hold,
            eventResizeStop: release,
            eventClick: onClick,
            dateClick: onDateClick,
            eventDidMount: (info) => {
              const hint = info.event.extendedProps.hint as string | null;
              info.el.title = hint ? `${info.event.title}
${hint}` : info.event.title;
            },
          }}
        />
      </div>
    </div>
  );
}
