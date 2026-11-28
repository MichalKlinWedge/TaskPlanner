"use client";

/**
 * „Plan dnia” obok „Dziś” (M9, M11): oś godzin z blokami zadań (z godziną) i spotkaniami z kalendarzy
 * zewnętrznych, wolne okna w godzinach pracy, linia „teraz”, wiersz „cały dzień” i lista konfliktów.
 * Wszystko z `core/time-blocking.ts` (`blocksForDay`, `conflicts`, `freeSlots`, `blockLanes`). Blok zadania
 * przeciąga się na inną godzinę, a zadanie z wiersza „cały dzień” — na oś (`plan-drag.ts`,
 * `scheduleBlockPatch`); układanie automatyczne — „Ułóż dzień” (`day-planner.tsx`, szkic
 * jako przerywane bloki do „Zastosuj”). Przełącznik „Dziś | Jutro” wybiera dzień, chyba że ekran podaje `date`.
 */
import { addDays, blockLanes, blocksForDay, conflictIds, conflicts, DAY_PLANNER, dayLabel, freeSlots, habitSlots, isOpen, localDateTimeAt, plural, PRIORITY, relativeDay, scheduleBlockPatch, withDraft, withoutBlock, zonedInstant, type Block, type LocalDate, type ProfileSettings, type ViewContext, type ViewTask } from "@taskplanner/core";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { listEditable, type AppData } from "@/lib/app-data";
import { useCalendarEvents } from "@/lib/calendar-events";

import { useAppEnv } from "./app-env";
import { DayPlanner, type PlanPreview } from "./day-planner";
import { usePlanDrag } from "./plan-drag";
import { useTaskActions } from "./task-item";
import { navLinkClass } from "./ui";

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

/**
 * Czy panel mieści się w wysokości przewijanego widoku — tylko wtedy się przykleja. Wyższy przewija się
 * razem ze stroną (własne przewijanie dawało drugi suwak obok głównego). `frozen` (przeciąganie) trzyma
 * ostatni wynik, żeby układ nie skoczył pod kursorem, gdy oś na chwilę sięga do północy.
 */
function useFitsView(ref: RefObject<HTMLElement | null>, frozen: boolean): boolean {
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const el = ref.current;
    const view = el?.closest("main");
    if (!el || !view || frozen) return;
    const check = () => setFits(el.offsetHeight <= view.clientHeight);
    const observer = new ResizeObserver(check);
    observer.observe(el);
    observer.observe(view);
    check();
    return () => observer.disconnect();
  }, [ref, frozen]);
  return fits;
}

