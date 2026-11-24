"use client";

/**
 * „Ułóż dzień” (v1.x) w „Planie dnia”: zadania na ten dzień i zaległe → szkic bloków w wolnych oknach godzin
 * pracy (core `autoPlanDay`, offline i bez konta AI) albo „✨ Ułóż z AI” z preferencją tekstem (godziny od modelu
 * sprawdza `dayPlanFromAi`). Szkic rysuje `day-plan.tsx` przerywanymi blokami; zapis dopiero po „Zastosuj”
 * (`dayPlanOps`, jedna transakcja z „Cofnij”).
 */
import {
  addDays,
  AI_HINT_MAX,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  aiDayPlanNote,
  aiPlanFixedNote,
  autoPlanDay,
  blocksForDay,
  BUFFER_CHOICES,
  bulkTaskOps,
  DAY_PLANNER,
  dayPlanFromAi,
  dayPlanOps,
  dayPlanRequest,
  DEFAULT_BUFFER_MIN,
  draftMinutes,
  formatMinutes,
  habitSlots,
  isOpen,
  plural,
  seriesNote,
  UNPLACED_REASON,
  type CalendarEventLike,
  type DayPlanDraft,
  type LocalDate,
  type ProfileSettings,
  type ViewContext,
} from "@taskplanner/core";
import { useState } from "react";

import { askDayPlan, useAiAccount } from "@/lib/ai";
import { listEditable, type AppData } from "@/lib/app-data";
import { useDependencies } from "@/lib/dependencies";
import { useOnline } from "@/lib/use-online";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { Button, IconButton, Input, Notice, Select } from "./ui";

/** Szkic w podglądzie; `rejected` — ile godzin od AI poprawił kod. */
export interface PlanPreview extends DayPlanDraft {
  ai: boolean;
  rejected: number;
}

const BUFFER_KEY = "tp-plan-buffer";
const tasksLabel = (n: number) => plural(n, ["zadanie", "zadania", "zadań"]);

function storedBuffer(): number {
  try {
    const value = Number(localStorage.getItem(BUFFER_KEY) ?? NaN);
    return (BUFFER_CHOICES as readonly number[]).includes(value) ? value : DEFAULT_BUFFER_MIN;
  } catch {
    return DEFAULT_BUFFER_MIN;
  }
}

interface Props {
  data: AppData;
  ctx: ViewContext;
  /** Układany dzień. */
  date: LocalDate;
  settings: ProfileSettings;
  events: readonly CalendarEventLike[];
  /** Minuta „teraz” układanego dnia. */
  nowMin: number;
  preview: PlanPreview | null;
  onPreview: (preview: PlanPreview | null) => void;
}

