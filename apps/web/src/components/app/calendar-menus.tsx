"use client";

/**
 * Okienka kalendarza na webie (jak arkusze w kalendarzu telefonu): menu bloku zadania (prawy przycisk
 * albo klawisz menu / Shift+F10 na zaznaczonym bloku) — Otwórz / Zmień godzinę / Zmień dzień / Czas
 * trwania / Bez godziny przez core `scheduleBlockPatch` / `resizeBlockPatch` / `unscheduleBlockPatch`
 * — oraz szczegóły wydarzenia kalendarza zewnętrznego (tytuł, czas, kalendarz, miejsce).
 * Okienko stoi przy bloku, zamyka je Esc, klik poza nim albo przewinięcie; klawisze nie trafiają
 * do skrótów aplikacji.
 */
import {
  calendarEventWhen,
  datesPatch,
  formatMinutes,
  relativeDay,
  resizeBlockPatch,
  scheduleBlockPatch,
  unscheduleBlockPatch,
  type LocalDate,
  type ViewTask,
} from "@taskplanner/core";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import type { ExternalEvent } from "@/lib/calendar-events";
import { useClickOutside } from "@/lib/use-click-outside";

import { Button, Input } from "./ui";

/** Miejsce okienka: punkt kliknięcia albo prostokąt bloku (okienko pod nim, a gdy się nie mieści — nad). */
export interface PopupAnchor {
  left: number;
  top: number;
  bottom: number;
}

export const pointAnchor = (x: number, y: number): PopupAnchor => ({ left: x, top: y, bottom: y });
export const rectAnchor = (el: Element): PopupAnchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom };
};

/** Gotowe długości bloku (jak „Czas trwania…” na telefonie). */
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const toMin = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const MARGIN = 8;