/** `date` — dzień ustalony przez ekran (przegląd dnia ma własny przełącznik); bez niego „Dziś | Jutro” tutaj. */
export function DayPlan({ data, ctx, settings, date: fixed }: { data: AppData; ctx: ViewContext; settings: ProfileSettings; date?: LocalDate }) {
  const { store, openTask, select } = useAppEnv();
  const { today, timeZone } = ctx;
  const tomorrow = addDays(today, 1);
  // Wybór jako data: po północy wybrane „jutro” staje się „dziś”.
  const [picked, setPicked] = useState<LocalDate | null>(null);
  const date = fixed ?? (picked === tomorrow ? tomorrow : today);
  const tasks = useMemo(() => data.tasks.filter((t) => t.kind === "task" && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId)), [data.tasks, ctx.workspaceId]);
  const range = useMemo(() => ({ from: date, to: addDays(date, 1) }), [date]);
  const events = useCalendarEvents(store, range, timeZone);
  const dayStart = zonedInstant(date, "00:00", timeZone).getTime();
  const nowMin = useNowMinute(dayStart);

  const habits = useMemo(
    () => habitSlots(data.tasks.filter((t) => !ctx.workspaceId || t.workspaceId === ctx.workspaceId), data.habitCompletions, date, addDays(date, 1), today),
    [data.tasks, data.habitCompletions, ctx.workspaceId, date, today],
  );

  const taskById = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  // Szkic osobno dla każdego dnia — przełączenie go nie gubi, a spóźniona odpowiedź AI trafia do swojego dnia.
  // Szkic na dzień i przestrzeń (jak na telefonie): szkic ułożony w jednej przestrzeni nie pokazuje się w innej, wraca po powrocie.
  const [previews, setPreviews] = useState<Record<string, PlanPreview | null>>({});
  const previewKey = `${ctx.workspaceId ?? ""}:${date}`;
  const preview = previews[previewKey] ?? null;
  const setPreview = (next: PlanPreview | null) => setPreviews((all) => ({ ...all, [previewKey]: next }));
  // Zadania zamknięte od ułożenia znikają ze szkicu.
  const draft = useMemo(() => preview && { ...preview, blocks: preview.blocks.filter((b) => isOpen(taskById.get(b.taskId) ?? { status: "cancelled" })) }, [preview, taskById]);

  const plan = useMemo(() => {
    const day = blocksForDay(tasks, events.list, date, { timeZone, defaultDurationMin: settings.defaultDurationMin, habits });
    const list = conflicts(day.timed);
    return { day, list, hot: conflictIds(list), free: freeSlots(day, settings.workHours, { timeZone }), lanes: blockLanes(day.timed) };
  }, [tasks, habits, events.list, date, timeZone, settings.defaultDurationMin, settings.workHours]);

  const day = useMemo(() => (draft ? withDraft(plan.day, draft.blocks, taskById, timeZone) : plan.day), [draft, plan.day, taskById, timeZone]);
  const lanes = useMemo(() => (draft ? blockLanes(day.timed) : plan.lanes), [draft, day.timed, plan.lanes]);
  const drafted = useMemo(() => new Set(draft?.blocks.map((b) => b.taskId)), [draft]);
  // Oś: godziny pracy, poszerzone o bloki spoza nich (pełne godziny).
  const first = Math.min(toMin(settings.workHours.start), ...day.timed.map((b) => b.startMin));
  const last = Math.max(toMin(settings.workHours.end), ...day.timed.map((b) => b.endMin));
  const from = Math.max(0, Math.floor(first / HOUR) * HOUR);
  const axisEnd = Math.min(day.dayMinutes, Math.ceil(last / HOUR) * HOUR);

  const { run } = useTaskActions();
  const axis = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  /** Godzina zegara ściennego w minucie osi (przy zmianie czasu minuty od północy ≠ zegar). */
  const wallAt = (min: number) => localDateTimeAt(new Date(dayStart + min * 60_000), timeZone).slice(11);
  /** Przyszłe wystąpienia serii, zadania zamknięte i z list tylko do podglądu stoją w miejscu. */
  const movable = (task: ViewTask | undefined): task is ViewTask => !!task && isOpen(task) && task.dueDate === date && listEditable(data, task.listId);
  const schedule = (id: string, startMin: number) => {
    const task = taskById.get(id);
    if (!movable(task)) return;
    const patch = scheduleBlockPatch(task, date, toMin(wallAt(startMin)), { defaultDurationMin: settings.defaultDurationMin });
    const before: Record<string, unknown> = { start_date: task.startDate, due_date: task.dueDate, due_time: task.dueTime, duration_min: task.durationMin };
    const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k] ?? null]));
    void run([{ table: "tasks", id, patch }], { text: `„${task.title}” → ${relativeDay(date, today)} ${String(patch.due_time)}`, undo: [{ table: "tasks", id, patch: undo }] });
  };
  const { drag, start, wasDragged } = usePlanDrag(axis, { from, to: day.dayMinutes, px: PX }, schedule);
  const fits = useFitsView(panel, !!drag);
  // W trakcie przeciągania oś sięga do północy — zadanie da się położyć też po godzinach pracy.
  const to = drag ? day.dayMinutes : axisEnd;
  const dragged = drag ? taskById.get(drag.id) : undefined;
  const dragEnd = drag && drag.startMin !== null ? drag.startMin + (dragged?.durationMin ?? settings.defaultDurationMin) : 0;
  const y = (min: number) => (Math.min(Math.max(min, from), to) - from) * PX;
  const hours = Array.from({ length: (to - from) / HOUR + 1 }, (_, i) => from + i * HOUR);
  const clock = (b: Pick<Block, "startAt">) => localDateTimeAt(b.startAt, timeZone).slice(11);

  const open = (id: string) => {
    select(id);
    openTask(id);
  };

  return (
    <aside ref={panel} className={`mt-6 text-sm lg:mt-0 lg:self-start ${fits ? "lg:sticky lg:top-0" : ""}`} aria-label="Plan dnia" data-testid="day-plan">
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold whitespace-nowrap">Plan dnia</h2>
        <span className="text-xs whitespace-nowrap text-[var(--muted)]">{plural(plan.day.timed.filter((b) => !b.passive).length, ["blok", "bloki", "bloków"])}</span>
        <a href="#/calendar" className={`ml-auto ${navLinkClass}`}>
          Ułóż w kalendarzu →
        </a>
      </header>

      {fixed ? null : (
        <div className="mb-2 flex w-fit rounded-md border border-[var(--line)] text-xs" role="group" aria-label={DAY_PLANNER.days}>
          {[today, tomorrow].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={date === d}
              title={dayLabel(d)}
              className={`px-2 py-0.5 ${date === d ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
              onClick={() => setPicked(d)}
            >
              {d === today ? DAY_PLANNER.today : DAY_PLANNER.tomorrow}
            </button>
          ))}
        </div>
      )}

      <DayPlanner key={date} data={data} ctx={ctx} date={date} settings={settings} events={events.list} nowMin={nowMin} preview={draft} onPreview={setPreview} />

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
                <button
                  type="button"
                  className={`max-w-full truncate ${movable(taskById.get(item.id)) ? "cursor-grab" : ""} ${drag?.id === item.id ? "opacity-40" : ""}`}
                  title={movable(taskById.get(item.id)) ? `${item.title}\nPrzeciągnij na godzinę` : item.title}
                  onPointerDown={(e) => {
                    if (movable(taskById.get(item.id))) start(e, item.id, null);
                  }}
                  onClick={(e) => {
                    if (!wasDragged(e.detail)) open(item.id);
                  }}
                >
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

      <div ref={axis} className="relative ml-10 border-l border-[var(--line)]" data-testid="plan-axis" style={{ height: (to - from) * PX }}>
        {hours.map((h) => (
          <div key={h} className="absolute right-0 left-0 border-t border-[var(--line)]" style={{ top: y(h) }}>
            <span className="absolute -left-10 -translate-y-1/2 text-[10px] text-[var(--muted)]">{String(Math.floor(h / 60) % 24).padStart(2, "0")}:00</span>
          </div>
        ))}
        {plan.free.map((s) => (
          <div key={s.startMin} className="absolute right-0 left-0 bg-green-500/10" style={{ top: y(s.startMin), height: y(s.endMin) - y(s.startMin) }} title="Wolne" />
        ))}
        {day.timed.map((b) => {
          const lane = lanes.get(`${b.kind}:${b.id}`) ?? { lane: 0, lanes: 1 };
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
          const label = `${clock(b)} ${b.kind === "habit" ? (b.habitState === "done" ? "✓ " : "◎ ") : ""}${b.title}`;
          const cls = `absolute ml-0.5 overflow-hidden rounded border border-l-4 px-1 text-left text-[11px] leading-tight ${b.kind === "event" ? "tp-plan-event border-[var(--line)]" : "border-[var(--line)] bg-[var(--surface)] shadow-sm"} ${b.passive ? "opacity-50 line-through" : ""} ${b.virtual ? "border-dashed opacity-70" : ""} ${hot ? "outline-2 outline-[var(--danger)]" : ""}`;
          const title = `${label}${source ? `\n${[source.calendar, source.location].filter(Boolean).join(" · ")}` : ""}`;
          if (b.kind === "habit")
            return (
              <a key={`habit:${b.id}`} href={`#/habit/${b.id}`} className={`${cls} border-l-emerald-600`} style={style} title={`${title}\nNawyk`}>
                {hot ? "⚠ " : ""}
                {label}
              </a>
            );
          if (b.kind === "task" && drafted.has(b.id))
            return (
              <div key={`draft:${b.id}`} className={`${cls} flex border-dashed !border-[var(--accent)] !bg-[var(--accent)]/10`} style={style} data-testid="plan-draft">
                <button type="button" className="min-w-0 flex-1 truncate text-left" title={`${title}\nSzkic — zapisze się po „${DAY_PLANNER.apply}”`} onClick={() => open(b.id)}>
                  {label}
                </button>
                <button type="button" className="shrink-0 px-0.5 opacity-70 hover:opacity-100" aria-label={`${DAY_PLANNER.remove}: ${b.title}`} title={DAY_PLANNER.remove} onClick={() => draft && setPreview(withoutBlock(draft, b.id))}>
                  ✕
                </button>
              </div>
            );
          return b.kind === "task" ? (
            <button
              key={`task:${b.id}`}
              type="button"
              className={`${cls} ${movable(task) ? "cursor-grab" : ""} ${drag?.id === b.id ? "opacity-40" : ""}`}
              style={style}
              title={movable(task) ? `${title}\nPrzeciągnij na inną godzinę` : title}
              onPointerDown={(e) => {
                if (movable(task)) start(e, b.id, b.startMin);
              }}
              onClick={(e) => {
                if (!wasDragged(e.detail)) open(b.id);
              }}
            >
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
        {drag && dragged && drag.startMin !== null ? (
          <div
            className="pointer-events-none absolute right-0.5 left-0.5 z-20 overflow-hidden rounded border border-l-4 border-[var(--accent)] bg-[var(--surface)] px-1 text-[11px] leading-tight shadow-lg"
            style={{ top: y(drag.startMin), height: Math.max(14, y(dragEnd) - y(drag.startMin) - 1), borderLeftColor: PRIORITY[dragged.priority]?.color }}
            data-testid="plan-drag"
          >
            <strong>{wallAt(drag.startMin)}</strong> {dragged.title}
          </div>
        ) : null}
        {nowMin >= from && nowMin <= to ? <div className="pointer-events-none absolute right-0 -left-1 z-10 border-t-2 border-[var(--danger)]" style={{ top: y(nowMin) }} aria-label="Teraz" /> : null}
      </div>
      {!day.timed.length ? <p className="mt-2 text-xs text-[var(--muted)]">Brak bloków z godziną — „{DAY_PLANNER.button}” albo przeciągnij zadania na godziny (tu z wiersza „cały dzień” lub w kalendarzu).</p> : null}
    </aside>
  );
}
