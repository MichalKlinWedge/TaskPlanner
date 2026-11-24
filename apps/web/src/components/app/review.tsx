"use client";

/**
 * Przegląd dnia i tygodnia (Etap 9, M16) nad `core/review.ts`. Decyzje przy zadaniach to te same
 * akcje co w widokach (`bulkTaskOps` z „Cofnij”); sesja trafia do `review_sessions` (początek przy
 * wejściu, koniec ze statystykami). Przegląd dnia: kolejka zaległych i dzisiejszych ustalona na
 * starcie, klawisze 1–6, na końcu podsumowanie i plan jutra. Przegląd tygodnia: kroki liczone na
 * żywo (załatwione znikają), na koniec Inbox pusty i każdy aktywny projekt z następnym krokiem.
 */
import {
  addDays,
  localDateTimeAt,
  bulkTaskOps,
  dailyReviewQueue,
  dailySummary,
  capitalized,
  dayLabel,
  daysBetween,
  localDateAt,
  needsDecision,
  plural,
  PRIORITY,
  relativeDay,
  REVIEW_ACTION,
  reviewBulkAction,
  reviewFinishOp,
  reviewsDue,
  reviewStartOp,
  reviewStats,
  uuidv7,
  WEEK_SUMMARY,
  weeklyReview,
  type DayState,
  type HabitCompletion,
  type LocalDate,
  type ProfileSettings,
  type ReviewAction,
  type ReviewKind,
  type ViewContext,
  type ViewTask,
  type WeekSummary,
} from "@taskplanner/core";
import { STALE_LEADER_MESSAGE } from "@taskplanner/sync";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLocalQuery } from "@/lib/local-store";
import type { Route } from "@/lib/route";

import { useAppEnv } from "./app-env";
import { DayPlan } from "./day-plan";
import { QuickAdd } from "./quick-add";
import { useTaskActions } from "./task-item";
import { Button, Input, navLinkClass, Select } from "./ui";
import { WeekSummaryStep } from "./week-summary";

type Kind = ReviewAction["kind"];
const KINDS = Object.keys(REVIEW_ACTION) as Kind[];
const KEY_TO_KIND = new Map(KINDS.map((k) => [REVIEW_ACTION[k].key, k]));

interface LogEntry {
  task: ViewTask;
  action: ReviewAction;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Sesja `review_sessions`: początek przy wejściu (raz), koniec ze statystykami. */
function useReviewSession(kind: ReviewKind) {
  const { store, today } = useAppEnv();
  const [id] = useState(() => uuidv7());
  useEffect(() => {
    void store.mutateMany([reviewStartOp(id, kind, new Date())]).catch(() => undefined);
  }, [store, id, kind]);
  // Drugi raz (po „Wróć do kroków”) zapisuje się tylko zmieniony opis tygodnia.
  const finished = useRef<{ summary: string | null } | null>(null);
  return (log: readonly LogEntry[], summary: string | null = null) => {
    if (finished.current && finished.current.summary === summary) return;
    finished.current = { summary };
    void store.mutateMany([reviewFinishOp(id, { ...reviewStats(log, { today }), ...(summary && { summary }) }, new Date())]).catch(() => undefined);
  };
}

/**
 * Decyzja przeglądu → operacje z „Cofnij”; `false` = nic do zmiany (np. „Dziś” przy dzisiejszym),
 * `null` = zapis niemożliwy (lider w starszej wersji) — przegląd zostaje przy tym zadaniu.
 */
function useDecide() {
  const { data, today, timeZone, store } = useAppEnv();
  const { run, notify } = useTaskActions();
  return (task: ViewTask, action: ReviewAction): boolean | null => {
    if (store.staleLeader) {
      notify(STALE_LEADER_MESSAGE);
      return null;
    }
    const { ops, undo } = bulkTaskOps([task], data.tasks, reviewBulkAction(action), { today, now: new Date(), timeZone });
    if (!ops.length) {
      if (action.kind === "someday" && task.recurrence) notify("Seria nie może być „kiedyś” — zakończ ją w panelu zadania albo wybierz datę.");
      return false;
    }
    const when = action.kind === "date" ? relativeDay(action.date, today) : REVIEW_ACTION[action.kind].label.toLowerCase();
    void run(ops, { text: `„${task.title}” — ${action.kind === "done" ? "ukończone" : action.kind === "delete" ? "w koszu" : when}`, undo });
    return true;
  };
}

function DecisionButtons({ onPick, compact, disabled }: { onPick: (kind: Kind) => void; compact?: boolean; disabled?: readonly Kind[] }) {
  return (
    <div className={`flex flex-wrap ${compact ? "gap-1" : "gap-2"}`}>
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          disabled={disabled?.includes(k)}
          onClick={() => onPick(k)}
          className={`inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] ${compact ? "px-1.5 py-0.5 text-xs" : "px-3 py-1.5 text-sm"} hover:bg-[var(--hover)] disabled:opacity-40 ${k === "delete" ? "text-[var(--danger)]" : ""}`}
        >
          <kbd className="rounded bg-black/5 px-1 text-[10px] dark:bg-white/10">{REVIEW_ACTION[k].key}</kbd>
          {REVIEW_ACTION[k].label}
        </button>
      ))}
    </div>
  );
}