function Floating({ anchor, label, role, onClose, children, testId }: { anchor: PopupAnchor; label: string; role: "menu" | "dialog"; onClose: () => void; children: ReactNode; testId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useClickOutside(true, onClose, root);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = anchor.bottom + 4;
    const top = below + height <= vh - MARGIN ? below : Math.max(MARGIN, anchor.top - height - 4);
    setPos({ left: Math.max(MARGIN, Math.min(anchor.left, vw - width - MARGIN)), top });
  }, [anchor]);

  // Fokus do okienka (pole z `autoFocus` albo pierwsza pozycja) — działa z klawiatury bez myszy.
  useEffect(() => {
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('[role="menuitem"], input, button')?.focus();
  }, []);

  // Przewinięcie kalendarza odsuwa blok od okienka — zamknij.
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    const onScroll = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) latest.current();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div
      ref={root}
      role={role}
      aria-label={label}
      className="fixed z-50 flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 text-sm shadow-lg"
      style={{ left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.bottom, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={(e) => {
        // Skróty aplikacji (E, T, Delete…) nie działają na zaznaczonym zadaniu spod okienka.
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** Strzałki ↑ ↓ / Home / End między pozycjami menu. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]!.focus();
}

const itemClass = "flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none";

type Step = "menu" | "time" | "day" | "duration";

/**
 * Menu bloku zadania. `editable` = otwarte zadanie na liście, którą można zmieniać, i nie przyszłe
 * wystąpienie serii — inaczej tylko „Otwórz”. `onSave` zapisuje łatkę z „Cofnij” (tekst dymka po tytule).
 */
export function CalendarTaskMenu({
  task,
  allDay,
  editable,
  anchor,
  today,
  defaultDurationMin,
  workStart,
  onOpen,
  onSave,
  onClose,
}: {
  task: ViewTask;
  allDay: boolean;
  editable: boolean;
  anchor: PopupAnchor;
  today: LocalDate;
  defaultDurationMin: number;
  workStart: string;
  onOpen: () => void;
  onSave: (patch: Record<string, unknown>, text: string) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("menu");
  const date = task.dueDate;
  const canChange = editable && Boolean(date);
  const timed = !allDay && Boolean(task.dueTime);
  const save = (patch: Record<string, unknown>, text: string) => {
    onSave(patch, text);
    onClose();
  };
  const heading = `${task.dueTime && !allDay ? `${task.dueTime} ` : ""}${task.title}`;

  if (step === "time" && date) {
    return (
      <Floating key="time" anchor={anchor} role="dialog" label={`Godzina: ${task.title}`} onClose={onClose} testId="calendar-task-time">
        <SmallForm
          title={`Godzina: „${task.title}”`}
          onBack={() => setStep("menu")}
          onSubmit={(form) => {
            const time = String(form.get("time") ?? "");
            if (!/^\d{2}:\d{2}$/.test(time)) return;
            save(scheduleBlockPatch(task, date, toMin(time), { defaultDurationMin }), `→ ${relativeDay(date, today)} ${time}`);
          }}
        >
          <Input name="time" type="time" step={300} required autoFocus defaultValue={task.dueTime ?? workStart} aria-label="Godzina" className="flex-1" />
        </SmallForm>
      </Floating>
    );
  }
  if (step === "day" && date) {
    return (
      <Floating key="day" anchor={anchor} role="dialog" label={`Dzień: ${task.title}`} onClose={onClose} testId="calendar-task-day">
        <SmallForm
          title={`Dzień: „${task.title}”`}
          onBack={() => setStep("menu")}
          onSubmit={(form) => {
            const day = String(form.get("day") ?? "") as LocalDate;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day === date) return onClose();
            // Godzina i długość bloku zostają (jak przeciągnięcie na inny dzień).
            const patch = task.dueTime ? scheduleBlockPatch(task, day, toMin(task.dueTime), { defaultDurationMin }) : datesPatch(task, { due_date: day });
            save(patch, `→ ${relativeDay(day, today)}${task.dueTime ? ` ${task.dueTime}` : ""}`);
          }}
        >
          <Input name="day" type="date" required autoFocus defaultValue={date} aria-label="Dzień" className="flex-1" />
        </SmallForm>
      </Floating>
    );
  }
  if (step === "duration") {
    const current = task.durationMin ?? defaultDurationMin;
    return (
      <Floating key="duration" anchor={anchor} role="dialog" label={`Czas trwania: ${task.title}`} onClose={onClose} testId="calendar-task-duration">
        <SmallForm
          title={`Czas trwania: „${task.title}”`}
          onBack={() => setStep("menu")}
          onSubmit={(form) => {
            const minutes = Number(form.get("minutes"));
            if (!Number.isFinite(minutes) || minutes < 5) return;
            save(resizeBlockPatch(0, Math.min(1440, minutes)), `— ${formatMinutes(Math.min(1440, Math.round(minutes)))}`);
          }}
          extra={
            <div className="flex flex-wrap gap-1" role="group" aria-label="Gotowe długości">
              {[...new Set([...DURATIONS, current])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={m === current}
                    onClick={() => save(resizeBlockPatch(0, m), `— ${formatMinutes(m)}`)}
                    className={`rounded-full border px-2 py-0.5 text-xs ${m === current ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--line)] hover:bg-[var(--hover)]"}`}
                  >
                    {formatMinutes(m)}
                  </button>
                ))}
            </div>
          }
        >
          <Input name="minutes" type="number" min={5} max={1440} step={5} required autoFocus defaultValue={current} aria-label="Minuty" className="w-24" />
          <span className="text-xs text-[var(--muted)]">min</span>
        </SmallForm>
      </Floating>
    );
  }

  return (
    <Floating key="menu" anchor={anchor} role="menu" label={`Blok zadania: ${task.title}`} onClose={onClose} testId="calendar-task-menu">
      <div className="truncate px-2 pt-0.5 pb-1 text-xs font-medium text-[var(--muted)]" title={heading} aria-hidden>
        {heading}
      </div>
      <div className="flex flex-col" onKeyDown={moveFocus}>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => {
            onClose();
            onOpen();
          }}
        >
          Otwórz
        </button>
        {canChange ? (
          <>
            <button type="button" role="menuitem" className={itemClass} onClick={() => setStep("time")}>
              {timed ? "Zmień godzinę…" : "Zaplanuj godzinę…"}
            </button>
            <button type="button" role="menuitem" className={itemClass} onClick={() => setStep("day")}>
              Zmień dzień…
            </button>
            {timed ? (
              <>
                <button type="button" role="menuitem" className={itemClass} onClick={() => setStep("duration")}>
                  Czas trwania…
                  <span className="text-xs text-[var(--muted)]">{formatMinutes(task.durationMin ?? defaultDurationMin)}</span>
                </button>
                <button type="button" role="menuitem" className={itemClass} onClick={() => save(unscheduleBlockPatch(), "— bez godziny")}>
                  Bez godziny
                  <span className="text-xs text-[var(--muted)]">dzień zostaje</span>
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </Floating>
  );
}

function SmallForm({ title, onSubmit, onBack, children, extra }: { title: string; onSubmit: (form: FormData) => void; onBack: () => void; children: ReactNode; extra?: ReactNode }) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit(new FormData(e.currentTarget));
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 p-1">
      <div className="truncate text-xs font-medium text-[var(--muted)]" title={title}>
        {title}
      </div>
      {extra}
      <div className="flex items-center gap-2">{children}</div>
      <div className="flex justify-end gap-2">
        <Button className="py-1 text-xs" onClick={onBack}>
          Wróć
        </Button>
        <Button kind="primary" type="submit" className="py-1 text-xs">
          Zapisz
        </Button>
      </div>
    </form>
  );
}

/** Szczegóły wydarzenia kalendarza zewnętrznego (tylko odczyt — zmienia się je w kalendarzu źródłowym). */
export function CalendarEventDetails({ event, anchor, today, timeZone, onClose }: { event: ExternalEvent; anchor: PopupAnchor; today: LocalDate; timeZone?: string; onClose: () => void }) {
  const when = calendarEventWhen(
    { allDay: !!event.all_day, startAt: event.start_at, endAt: event.end_at, startDate: event.start_date as LocalDate | null, endDate: event.end_date as LocalDate | null },
    today,
    timeZone,
  );
  const title = event.title || "(bez tytułu)";
  return (
    <Floating anchor={anchor} role="dialog" label={`Wydarzenie: ${title}`} onClose={onClose} testId="calendar-event-details">
      <div className="flex items-start gap-2 px-1 pt-0.5">
        <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: event.color && /^#[0-9a-f]{3,8}$/i.test(event.color) ? event.color : "var(--muted)" }} aria-hidden />
        <h2 className="min-w-0 flex-1 font-semibold break-words">{title}</h2>
        <button type="button" aria-label="Zamknij" title="Zamknij (Esc)" className="-mt-0.5 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]" onClick={onClose}>
          ✕
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 px-1 pb-1 text-xs">
        <dt className="text-[var(--muted)]">Kiedy</dt>
        <dd className="break-words">{when}</dd>
        <dt className="text-[var(--muted)]">Kalendarz</dt>
        <dd className="break-words">{event.calendar}</dd>
        {event.location ? (
          <>
            <dt className="text-[var(--muted)]">Miejsce</dt>
            <dd className="break-words whitespace-pre-line">{event.location}</dd>
          </>
        ) : null}
      </dl>
      <p className="px-1 text-[11px] text-[var(--muted)]">Wydarzenie z kalendarza zewnętrznego — zmienisz je w tym kalendarzu.</p>
    </Floating>
  );
}