export function DayPlanner({ data, ctx, date, settings, events, nowMin, preview, onPreview }: Props) {
  const { store, openTask, select } = useAppEnv();
  const { run, notify } = useTaskActions();
  const deps = useDependencies(store);
  const account = useAiAccount(store);
  const online = useOnline();
  const [buffer, setBuffer] = useState(storedBuffer);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { today, timeZone } = ctx;

  /** Dane układania: zajętość liczy się ze wszystkich przestrzeni, zadania — z bieżącej. */
  const input = (bufferMin: number) => {
    const habits = habitSlots(data.tasks, data.habitCompletions, date, addDays(date, 1), today);
    const plan = blocksForDay(data.tasks.filter((t) => t.kind === "task"), events, date, { timeZone, defaultDurationMin: settings.defaultDurationMin, habits });
    const options = {
      date,
      today,
      workspaceId: ctx.workspaceId,
      canEdit: (t: { listId: string }) => listEditable(data, t.listId),
      deps,
      nowMin: date === today ? nowMin : null,
      defaultDurationMin: settings.defaultDurationMin,
      bufferMin,
      timeZone,
    };
    return { plan, options };
  };

  const auto = (bufferMin = buffer) => {
    const { plan, options } = input(bufferMin);
    setError(null);
    onPreview({ ...autoPlanDay(data.tasks, plan, settings.workHours, options), ai: false, rejected: 0 });
  };

  const pickBuffer = (value: number) => {
    setBuffer(value);
    try {
      localStorage.setItem(BUFFER_KEY, String(value));
    } catch {
      // Bez pamięci przeglądarki przerwa zostaje tylko na tej stronie.
    }
    auto(value);
  };

  const ask = async () => {
    if (busy || !online || !aiAccountReady(account)) return;
    const { plan, options } = input(buffer);
    const built = dayPlanRequest(data.tasks, plan, settings.workHours, options, { accountId: account.id, hint });
    if (!built) return setError(DAY_PLANNER.noSlots);
    setBusy(true);
    setError(null);
    try {
      const draft = dayPlanFromAi(await askDayPlan(built.request), built.ids, data.tasks, plan, settings.workHours, options);
      onPreview({ ...draft, ai: true, rejected: draft.rejected.length });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!preview) {
    return (
      <div className="mb-2">
        <Button className="py-1 text-xs" onClick={() => auto()}>
          {DAY_PLANNER.button}
        </Button>
      </div>
    );
  }

  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const unplaced = preview.unplaced.flatMap((u) => {
    const task = byId.get(u.taskId);
    return task && isOpen(task) ? [{ ...u, task }] : [];
  });
  const ready = aiAccountReady(account);
  const nothing = !preview.blocks.length && !unplaced.length;

  const apply = () => {
    const result = dayPlanOps(preview, data.tasks);
    if (!result.count) return notify(DAY_PLANNER.stale);
    void run(result.ops, { text: `Ułożono ${tasksLabel(result.count)} (${formatMinutes(draftMinutes(preview))})`, undo: result.undo });
    onPreview(unplaced.length ? { ...preview, blocks: [], rejected: 0 } : null);
  };

  const postpone = () => {
    const next = addDays(date, 1);
    const { ops, undo } = bulkTaskOps(unplaced.map((u) => u.task), data.tasks, { kind: "date", date: next }, { today, now: new Date(), timeZone });
    void run(ops, { text: `Przełożono ${tasksLabel(unplaced.length)} na ${date === today ? "jutro" : "następny dzień"}`, undo });
    onPreview(preview.blocks.length ? { ...preview, unplaced: [] } : null);
  };

  return (
    <section aria-label="Układanie dnia" className="mb-2 flex flex-col gap-2 rounded-md border border-[var(--line)] p-2 text-xs" data-testid="day-planner">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1">
          {DAY_PLANNER.buffer}
          <Select value={buffer} disabled={busy} onChange={(e) => pickBuffer(Number(e.target.value))} className="py-0.5 text-xs">
            {BUFFER_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n ? `${n} min` : "brak"}
              </option>
            ))}
          </Select>
        </label>
        {preview.ai ? (
          <Button kind="ghost" className="py-0.5 text-xs" disabled={busy} onClick={() => auto()}>
            {DAY_PLANNER.auto}
          </Button>
        ) : null}
        <IconButton label="Zamknij układanie dnia" className="ml-auto" onClick={() => onPreview(null)}>
          ×
        </IconButton>
      </div>
      {ready && !nothing && preview.workday ? (
        <>
          <div className="flex gap-1">
            <Input
              value={hint}
              maxLength={AI_HINT_MAX}
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void ask()}
              placeholder={DAY_PLANNER.hint}
              aria-label="Preferencja dla AI"
              disabled={busy}
              className="min-w-0 flex-1 py-1 text-xs"
            />
            <Button className="shrink-0 py-1 text-xs" disabled={busy || !online} title={online ? undefined : AI_NEEDS_NETWORK} onClick={() => void ask()}>
              {busy ? DAY_PLANNER.busy : DAY_PLANNER.ai}
            </Button>
          </div>
          <p className="text-[11px] text-[var(--muted)]">{aiDayPlanNote(account.provider)}</p>
        </>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!preview.workday ? <p>{DAY_PLANNER.dayOff}</p> : nothing ? <p>{DAY_PLANNER.nothing}</p> : null}
      {preview.rejected ? <p className="text-[var(--muted)]">{aiPlanFixedNote(preview.rejected)}</p> : null}
      {preview.series ? <p className="text-[var(--muted)]">{seriesNote(preview.series)}</p> : null}
      {unplaced.length ? (
        <div>
          <h3 className="mb-1 font-semibold">
            {DAY_PLANNER.unplaced} ({unplaced.length})
          </h3>
          <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto" aria-label={DAY_PLANNER.unplaced}>
            {unplaced.map((u) => (
              <li key={u.taskId} className="flex gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => {
                    select(u.taskId);
                    openTask(u.taskId);
                  }}
                >
                  {u.task.title}
                </button>
                <span className="shrink-0 text-[var(--muted)]">
                  {u.task.durationMin ? `${formatMinutes(u.task.durationMin)} · ` : ""}
                  {UNPLACED_REASON[u.reason]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {preview.blocks.length ? (
          <Button kind="primary" className="py-1 text-xs" disabled={busy} onClick={apply}>
            {DAY_PLANNER.apply} ({tasksLabel(preview.blocks.length)})
          </Button>
        ) : null}
        {unplaced.length ? (
          <Button className="py-1 text-xs" disabled={busy} onClick={postpone}>
            {date === today ? DAY_PLANNER.postpone : DAY_PLANNER.postponeNext} ({unplaced.length})
          </Button>
        ) : null}
      </div>
    </section>
  );
}