function DatePick({ initial, onPick, onCancel }: { initial: LocalDate; onPick: (date: LocalDate) => void; onCancel: () => void }) {
  const [value, setValue] = useState<string>(initial);
  return (
    <form
      className="flex items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) onPick(value as LocalDate);
      }}
    >
      <Input
        type="date"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Nowy termin"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button kind="primary" type="submit">
        Zapisz
      </Button>
      <Button onClick={onCancel}>Anuluj</Button>
    </form>
  );
}

function Frame({ title, kind, onExit, navigate, children }: { title: string; kind: ReviewKind; onExit: () => void; navigate: (route: Route) => void; children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5" data-testid={`review-${kind}`}>
      <header className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onExit} className={navLinkClass}>
          ← Wyjdź <kbd className="ml-1 font-normal opacity-70">Esc</kbd>
        </button>
        <h1 className="text-lg font-semibold">{title}</h1>
        <button
          type="button"
          className={`ml-auto ${navLinkClass}`}
          onClick={() => navigate({ view: "review", id: kind === "daily" ? "weekly" : "daily" })}
        >
          {kind === "daily" ? "Przegląd tygodnia →" : "Przegląd dnia →"}
        </button>
      </header>
      {children}
    </div>
  );
}

// ── Przegląd dnia ────────────────────────────────────────────────────────────────────────────

export function DailyReview({ ctx, settings, onExit, navigate }: { ctx: ViewContext; settings: ProfileSettings; onExit: () => void; navigate: (route: Route) => void }) {
  const { data, openTask } = useAppEnv();
  const decide = useDecide();
  const finish = useReviewSession("daily");
  // Kolejka ustalona na starcie — przesunięte na jutro nie wracają, a „Wstecz” trafia w to samo zadanie.
  const [queue] = useState(() => dailyReviewQueue(data.tasks, ctx));
  const [index, setIndex] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [picking, setPicking] = useState(false);
  const done = index >= queue.length;
  const item = queue[index];
  const task = item ? (data.tasks.find((t) => t.id === item.task.id) ?? item.task) : undefined;
  const list = task ? data.lists.find((l) => l.id === task.listId) : undefined;

  const apply = (action: ReviewAction) => {
    if (!task) return;
    setPicking(false);
    const decided = decide(task, action);
    if (decided === null) return;
    if (decided || action.kind === "today") setLog((l) => [...l, { task: item!.task, action }]);
    setIndex((i) => i + 1);
  };
  const pick = (kind: Kind) => (kind === "date" ? setPicking(true) : apply({ kind } as ReviewAction));

  useEffect(() => {
    if (done) finish(log);
  }, [done, finish, log]);

  const latest = useRef({ pick, done, picking, onExit });
  useEffect(() => {
    latest.current = { pick, done, picking, onExit };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const { pick: p, done: d, picking: pk, onExit: exit } = latest.current;
      if (event.key === "Escape") {
        event.preventDefault();
        return exit();
      }
      if (d || pk) return;
      const kind = KEY_TO_KIND.get(event.key as "1");
      if (kind) {
        event.preventDefault();
        return p(kind);
      }
      if (event.key === "ArrowRight" || event.key === "j" || event.key === " ") {
        event.preventDefault();
        setIndex((i) => i + 1);
      } else if (event.key === "ArrowLeft" || event.key === "k") {
        event.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (done) return <DailyDone ctx={ctx} settings={settings} log={log} total={queue.length} onExit={onExit} navigate={navigate} />;

  const overdueDays = task?.dueDate ? daysBetween(task.dueDate, ctx.today) : 0;
  return (
    <Frame title="Przegląd dnia" kind="daily" onExit={onExit} navigate={navigate}>
      <div className="flex items-center gap-3 text-sm text-[var(--muted)]">
        <span data-testid="review-progress">
          {index + 1} / {queue.length}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-black/10 dark:bg-white/10" aria-hidden>
          <div className="h-full bg-[var(--accent)]" style={{ width: `${(index / queue.length) * 100}%` }} />
        </div>
        <button type="button" className="text-xs text-[var(--accent)] hover:underline" onClick={() => setIndex(queue.length)}>
          Zakończ
        </button>
      </div>
      {task ? (
        <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5" aria-label="Zadanie do decyzji">
          <p className={`mb-1 text-xs font-semibold tracking-wide uppercase ${item!.section === "overdue" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
            {item!.section === "overdue" ? `Zaległe · ${plural(overdueDays, ["dzień", "dni", "dni"])}` : "Na dziś"}
          </p>
          <h2 className="flex items-start gap-2 text-xl font-semibold" data-testid="review-task">
            <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PRIORITY[task.priority].color }} />
            <button type="button" className="text-left hover:underline" onClick={() => openTask(task.id)}>
              {task.title}
            </button>
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {list ? (list.kind === "inbox" ? "Inbox" : list.name) : ""}
            {task.dueDate ? ` · ${relativeDay(task.dueDate, ctx.today)}` : ""}
            {task.dueTime ? ` ${task.dueTime}` : ""}
            {task.recurrence ? " · seria" : ""}
          </p>
          {needsDecision(task) ? (
            <p className="mt-2 rounded-md bg-amber-100 px-2 py-1 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
              Przesuwane {task.postponeCount} razy — zrób, zmniejsz albo usuń.
            </p>
          ) : null}
          <div className="mt-4">
            {picking ? (
              <DatePick initial={addDays(ctx.today, 2)} onPick={(date) => apply({ kind: "date", date })} onCancel={() => setPicking(false)} />
            ) : (
              <DecisionButtons onPick={pick} disabled={task.recurrence ? ["someday"] : []} />
            )}
          </div>
        </section>
      ) : null}
      <p className="text-xs text-[var(--muted)]">Klawisze 1–6 — decyzja, → / spacja — pomiń, ← — wstecz, Esc — wyjście. „Cofnij” w dymku cofa ostatnią decyzję.</p>
    </Frame>
  );
}

function DailyDone({ ctx, settings, log, total, onExit, navigate }: { ctx: ViewContext; settings: ProfileSettings; log: LogEntry[]; total: number; onExit: () => void; navigate: (route: Route) => void }) {
  const { data } = useAppEnv();
  const stats = reviewStats(log, ctx);
  const summary = useMemo(() => dailySummary(data.tasks, ctx), [data.tasks, ctx]);
  const tomorrow = addDays(ctx.today, 1);
  // Przegląd rano → plan na dziś, po południu i wieczorem → na jutro; przełącznik obok.
  const [day, setDay] = useState<"today" | "tomorrow">(() => (localDateTimeAt(new Date(), ctx.timeZone).slice(11) < "12:00" ? "today" : "tomorrow"));
  const planDate = day === "today" ? ctx.today : tomorrow;
  const planTasks = day === "today" ? summary.today : summary.tomorrow;
  return (
    <Frame title="Przegląd dnia — gotowe" kind="daily" onExit={onExit} navigate={navigate}>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Podsumowanie" data-testid="review-summary">
        <Stat label="Przejrzane" value={`${stats.reviewed} / ${total}`} />
        <Stat label="Ukończone dziś" value={String(summary.doneToday.length)} />
        <Stat label="Przeniesione" value={String(stats.rescheduled + stats.someday)} />
        <Stat label="Usunięte" value={String(stats.deleted)} />
      </section>
      {stats.needsDecision ? <p className="text-sm text-[var(--muted)]">{plural(stats.needsDecision, ["zadanie było przesuwane", "zadania były przesuwane", "zadań było przesuwanych"])} 3 razy lub więcej.</p> : null}
      <section aria-label={day === "today" ? "Plan na dziś" : "Plan na jutro"} className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold">
              {day === "today" ? "Dziś" : "Jutro"} · {dayLabel(planDate)}
            </h2>
            <div className="ml-auto flex rounded-md border border-[var(--line)] text-xs" role="group" aria-label="Plan na">
              {(["today", "tomorrow"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={day === d}
                  className={`px-2 py-0.5 ${day === d ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
                  onClick={() => setDay(d)}
                >
                  {d === "today" ? "Dziś" : "Jutro"}
                </button>
              ))}
            </div>
          </div>
          {planTasks.length ? (
            <ul className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)] text-sm">
              {planTasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY[t.priority].color }} />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  {t.dueTime ? <span className="text-xs text-[var(--muted)]">{t.dueTime}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--muted)]">{day === "today" ? "Na dziś nic więcej zaplanowanego." : "Na jutro nic zaplanowanego."}</p>
          )}
        </div>
        <DayPlan key={planDate} data={data} ctx={ctx} date={planDate} settings={settings} />
      </section>
      <div>
        <Button kind="primary" onClick={onExit}>
          Gotowe
        </Button>
      </div>
    </Frame>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

// ── Przegląd tygodnia ────────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: "inbox", title: "Inbox do zera" },
  { id: "overdue", title: "Zaległe" },
  { id: "projects", title: "Projekty bez następnego kroku" },
  { id: "waiting", title: "Oczekuje > 7 dni" },
  { id: "upcoming", title: "Nadchodzący tydzień" },
  { id: "habits", title: "Cykliczne w tygodniu" },
  { id: "summary", title: WEEK_SUMMARY.step },
] as const;
type Step = (typeof STEPS)[number]["id"];

const DAY_STATE: Record<DayState, { cls: string; label: string }> = {
  done: { cls: "bg-green-500", label: "zrobione" },
  partial: { cls: "bg-green-300 dark:bg-green-800", label: "częściowo" },
  skipped: { cls: "bg-sky-300 dark:bg-sky-800", label: "dzień wolny" },
  missed: { cls: "bg-red-300 dark:bg-red-900", label: "pominięte" },
  pending: { cls: "border border-dashed border-[var(--line)]", label: "dziś" },
  off: { cls: "bg-black/5 dark:bg-white/5", label: "nie obowiązuje" },
};

export function WeeklyReview({ ctx, onExit, navigate }: { ctx: ViewContext; onExit: () => void; navigate: (route: Route) => void }) {
  const { data, store, openTask } = useAppEnv();
  const decide = useDecide();
  const { run } = useTaskActions();
  const finish = useReviewSession("weekly");
  const [step, setStep] = useState<Step>("inbox");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [summary, setSummary] = useState<WeekSummary | null>(null);

  const from = addDays(ctx.today, -6);
  const completionRows = useLocalQuery<Record<string, string | number | null>>(
    store,
    "select task_id, occurrence_date, kind, value from task_completions where deleted_at is null and occurrence_date between ? and ?",
    [from, ctx.today],
    ["task_completions"],
  ).rows;
  const completions = useMemo(() => {
    const map = new Map<string, HabitCompletion[]>();
    for (const r of completionRows) {
      const list = map.get(String(r.task_id)) ?? [];
      list.push({ date: String(r.occurrence_date) as LocalDate, kind: r.kind === "skipped" ? "skipped" : "done", value: r.value === null ? null : Number(r.value) });
      map.set(String(r.task_id), list);
    }
    return map;
  }, [completionRows]);
  const lists = useMemo(() => data.lists.map((l) => ({ id: l.id, workspaceId: l.workspaceId, kind: l.kind, status: l.projectStatus })), [data.lists]);
  const review = useMemo(() => weeklyReview({ tasks: data.tasks, lists, completions }, ctx), [data.tasks, lists, completions, ctx]);

  const counts: Record<Step, number> = {
    inbox: review.inbox.length,
    overdue: review.overdue.length,
    projects: review.projectsWithoutNext.length,
    waiting: review.waiting.length,
    upcoming: review.upcoming.days.reduce((n, d) => n + d.items.length, 0),
    habits: review.habits.length,
    summary: 0,
  };
  const at = STEPS.findIndex((s) => s.id === step);

  // Zadania już rozstrzygnięte w tym przeglądzie — klawisz wciśnięty, zanim lista się odświeżyła,
  // trafia w następne zadanie, a nie drugi raz w to samo.
  const decided = useRef(new Set<string>());
  const act = (task: ViewTask, action: ReviewAction) => {
    setPicking(null);
    const result = decide(task, action);
    if (result) {
      decided.current.add(task.id);
      setLog((l) => [...l, { task, action }]);
    }
  };
  const pickFor = (task: ViewTask) => (kind: Kind) => (kind === "date" ? setPicking(task.id) : act(task, { kind } as ReviewAction));

  // Klawisze 1–6 działają na pierwszym nierozstrzygniętym zadaniu kroku (Inbox, zaległe).
  const keyed = step === "inbox" ? review.inbox : step === "overdue" ? review.overdue : [];
  const latest = useRef({ keyed, pickFor, onExit, picking });
  useEffect(() => {
    latest.current = { keyed, pickFor, onExit, picking };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const { keyed: k, pickFor: p, onExit: exit, picking: pk } = latest.current;
      if (event.key === "Escape") {
        event.preventDefault();
        return exit();
      }
      const kind = KEY_TO_KIND.get(event.key as "1");
      const f = kind ? k.find((t) => !decided.current.has(t.id)) : undefined;
      if (kind && f && !pk) {
        event.preventDefault();
        p(f)(kind);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (finished) {
    const stats = reviewStats(log, ctx);
    return (
      <Frame title="Przegląd tygodnia — gotowe" kind="weekly" onExit={onExit} navigate={navigate}>
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Podsumowanie" data-testid="review-summary">
          <Stat label="Decyzje" value={String(stats.reviewed)} />
          <Stat label="Inbox" value={String(review.inbox.length)} />
          <Stat label="Projekty bez kroku" value={String(review.projectsWithoutNext.length)} />
          <Stat label="Zaległe" value={String(review.overdue.length)} />
        </section>
        {summary ? <p className="rounded-md border border-[var(--line)] p-3 text-sm">{summary.text}</p> : null}
        <p className="text-sm">{review.inbox.length === 0 && review.projectsWithoutNext.length === 0 ? "Inbox pusty, każdy aktywny projekt ma następny krok." : "Zostało coś do uporządkowania — wróć do kroków albo zrób to później."}</p>
        <div className="flex gap-2">
          <Button kind="primary" onClick={onExit}>
            Gotowe
          </Button>
          <Button onClick={() => setFinished(false)}>Wróć do kroków</Button>
        </div>
      </Frame>
    );
  }

  const row = (task: ViewTask, extra?: ReactNode) => (
    <li key={task.id} className="flex flex-col gap-1.5 px-3 py-2" data-task-row={task.id}>
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY[task.priority].color }} />
        <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => openTask(task.id)}>
          {task.title}
        </button>
        {task.dueDate ? <span className={`text-xs ${task.dueDate < ctx.today ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{relativeDay(task.dueDate, ctx.today)}</span> : null}
        {needsDecision(task) ? <span className="rounded bg-amber-100 px-1 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" title="Przesuwane 3 razy lub więcej">{task.postponeCount}× przesuwane</span> : null}
      </div>
      {picking === task.id ? (
        <DatePick initial={addDays(ctx.today, 2)} onPick={(date) => act(task, { kind: "date", date })} onCancel={() => setPicking(null)} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <DecisionButtons compact onPick={pickFor(task)} disabled={task.recurrence ? ["someday"] : []} />
          {extra}
        </div>
      )}
    </li>
  );
  const move = (task: ViewTask) => (
    <Select
      aria-label="Przenieś do listy"
      className="py-0.5 text-xs"
      value=""
      onChange={(e) => {
        if (!e.target.value) return;
        const { ops, undo } = bulkTaskOps([task], data.tasks, { kind: "move", listId: e.target.value }, { today: ctx.today, now: new Date(), timeZone: ctx.timeZone });
        void run(ops, { text: `„${task.title}” → ${data.lists.find((l) => l.id === e.target.value)?.name}`, undo });
        setLog((l) => [...l, { task, action: { kind: "today" } }]);
      }}
    >
      <option value="">Przenieś do…</option>
      {data.lists
        .filter((l) => l.workspaceId === task.workspaceId && l.kind !== "inbox")
        .map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
    </Select>
  );
  const empty = (text: string) => <p className="rounded-md border border-dashed border-[var(--line)] px-3 py-4 text-center text-sm text-[var(--muted)]">✓ {text}</p>;

  return (
    <Frame title="Przegląd tygodnia" kind="weekly" onExit={onExit} navigate={navigate}>
      <nav className="flex flex-wrap gap-1" aria-label="Kroki przeglądu">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            aria-current={s.id === step ? "step" : undefined}
            onClick={() => setStep(s.id)}
            className={`rounded-full border px-2.5 py-1 text-xs ${s.id === step ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] hover:bg-[var(--hover)]"}`}
          >
            {i + 1}. {s.title}
            {s.id !== "upcoming" && s.id !== "habits" && s.id !== "summary" ? <span className={`ml-1 ${counts[s.id] ? "font-semibold" : "opacity-60"}`}>{counts[s.id] || "✓"}</span> : null}
          </button>
        ))}
      </nav>

      <section aria-label={STEPS[at]!.title} className="flex flex-col gap-3" data-testid={`review-step-${step}`}>
        <h2 className="text-base font-semibold">
          {at + 1}. {STEPS[at]!.title}
        </h2>
        {step === "inbox" ? (
          review.inbox.length ? (
            <ul className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">{review.inbox.map((t) => row(t, move(t)))}</ul>
          ) : (
            empty("Inbox pusty.")
          )
        ) : step === "overdue" ? (
          review.overdue.length ? <ul className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">{review.overdue.map((t) => row(t))}</ul> : empty("Nic zaległego.")
        ) : step === "projects" ? (
          review.projectsWithoutNext.length ? (
            <ul className="flex flex-col gap-3">
              {review.projectsWithoutNext.map((p) => {
                const project = data.lists.find((l) => l.id === p.id);
                const open = data.tasks.filter((t) => t.listId === p.id && t.kind === "task" && (t.status === "todo" || t.status === "in_progress" || t.status === "waiting") && !t.parentId);
                return (
                  <li key={p.id} className="rounded-md border border-[var(--line)] p-3" data-project={p.id}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rotate-45 rounded-[2px]" style={{ background: project?.color ?? "var(--muted)" }} />
                      <button type="button" className="font-medium hover:underline" onClick={() => navigate({ view: "list", id: p.id })}>
                        {project?.name}
                      </button>
                      <span className="text-xs text-[var(--muted)]">{plural(open.length, ["otwarte zadanie", "otwarte zadania", "otwartych zadań"])} bez terminu</span>
                    </div>
                    {open.length ? (
                      <ul className="mb-2 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
                        {open.slice(0, 5).map((t) => (
                          <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                            <span className="min-w-0 flex-1 truncate">{t.title}</span>
                            <span className="text-xs text-[var(--muted)]">następny krok:</span>
                            <Button className="px-2 py-0.5 text-xs" onClick={() => act(t, { kind: "today" })}>
                              Dziś
                            </Button>
                            <Button className="px-2 py-0.5 text-xs" onClick={() => act(t, { kind: "tomorrow" })}>
                              Jutro
                            </Button>
                            <Button className="px-2 py-0.5 text-xs" onClick={() => act(t, { kind: "date", date: addDays(ctx.today, 7) })}>
                              Za tydzień
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <QuickAdd listId={p.id} dueDate={addDays(ctx.today, 1)} placeholder="Następny krok (domyślnie na jutro)…" />
                  </li>
                );
              })}
            </ul>
          ) : (
            empty("Każdy aktywny projekt ma następny krok.")
          )
        ) : step === "waiting" ? (
          review.waiting.length ? (
            <ul className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
              {review.waiting.map(({ task, days }) =>
                row(
                  task,
                  <>
                    <span className="text-xs text-[var(--muted)]">oczekuje {plural(days, ["dzień", "dni", "dni"])}</span>
                    <Button className="px-2 py-0.5 text-xs" onClick={() => void run([{ table: "tasks", id: task.id, patch: { status: "todo" } }], { text: `„${task.title}” — do zrobienia`, undo: [{ table: "tasks", id: task.id, patch: { status: "waiting" } }] })}>
                      Już nie czeka
                    </Button>
                  </>,
                ),
              )}
            </ul>
          ) : (
            empty("Nic nie czeka dłużej niż tydzień.")
          )
        ) : step === "upcoming" ? (
          <>
            <ul className="flex flex-col gap-2">
              {review.upcoming.days.map((d) => (
                <li key={d.date} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm">
                  <p className="mb-1 text-xs font-semibold text-[var(--muted)]">{capitalized(dayLabel(d.date))}</p>
                  {d.items.length ? (
                    <ul className="flex flex-col gap-0.5">
                      {d.items.map((it) => (
                        <li key={`${it.task.id}:${it.date}`} className={`flex items-center gap-2 ${it.virtual ? "opacity-60" : ""}`}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: PRIORITY[it.task.priority].color }} />
                          <span className="min-w-0 flex-1 truncate">{it.task.title}</span>
                          {it.task.dueTime ? <span className="text-xs text-[var(--muted)]">{it.task.dueTime}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[var(--muted)]">—</p>
                  )}
                </li>
              ))}
            </ul>
            <a href="#/calendar" className={`self-start ${navLinkClass}`}>
              Otwórz kalendarz tygodnia →
            </a>
          </>
        ) : step === "summary" ? (
          <WeekSummaryStep ctx={ctx} review={review} summary={summary} onSummary={setSummary} onAct={act} />
        ) : review.habits.length ? (
          <table className="text-sm">
            <tbody>
              {review.habits.map(({ task, days }) => (
                <tr key={task.id}>
                  <td className="max-w-48 truncate py-1 pr-3">{task.title}</td>
                  {days.map((d) => (
                    <td key={d.date} className="px-0.5 py-1">
                      <span className={`block h-5 w-5 rounded ${DAY_STATE[d.state].cls}`} title={`${d.date}: ${DAY_STATE[d.state].label}`} />
                    </td>
                  ))}
                  <td className="pl-2 text-xs text-[var(--muted)]">{days.filter((d) => d.state === "done").length}/7</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          empty("Brak zadań cyklicznych.")
        )}
        {review.needsDecision.length && (step === "overdue" || step === "inbox") ? (
          <p className="text-xs text-[var(--muted)]">{plural(review.needsDecision.length, ["zadanie przesuwane", "zadania przesuwane", "zadań przesuwanych"])} 3 razy lub więcej — oznaczone na żółto.</p>
        ) : null}
      </section>

      <div className="flex items-center gap-2">
        {at > 0 ? <Button onClick={() => setStep(STEPS[at - 1]!.id)}>← Wstecz</Button> : null}
        {at < STEPS.length - 1 ? (
          <Button kind="primary" onClick={() => setStep(STEPS[at + 1]!.id)}>
            Dalej →
          </Button>
        ) : (
          <Button
            kind="primary"
            onClick={() => {
              finish(log, summary?.text ?? null);
              setFinished(true);
            }}
          >
            Zakończ przegląd
          </Button>
        )}
        {step === "inbox" || step === "overdue" ? <span className="text-xs text-[var(--muted)]">Klawisze 1–6 — decyzja przy pierwszym zadaniu.</span> : null}
      </div>
    </Frame>
  );
}

// ── Pora przeglądu ───────────────────────────────────────────────────────────────────────────

const NOTIFIED_KEY = "tp-review-notified";

function readNotified(): Partial<Record<ReviewKind, LocalDate>> {
  try {
    return JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Przypomnienie o przeglądzie (godziny z Ustawień): link w pasku bocznym do końca dnia albo do
 * skończonej sesji, a gdy karta jest w tle — raz dziennie powiadomienie (jeśli przeglądarka pozwala).
 */
export function ReviewNudge({ settings, navigate }: { settings: ProfileSettings; navigate: (route: Route) => void }) {
  const { store, today } = useAppEnv();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rows = useLocalQuery<Record<string, string | null>>(store, "select kind, finished_at from review_sessions where deleted_at is null and finished_at is not null and finished_at >= ?", [addDays(today, -1)], ["review_sessions"]).rows;
  const [dismissed, setDismissed] = useState<Partial<Record<ReviewKind, LocalDate>>>({});
  const due = useMemo(() => {
    const last: Partial<Record<ReviewKind, LocalDate | null>> = {};
    for (const r of rows) {
      const kind = r.kind as ReviewKind;
      const date = localDateAt(String(r.finished_at), settings.timeZone);
      if (date === today) last[kind] = date;
    }
    for (const k of ["daily", "weekly"] as const) if (dismissed[k] === today) last[k] = today;
    return reviewsDue(settings, new Date(now), { timeZone: settings.timeZone, last });
  }, [rows, dismissed, settings, now, today]);

  useEffect(() => {
    if (!due.length || document.visibilityState === "visible" || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const notified = readNotified();
    const fresh = due.filter((k) => notified[k] !== today);
    if (!fresh.length) return;
    try {
      localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ ...notified, ...Object.fromEntries(fresh.map((k) => [k, today])) }));
    } catch {
      // Bez pamięci przeglądarki — powiadomienie może się powtórzyć.
    }
    const title = fresh.includes("weekly") ? "Pora na przegląd tygodnia" : "Pora na przegląd dnia";
    void navigator.serviceWorker
      ?.getRegistration()
      .then((r) => r?.showNotification(title, { body: "Kilka minut na uporządkowanie zadań.", tag: "tp-review", icon: "/icons/icon-192.png" }))
      .catch(() => undefined);
  }, [due, today]);

  if (!due.length) return null;
  return (
    <div className="mb-3 flex flex-col gap-1" data-testid="review-nudge">
      {due.map((k) => (
        <div key={k} className="flex items-center gap-1 rounded-md border border-amber-400/60 bg-amber-100/60 px-2 py-1 text-xs dark:bg-amber-900/30">
          <button type="button" className="min-w-0 flex-1 truncate text-left font-medium" onClick={() => navigate({ view: "review", id: k })}>
            🧭 Pora na przegląd {k === "daily" ? "dnia" : "tygodnia"}
          </button>
          <button type="button" aria-label="Nie dziś" title="Nie dziś" className="px-1 opacity-60 hover:opacity-100" onClick={() => setDismissed((d) => ({ ...d, [k]: today }))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
