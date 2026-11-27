"use client";

/**
 * Nawyki (M15, Etap 8): lista „Cykliczne” (`#/habits`) z paskiem 8 dni do uzupełniania wstecz, ekran
 * nawyku ze statystykami (`#/habit/<id>`: passy, regularność 7/30/90 dni, wykres tygodniowy, mapa
 * cieplna roku), formularz nawyku, wiersz w bloku „Dziś” i odhaczanie z powiadomienia. Wszystkie
 * reguły i liczby liczy `@taskplanner/core` (`habits.ts`); tu jest tylko układ.
 */
import {
  addDays,
  addHabitValue,
  applyFilter,
  canEditHabitDay,
  dayChip,
  deleteTaskOps,
  describeHabit,
  HABIT_BACKFILL_DAYS,
  HABIT_RATE_WINDOWS,
  habitDayStatus,
  habitDraft,
  habitEntryOps,
  habitFields,
  habitMonthly,
  habitProgressLabel,
  habitSaveOps,
  habitsForDay,
  habitStats,
  habitWeeks,
  habitYear,
  habitYearRange,
  previewDates,
  WEEKDAY_CODES,
  isEmptyFilter,
  isOpen,
  MAX_COUNT,
  MONTH_SHORT,
  nextHabitEntry,
  plural,
  pluralForm,
  relativeDay,
  REMINDER_PRESETS,
  reminderOffset,
  reopenTaskPatch,
  selectSeries,
  shortDate,
  toHabit,
  WEEKDAY,
  type DayState,
  type FilterQuery,
  type Habit,
  type HabitCompletion,
  type HabitDayStatus,
  type HabitDraft,
  type HabitEntry,
  type HabitForDay,
  type HabitReminderDraft,
  type HabitStreak,
  type IsoWeekday,
  type LocalDate,
  type LocalTime,
  type MonthlyBy,
  type RecurrenceEnd,
  type WeekdayCode,
  type ViewContext,
  type ViewTask,
} from "@taskplanner/core";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { AppData, List } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";
import { useRoute, type Route } from "@/lib/route";

import { lastSortKey, useAppEnv } from "./app-env";
import { FilterBar, type Field as FilterField } from "./filter-bar";
import { TaskItem, useTaskActions } from "./task-item";
import { Button, Card, Field, Input, navLinkClass, Select } from "./ui";

const EMPTY: readonly HabitCompletion[] = [];
const completionsOf = (data: AppData, id: string) => data.habitCompletions.get(id) ?? EMPTY;
const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)} %`);

const STREAK_UNIT: Record<HabitStreak["unit"], readonly [string, string, string]> = {
  occurrence: ["dzień", "dni", "dni"],
  week: ["tydzień", "tygodnie", "tygodni"],
  month: ["miesiąc", "miesiące", "miesięcy"],
};

const STATE_LABEL: Record<DayState, string> = {
  done: "zrobione",
  partial: "częściowo",
  skipped: "dzień wolny",
  missed: "opuszczone",
  pending: "do zrobienia",
  off: "bez planu",
};

/** Kolory stanów dnia: jedna barwa (zieleń) dla postępu, wolne — kreskowanie, opuszczone — blada czerwień. */
const STATE_CLASS: Record<DayState, string> = {
  done: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  partial: "bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  skipped: "habit-skipped text-[var(--muted)]",
  missed: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  pending: "bg-[var(--surface)] ring-1 ring-inset ring-[var(--accent)]",
  off: "bg-[var(--hover)] text-[var(--muted)]",
};

// ── Zapis wpisów ─────────────────────────────────────────────────────────────────────────────

function useHabitEntry() {
  const { data, today } = useAppEnv();
  const { run, notify } = useTaskActions();
  return useCallback(
    (task: ViewTask, habit: Habit, date: LocalDate, entry: HabitEntry, toast?: string) => {
      try {
        const previous = completionsOf(data, task.id).find((c) => c.date === date) ?? null;
        const { ops, undo } = habitEntryOps(habit, task.id, date, entry, { now: new Date(), today, previous });
        void run(ops, toast ? { text: toast, undo } : undefined);
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e));
      }
    },
    [data, today, run, notify],
  );
}

const entryToast = (task: ViewTask, date: LocalDate, today: LocalDate, entry: HabitEntry) => {
  const day = date === today ? "dziś" : dayChip(date);
  return entry === null ? `„${task.title}” — ${day} wyczyszczone` : entry.kind === "skipped" ? `„${task.title}” — ${day} dzień wolny` : `„${task.title}” — ${day} zrobione`;
};

// ── Pasek dni (uzupełnianie wstecz) ──────────────────────────────────────────────────────────

/** Dziś i 7 poprzednich dni; klik: brak → zrobione → wolne → brak. */
export function HabitDayStrip({ task, habit, size = "md" }: { task: ViewTask; habit: Habit; size?: "sm" | "md" }) {
  const { data, today } = useAppEnv();
  const save = useHabitEntry();
  const completions = completionsOf(data, task.id);
  const days = Array.from({ length: HABIT_BACKFILL_DAYS + 1 }, (_, i) => addDays(today, i - HABIT_BACKFILL_DAYS));
  return (
    <div className="flex gap-1" role="group" aria-label={`Ostatnie dni: ${task.title}`}>
      {days.map((date) => {
        const status = habitDayStatus(habit, completions, date, today);
        const editable = canEditHabitDay(habit, date, today);
        const progress = habitProgressLabel(habit, status);
        const weekday = WEEKDAY[(((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1) as IsoWeekday].short;
        const label = `${dayChip(date)} — ${STATE_LABEL[status.state]}${habit.target !== undefined && status.value !== null ? ` (${status.value} / ${habit.target})` : ""}${progress && status.period ? ` · ${progress}` : ""}`;
        return (
          <button
            key={date}
            type="button"
            disabled={!editable}
            title={editable ? `${label} — kliknij, aby zmienić` : label}
            aria-label={label}
            onClick={() => {
              const entry = nextHabitEntry(habit, status.entry);
              save(task, habit, date, entry, entryToast(task, date, today, entry));
            }}
            className={`flex flex-col items-center justify-center rounded-md leading-none transition hover:opacity-80 disabled:cursor-default disabled:opacity-40 ${size === "sm" ? "h-8 w-7 text-[10px]" : "h-11 w-9 text-xs"} ${STATE_CLASS[status.state]} ${date === today ? "font-semibold" : ""}`}
          >
            <span className="opacity-80">{weekday}</span>
            <span>{status.state === "done" ? "✓" : status.state === "skipped" ? "–" : Number(date.slice(8))}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Wiersz w „Dziś” ──────────────────────────────────────────────────────────────────────────

function Check({ done, label, onClick }: { done: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      onClick={onClick}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-xs ${done ? "border-emerald-600 bg-emerald-600 text-white" : "border-[var(--muted)] hover:border-emerald-600"}`}
    >
      {done ? "✓" : ""}
    </button>
  );
}

function StreakBadge({ streak }: { streak: HabitStreak }) {
  if (!streak.current) return null;
  return (
    <span className="shrink-0 text-xs text-[var(--muted)]" title={`Passa: ${plural(streak.current, STREAK_UNIT[streak.unit])} (najdłuższa ${streak.best})`}>
      🔥 {streak.current}
    </span>
  );
}

/** Wiersz nawyku w bloku „Dziś”: odhaczenie albo „− / +” celu ilościowego, dzień wolny, postęp i passa. */
export function HabitTodayItem({ item }: { item: HabitForDay }) {
  const { today } = useAppEnv();
  const [, navigate] = useRoute();
  const save = useHabitEntry();
  const { task, habit, status, streak } = item;
  const done = status.state === "done";
  const progress = habitProgressLabel(habit, status);
  const set = (entry: HabitEntry, toast?: string) => save(task, habit, today, entry, toast);
  return (
    <li data-task-id={task.id} className="flex items-center gap-3 py-2">
      {habit.target === undefined ? (
        <Check done={done} label={`Zrobione: ${task.title}`} onClick={() => set(done ? null : { kind: "done" }, done ? undefined : `„${task.title}” — zrobione`)} />
      ) : (
        <Check done={done} label={`Cel osiągnięty: ${task.title}`} onClick={() => set(done ? null : { kind: "done", value: habit.target }, done ? undefined : `„${task.title}” — cel osiągnięty`)} />
      )}
      <button type="button" onClick={() => navigate({ view: "habit", id: task.id })} className={`min-w-0 flex-1 truncate text-left text-sm hover:underline ${item.settled ? "text-[var(--muted)]" : ""}`}>
        {task.title}
        {progress ? <span className="ml-2 text-xs text-[var(--muted)]">{progress}</span> : null}
        {status.state === "skipped" ? <span className="ml-2 text-xs text-[var(--muted)]">dzień wolny</span> : null}
      </button>
      {habit.target !== undefined ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button kind="ghost" className="h-7 w-7 px-0" aria-label={`Odejmij 1: ${task.title}`} disabled={!status.entry || status.entry.kind !== "done"} onClick={() => set(addHabitValue(habit, status.entry, -1))}>
            −
          </Button>
          <Button kind="ghost" className="h-7 w-7 px-0" aria-label={`Dodaj 1: ${task.title}`} onClick={() => set(addHabitValue(habit, status.entry, 1))}>
            +
          </Button>
        </span>
      ) : null}
      {status.state !== "done" ? (
        <Button
          kind="ghost"
          className="shrink-0 px-2 py-0.5 text-xs"
          title="Dzień wolny nie przerywa passy"
          onClick={() => set(status.state === "skipped" ? null : { kind: "skipped" }, status.state === "skipped" ? undefined : `„${task.title}” — dziś dzień wolny`)}
        >
          {status.state === "skipped" ? "Cofnij wolne" : "Wolne"}
        </Button>
      ) : null}
      <StreakBadge streak={streak} />
    </li>
  );
}

// ── Lista „Cykliczne” ───────────────────────────────────────────────────────────────────────────

/** Cykliczne nie mają tagów, priorytetu, statusu ani terminu. */
const HIDDEN_FILTERS: readonly FilterField[] = ["tags", "priorities", "statuses", "due", "hasTime"];

export function HabitsView({ data, ctx, targetInbox, navigate }: { data: AppData; ctx: ViewContext; targetInbox: List | undefined; navigate: (route: Route) => void }) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<FilterQuery>({});
  const filtered = !isEmptyFilter(filter);
  const tasks = useMemo(() => (isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, ctx.today)), [data.tasks, filter, ctx.today]);
  const habits = useMemo(() => tasks.filter((t) => t.kind === "habit" && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId)).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)), [tasks, ctx.workspaceId]);
  const today = useMemo(() => habitsForDay(tasks, data.habitCompletions, ctx.today, ctx.today, ctx.workspaceId), [tasks, data.habitCompletions, ctx.today, ctx.workspaceId]);
  // Zwykłe zadania z powtarzaniem (seria) — bez passy i statystyk, ale też „cykliczne” dla użytkownika.
  const series = useMemo(() => selectSeries(tasks, ctx), [tasks, ctx]);
  const listName = useMemo(() => new Map(data.lists.map((l) => [l.id, l.name])), [data.lists]);
  const open = habits.filter(isOpen);
  const closed = habits.filter((t) => !isOpen(t));
  const left = today.filter((h) => !h.settled).length;
  return (
    <>
      <header className="tp-view-header mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Cykliczne</h1>
          <p className="text-sm text-[var(--muted)]">
            {open.length || filtered ? `${plural(today.length, ["cykliczne", "cykliczne", "cyklicznych"])} na dziś · ${left ? `${left} do zrobienia` : "wszystko zrobione"}` : "Codzienne i tygodniowe zadania cykliczne z passą i statystykami"}
          </p>
        </div>
        <Button kind="primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          + Nowe cykliczne
        </Button>
      </header>
      {adding ? (
        <Card className="mb-4">
          <HabitEditor task={null} defaultListId={targetInbox?.id} onDone={(id) => (setAdding(false), id ? navigate({ view: "habit", id }) : undefined)} />
        </Card>
      ) : null}
      <FilterBar query={filter} onChange={setFilter} hide={HIDDEN_FILTERS} />
      {open.length ? (
        <ul className="divide-y divide-[var(--line)]">
          {open.map((t) => (
            <HabitRow key={t.id} task={t} data={data} today={ctx.today} navigate={navigate} />
          ))}
        </ul>
      ) : filtered ? (
        <p className="py-6 text-center text-sm text-[var(--muted)]">Żadne otwarte zadanie cykliczne nie pasuje do filtra.</p>
      ) : !adding ? (
        <p className="py-6 text-center text-sm text-[var(--muted)]">
          {series.length ? "Nie masz jeszcze zadań cyklicznych z passą." : "Nie masz jeszcze zadań cyklicznych."} Dodaj pierwsze — np. „Woda 8 szklanek” albo „Siłownia 3 razy w tygodniu”.
        </p>
      ) : null}
      {series.length ? (
        <section className="mt-6" aria-label="Zadania z powtarzaniem">
          <h2 className="border-b border-[var(--line)] pb-1 text-sm font-semibold">
            Zadania z powtarzaniem <span className="text-xs font-normal text-[var(--muted)]">{series.length}</span>
          </h2>
          <p className="pt-1 text-xs text-[var(--muted)]">Zwykłe zadania z regułą powtarzania, bez passy i statystyk. Data to najbliższe wystąpienie.</p>
          <ul className="divide-y divide-[var(--line)]">
            {series.map((t) => (
              <TaskItem key={t.id} task={t} today={ctx.today} listName={listName.get(t.listId)} />
            ))}
          </ul>
        </section>
      ) : null}
      {closed.length ? (
        <section className="mt-6">
          <h2 className="border-b border-[var(--line)] pb-1 text-sm font-semibold">
            Zakończone <span className="text-xs font-normal text-[var(--muted)]">{closed.length}</span>
          </h2>
          <ul className="divide-y divide-[var(--line)]">
            {closed.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2 text-sm text-[var(--muted)]">
                <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => navigate({ view: "habit", id: t.id })}>
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function HabitRow({ task, data, today, navigate }: { task: ViewTask; data: AppData; today: LocalDate; navigate: (route: Route) => void }) {
  const habit = toHabit(task);
  const stats = habit ? habitStats(habit, completionsOf(data, task.id), today) : null;
  if (!habit || !stats) return null;
  return (
    <li data-task-id={task.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <button type="button" onClick={() => navigate({ view: "habit", id: task.id })} className="min-w-[12rem] flex-1 text-left">
        <span className="block truncate text-sm font-medium hover:underline">{task.title}</span>
        <span className="block truncate text-xs text-[var(--muted)]">
          {describeHabit(habit)} · 🔥 {plural(stats.streak.current, STREAK_UNIT[stats.streak.unit])} · 30 dni: {pct(stats.rates[30].rate)}
        </span>
      </button>
      <HabitDayStrip task={task} habit={habit} size="sm" />
    </li>
  );
}

// ── Ekran nawyku ze statystykami ─────────────────────────────────────────────────────────────

export function HabitDetail({ id, data, ctx, navigate }: { id: string; data: AppData; ctx: ViewContext; navigate: (route: Route) => void }) {
  const { run } = useTaskActions();
  const [editing, setEditing] = useState(false);
  const [shownYear, setShownYear] = useState<number | null>(null);
  const task = data.tasks.find((t) => t.id === id && t.kind === "habit");
  const habit = task ? toHabit(task) : null;
  const completions = task ? completionsOf(data, task.id) : EMPTY;
  const today = ctx.today;
  // React Compiler zapamiętuje wyniki między renderami; bez ręcznego `useMemo`.
  const stats = habit ? habitStats(habit, completions, today) : null;
  const weeks = habit ? habitWeeks(habit, completions, today, 12) : [];
  // Mapa roku: rok kalendarzowy (domyślnie bieżący), strzałkami w zakresie `habitYearRange`.
  const range = habit ? habitYearRange(habit, completions, today) : null;
  const yearShown = Math.min(Math.max(shownYear ?? Number(today.slice(0, 4)), range?.min ?? 0), range?.max ?? 9999);
  const year = habit ? habitYear(habit, completions, today, { year: yearShown }) : null;

  if (!task || !habit || !stats || !year) {
    return (
      <p className="py-6 text-sm text-[var(--muted)]">
        Tego zadania cyklicznego nie ma (usunięte albo w zarchiwizowanej liście).{" "}
        <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => navigate({ view: "habits" })}>
          Wróć do cyklicznych
        </button>
      </p>
    );
  }
  const open = isOpen(task);
  const unit = STREAK_UNIT[stats.streak.unit];
  const end = () =>
    void run([{ table: "tasks", id: task.id, patch: { status: "cancelled", completed_at: new Date().toISOString() } }], {
      text: `„${task.title}” — zakończony`,
      undo: [{ table: "tasks", id: task.id, patch: { status: task.status, completed_at: task.completedAt } }],
    });
  const remove = () => {
    if (!window.confirm(`Przenieść zadanie cykliczne „${task.title}” do kosza? Historia zostaje i wróci razem z nim.`)) return;
    const ops = deleteTaskOps(data.tasks, task.id, new Date());
    void run(ops, { text: `„${task.title}” w koszu`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: null } })) });
    navigate({ view: "habits" });
  };

  return (
    <>
      <nav className="mb-2">
        <button type="button" className={navLinkClass} onClick={() => navigate({ view: "habits" })}>
          ← Cykliczne
        </button>
      </nav>
      <header className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{task.title}</h1>
          <p className="text-sm text-[var(--muted)]">
            {describeHabit(habit)}
            {habit.time ? ` · o ${habit.time}` : ""} · od {shortDate(habit.recurrence.anchor)}
            {open ? "" : " · zakończony"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
            Edytuj
          </Button>
          {open ? <Button onClick={end}>Zakończ</Button> : <Button onClick={() => void run([{ table: "tasks", id: task.id, patch: reopenTaskPatch() }], { text: `„${task.title}” — wznowiony` })}>Wznów</Button>}
          <Button kind="danger" onClick={remove}>
            Usuń
          </Button>
        </div>
      </header>
      {editing ? (
        <Card className="mb-4">
          <HabitEditor task={task} onDone={() => setEditing(false)} />
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Bieżąca passa" value={String(stats.streak.current)} hint={pluralForm(stats.streak.current, unit)} />
        <Stat label="Najdłuższa passa" value={String(stats.streak.best)} hint={pluralForm(stats.streak.best, unit)} />
        <Stat
          label="Regularność 30 dni"
          value={pct(stats.rates[30].rate)}
          hint={`${stats.rates[30].done} z ${stats.rates[30].possible}`}
        />
        <Stat
          label={habit.target !== undefined ? `Razem${habit.unit ? ` (${habit.unit})` : ""}` : "Dni zrobione"}
          value={String(habit.target !== undefined ? stats.totalValue : stats.totalDone)}
          hint={habit.target !== undefined ? plural(stats.totalDone, ["dzień z celem", "dni z celem", "dni z celem"]) : "od początku"}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Regularność:{" "}
        {HABIT_RATE_WINDOWS.map((w) => `${w} dni ${pct(stats.rates[w].rate)} (${stats.rates[w].done}/${stats.rates[w].possible})`).join(" · ")}. Dni wolne i okres w toku się nie liczą.
      </p>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Ostatnie dni</h2>
        {open ? <HabitDayStrip task={task} habit={habit} /> : null}
        <p className="mt-1 text-xs text-[var(--muted)]">Kliknij dzień: zrobione → dzień wolny → wyczyść. Uzupełnić można do {HABIT_BACKFILL_DAYS} dni wstecz.</p>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">{habit.target !== undefined ? `Tygodnie — ${habit.unit ?? "wartość"}` : "Tygodnie — dni zrobione"}</h2>
        <WeeklyChart weeks={weeks} habit={habit} />
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-1">
          <h2 className="text-sm font-semibold">Rok</h2>
          <button type="button" aria-label="Poprzedni rok" disabled={yearShown <= range!.min} onClick={() => setShownYear(yearShown - 1)} className="rounded px-1.5 text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-30">
            ‹
          </button>
          <span className="min-w-[3rem] text-center text-sm tabular-nums" aria-live="polite">
            {yearShown}
          </span>
          <button type="button" aria-label="Następny rok" disabled={yearShown >= range!.max} onClick={() => setShownYear(yearShown + 1)} className="rounded px-1.5 text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-30">
            ›
          </button>
          {yearShown !== Number(today.slice(0, 4)) ? (
            <button type="button" onClick={() => setShownYear(null)} className="ml-1 text-xs text-[var(--accent)] hover:underline">
              Bieżący
            </button>
          ) : null}
        </div>
        <Heatmap key={yearShown} year={year} habit={habit} today={today} />
      </section>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}

/** Słupki ostatnich 12 tygodni: wartość (cel ilościowy) albo dni zrobione; tło słupka = cel tygodnia. */
function WeeklyChart({ weeks, habit }: { weeks: ReturnType<typeof habitWeeks>; habit: Habit }) {
  const quantity = habit.target !== undefined;
  const goal = (w: (typeof weeks)[number]) => (w.target === null ? null : quantity ? w.target * habit.target! : w.target);
  const value = (w: (typeof weeks)[number]) => (quantity ? w.value : w.done);
  const max = Math.max(1, ...weeks.map((w) => Math.max(value(w), goal(w) ?? 0)));
  return (
    <figure>
      <div className="flex h-32 items-end gap-1.5 border-b border-[var(--line)]" role="img" aria-label="Wykres tygodniowy, szczegóły w tabeli poniżej">
        {weeks.map((w, i) => {
          const g = goal(w);
          const v = value(w);
          const tip = `${shortDate(w.start)}–${shortDate(w.end)}: ${quantity ? `${v}${habit.unit ? ` ${habit.unit}` : ""}` : plural(w.done, ["dzień", "dni", "dni"])}${g !== null ? ` z ${g}` : ""}`;
          return (
            <div key={w.start} className="group relative flex h-full min-w-0 flex-1 items-end" title={tip}>
              {g !== null ? <div className="absolute inset-x-0 bottom-0 rounded-t bg-[var(--hover)]" style={{ height: `${(g / max) * 100}%` }} /> : null}
              <div className="relative w-full rounded-t bg-emerald-600 dark:bg-emerald-500" style={{ height: v ? `max(2px, ${(v / max) * 100}%)` : 0 }} />
              {i === weeks.length - 1 && v ? <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] tabular-nums text-[var(--muted)]">{v}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1.5 text-[10px] text-[var(--muted)]">
        {weeks.map((w, i) => (
          <span key={w.start} className="min-w-0 flex-1 text-center whitespace-nowrap">
            {i % 2 === weeks.length % 2 ? "" : `${Number(w.start.slice(8))}.${w.start.slice(5, 7)}`}
          </span>
        ))}
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-[var(--muted)]">Tabela tygodni</summary>
        <table className="mt-1 w-full max-w-md text-left tabular-nums">
          <thead className="text-[var(--muted)]">
            <tr>
              <th className="font-normal">Tydzień</th>
              <th className="font-normal">Zrobione dni</th>
              <th className="font-normal">Cel</th>
              {quantity ? <th className="font-normal">{habit.unit ?? "Wartość"}</th> : null}
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w) => (
              <tr key={w.start}>
                <td>
                  {shortDate(w.start)}–{shortDate(w.end)}
                </td>
                <td>{w.done}</td>
                <td>{w.target ?? "—"}</td>
                {quantity ? <td>{w.value}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

const LEGEND: DayState[] = ["done", "partial", "skipped", "missed", "off"];
const PLANNED_CLASS = "ring-1 ring-inset ring-[var(--accent)] bg-[var(--surface)]";

/** Mapa cieplna roku kalendarzowego: kolumny tygodni (pon–ndz), przyszłe dni nawyku jako zaplanowane. */
function Heatmap({ year, habit, today }: { year: ReturnType<typeof habitYear>; habit: Habit; today: LocalDate }) {
  const legend = LEGEND.filter((s) => s !== "partial" || habit.target !== undefined).filter((s) => s !== "missed" || !habit.goal);
  // Na wąskim ekranie mapa się przewija — zaczyna od bieżącego tygodnia (prawa krawędź).
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Po ułożeniu siatki (klatka później — inaczej szerokość bywa zerowa): dziś pod prawą krawędzią,
    // rok miniony — koniec, przyszły — początek.
    const frame = requestAnimationFrame(() => {
      const box = scroller.current;
      if (!box) return;
      const cell = box.querySelector<HTMLElement>(`[data-date="${today}"]`);
      if (cell) box.scrollLeft += cell.getBoundingClientRect().left - box.getBoundingClientRect().left - box.clientWidth * 0.75;
      else box.scrollLeft = year.weeks[0]![0]!.date > today ? 0 : box.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [today, year]);
  const planned = !habit.goal && year.weeks.some((w) => w.some((d) => d.planned));
  return (
    <figure>
      <div ref={scroller} className="overflow-x-auto pb-1">
        <div className="inline-grid gap-[3px]" style={{ gridTemplateColumns: `1.5rem repeat(${year.weeks.length}, 11px)`, gridTemplateRows: `auto repeat(7, 11px)` }}>
          <span />
          {year.weeks.map((_, column) => {
            const month = year.months.find((m) => m.column === column);
            return (
              <span key={`m${column}`} className="text-[10px] leading-3 whitespace-nowrap text-[var(--muted)]">
                {month ? MONTH_SHORT[month.month - 1] : ""}
              </span>
            );
          })}
          {([1, 2, 3, 4, 5, 6, 7] as IsoWeekday[]).map((d) => (
            <HeatRow key={d} weekday={d} year={year} habit={habit} />
          ))}
        </div>
      </div>
      {habit.goal && year.weeks.some((w) => w.some((d) => d.future && !d.outside)) ? (
        <p className="mt-1 text-xs text-[var(--muted)]">Przy „N razy w okresie” dni nie są z góry ustalone — przyszłe dni zapełnią się, gdy je odhaczysz.</p>
      ) : null}
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
        {legend.map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className={`inline-block h-[11px] w-[11px] rounded-sm ${STATE_CLASS[s]}`} /> {STATE_LABEL[s]} {year.counts[s] && s !== "off" ? `(${year.counts[s]})` : ""}
          </span>
        ))}
        {planned ? (
          <span className="inline-flex items-center gap-1">
            <span className={`inline-block h-[11px] w-[11px] rounded-sm ${PLANNED_CLASS}`} /> zaplanowane
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

function HeatRow({ weekday, year, habit }: { weekday: IsoWeekday; year: ReturnType<typeof habitYear>; habit: Habit }) {
  return (
    <>
      <span className="pr-1 text-right text-[10px] leading-[11px] text-[var(--muted)]">{weekday % 2 ? WEEKDAY[weekday].short : ""}</span>
      {year.weeks.map((week) => {
        const d = week[weekday - 1]!;
        if (d.outside) return <span key={d.date} />;
        if (d.future) {
          // Przyszły dzień bez planu — blada komórka, żeby siatka roku była widoczna.
          if (!d.planned) return <span key={d.date} title={dayChip(d.date)} className={`rounded-sm ${STATE_CLASS.off} opacity-30`} />;
          const label = `${dayChip(d.date)}: zaplanowane`;
          return <span key={d.date} title={label} aria-label={label} className={`rounded-sm ${PLANNED_CLASS}`} />;
        }
        const label = `${dayChip(d.date)}: ${STATE_LABEL[d.state]}${d.value !== null && habit.target !== undefined ? ` (${d.value} / ${habit.target})` : ""}`;
        return <span key={d.date} data-date={d.date} title={label} aria-label={label} className={`rounded-sm ${STATE_CLASS[d.state]} ${d.state === "off" ? "opacity-60" : ""}`} />;
      })}
    </>
  );
}

// ── Formularz nawyku ─────────────────────────────────────────────────────────────────────────

type ScheduleKind = HabitDraft["schedule"]["kind"];
const NTH: [number, string][] = [[1, "pierwszy"], [2, "drugi"], [3, "trzeci"], [4, "czwarty"], [-1, "ostatni"]];
type Row = Record<string, string | number | null>;

function listLabel(data: AppData, l: List) {
  const ws = data.workspaces.find((w) => w.id === l.workspaceId)?.name ?? "";
  return l.kind === "inbox" ? `Inbox (${ws})` : `${l.name} · ${ws}`;
}

export function HabitEditor({ task, defaultListId, onDone }: { task: ViewTask | null; defaultListId?: string; onDone: (id?: string) => void }) {
  const { data, store, today, userId } = useAppEnv();
  const { run } = useTaskActions();
  const { rows: reminderRows } = useLocalQuery<Row>(
    store,
    "select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null and (created_by is null or created_by = ?) order by kind desc, offset_min, at_date, at_time",
    [task?.id ?? "", userId],
    ["reminders"],
  );
  const initial = useMemo(() => habitDraft(task, today), [task, today]);
  const [title, setTitle] = useState(task?.title ?? "");
  const [listId, setListId] = useState(task?.listId ?? defaultListId ?? data.lists[0]?.id ?? "");
  const [kind, setKind] = useState<ScheduleKind>(initial.schedule.kind);
  const [days, setDays] = useState<IsoWeekday[]>(initial.schedule.kind === "days" ? initial.schedule.days : [1, 2, 3, 4, 5]);
  const [times, setTimes] = useState(initial.schedule.kind === "goal" ? initial.schedule.times : 3);
  const [period, setPeriod] = useState<"week" | "month">(initial.schedule.kind === "goal" ? initial.schedule.period : "week");
  const [monthly, setMonthly] = useState(initial.schedule.kind === "monthly" ? initial.schedule : habitMonthly(initial.start));
  const [quantity, setQuantity] = useState(initial.target !== null);
  const [target, setTarget] = useState(String(initial.target ?? 8));
  const [unit, setUnit] = useState(initial.unit ?? "");
  const [start, setStart] = useState(initial.start);
  const [time, setTime] = useState<string>(initial.time ?? "");
  const [endKind, setEndKind] = useState<RecurrenceEnd["kind"]>(initial.end?.kind ?? "never");
  const [endDate, setEndDate] = useState<string>(initial.end?.kind === "until" ? initial.end.date : addDays(initial.start, 29));
  const [endCount, setEndCount] = useState(String(initial.end?.kind === "count" ? initial.end.n : 30));
  // Lista przypomnień: z bazy, dopóki użytkownik jej nie zmieni (zapis dopiero przy „Zapisz”).
  const [reminderList, setReminderList] = useState<HabitReminderDraft[] | null>(null);
  const reminders: HabitReminderDraft[] =
    reminderList ??
    (task
      ? reminderRows.map((r) =>
          r.kind === "absolute"
            ? { id: String(r.id), kind: "absolute", atDate: String(r.at_date) as LocalDate, atTime: String(r.at_time).slice(0, 5) as LocalTime }
            : { id: String(r.id), kind: "relative", offsetMin: Number(r.offset_min) },
        )
      : []);
  const [error, setError] = useState<string | null>(null);
  const currentSchedule = (): HabitDraft["schedule"] =>
    kind === "days"
      ? { kind, days }
      : kind === "goal"
        ? { kind, period, times }
        : kind === "monthly"
          ? monthly
          : kind === "custom" && initial.schedule.kind === "custom"
            ? initial.schedule
            : { kind: "daily" };
  // Podgląd najbliższych dni przy „co miesiąc” (np. 31. dnia omija krótsze miesiące).
  const monthlyPreview = (() => {
    if (kind !== "monthly") return null;
    try {
      return previewDates(habitFields({ schedule: monthly, start: start as LocalDate, target: null, unit: null, time: null }).recurrence, today, 3);
    } catch {
      return null;
    }
  })();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      const schedule = currentSchedule();
      const end: RecurrenceEnd =
        endKind === "until" ? { kind: "until", date: endDate as LocalDate } : endKind === "count" && kind !== "goal" ? { kind: "count", n: Number(endCount) } : { kind: "never" };
      const draft: HabitDraft = { schedule, start, end, target: quantity ? Number(target.replace(",", ".")) : null, unit: quantity ? unit : null, time: (time || null) as LocalTime | null };
      if (reminders.some((r) => r.kind === "relative") && !draft.time) throw new Error("Przypomnienie przed porą zadania wymaga pory — ustaw ją albo dodaj przypomnienie na dzień i godzinę.");
      const { taskId, ops } = habitSaveOps({
        id: task?.id,
        title,
        listId,
        draft,
        reminders,
        reminderIds: reminderRows.map((r) => String(r.id)),
        lastSortKey: lastSortKey(data, listId),
        now: new Date(),
      });
      void run(ops, { text: task ? `Zapisano „${title.trim()}”` : `Dodano cykliczne „${title.trim()}”` });
      onDone(task ? undefined : taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <Field label="Nazwa">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="np. Woda, Spacer 30 min" autoFocus={!task} maxLength={500} required />
        </Field>
        <Field label="Lista">
          <Select value={listId} onChange={(e) => setListId(e.target.value)}>
            {data.lists.map((l) => (
              <option key={l.id} value={l.id}>
                {listLabel(data, l)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-medium">Jak często</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {(
            [
              ["daily", "Codziennie"],
              ["days", "W wybrane dni"],
              ["monthly", "Co miesiąc"],
              ["goal", "N razy w okresie"],
              ...(initial.schedule.kind === "custom" ? [["custom", "Bez zmian (własna reguła)"]] : []),
            ] as [ScheduleKind, string][]
          ).map(([k, label]) => (
            <label key={k} className="inline-flex items-center gap-1.5">
              <input type="radio" name="habit-schedule" checked={kind === k} onChange={() => setKind(k)} /> {label}
            </label>
          ))}
        </div>
        {kind === "days" ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Dni tygodnia">
            {([1, 2, 3, 4, 5, 6, 7] as IsoWeekday[]).map((d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
                  className={`h-8 w-11 rounded-md border text-xs ${on ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] hover:bg-[var(--hover)]"}`}
                >
                  {WEEKDAY[d].short}
                </button>
              );
            })}
          </div>
        ) : null}
        {kind === "goal" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input type="number" min={1} max={period === "week" ? 7 : 31} value={times} onChange={(e) => setTimes(Number(e.target.value))} aria-label="Ile razy" className="w-20" />
            <span>{pluralForm(times, ["raz", "razy", "razy"])} w</span>
            <Select value={period} onChange={(e) => setPeriod(e.target.value as "week" | "month")} aria-label="Okres">
              <option value="week">tygodniu</option>
              <option value="month">miesiącu</option>
            </Select>
            <span className="text-xs text-[var(--muted)]">
              dowolne dni; passa liczy się w {period === "week" ? "tygodniach" : "miesiącach"}
              {period === "month" ? (
                <>
                  {" · "}konkretny dzień?{" "}
                  <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setKind("monthly")}>
                    Co miesiąc
                  </button>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
        {kind === "monthly" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Którego dnia" value={monthly.by} onChange={(e) => setMonthly({ ...monthly, by: e.target.value as MonthlyBy })}>
              <option value="day">dnia</option>
              <option value="weekday">w dzień tygodnia</option>
              <option value="last_day">ostatniego dnia</option>
              <option value="last_workday">ostatniego dnia roboczego</option>
            </Select>
            {monthly.by === "day" ? (
              <Input type="number" min={1} max={31} value={monthly.day || ""} onChange={(e) => setMonthly({ ...monthly, day: Number(e.target.value) })} aria-label="Dzień miesiąca" className="w-20" />
            ) : null}
            {monthly.by === "weekday" ? (
              <>
                <Select aria-label="Który" value={monthly.nth} onChange={(e) => setMonthly({ ...monthly, nth: Number(e.target.value) })}>
                  {NTH.map(([n, label]) => (
                    <option key={n} value={n}>
                      {label}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Dzień tygodnia" value={monthly.weekday} onChange={(e) => setMonthly({ ...monthly, weekday: e.target.value as WeekdayCode })}>
                  {WEEKDAY_CODES.map((d, i) => (
                    <option key={d} value={d}>
                      {WEEKDAY[(i + 1) as IsoWeekday].label}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}
            <span>miesiąca</span>
            {monthlyPreview?.length ? <span className="text-xs text-[var(--muted)]">najbliżej: {monthlyPreview.map((d) => dayChip(d)).join(" · ")}</span> : null}
          </div>
        ) : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="inline-flex items-center gap-1.5 font-medium">
          <input type="checkbox" checked={quantity} onChange={(e) => setQuantity(e.target.checked)} /> Cel ilościowy
        </label>
        {quantity ? (
          <>
            <Input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Cel na dzień" className="w-20" />
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="szklanek" aria-label="Jednostka" maxLength={20} className="w-32" />
            <span className="text-xs text-[var(--muted)]">dziennie; mniej = „częściowo” (nie zalicza dnia)</span>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <Field label="Początek">
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
        </Field>
        <Field label="Pora (opcjonalnie)">
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        <Field label="Koniec">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={endKind === "count" && kind === "goal" ? "never" : endKind} onChange={(e) => setEndKind(e.target.value as RecurrenceEnd["kind"])} aria-label="Koniec powtarzania">
              <option value="never">nigdy</option>
              <option value="until">w dniu…</option>
              {kind !== "goal" ? <option value="count">po liczbie razy…</option> : null}
            </Select>
            {endKind === "until" ? <Input type="date" value={endDate} min={start} onChange={(e) => setEndDate(e.target.value)} aria-label="Dzień końca" required /> : null}
            {endKind === "count" && kind !== "goal" ? (
              <>
                <Input type="number" min={1} max={MAX_COUNT} value={endCount} onChange={(e) => setEndCount(e.target.value)} aria-label="Liczba powtórzeń" className="w-20" />
                <span>{pluralForm(Number(endCount) || 0, ["raz", "razy", "razy"])}</span>
              </>
            ) : null}
          </div>
        </Field>
      </div>
      <HabitRemindersField reminders={reminders} onChange={setReminderList} start={start} hasTime={!!time} />
      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button kind="primary" type="submit">
          {task ? "Zapisz" : "Dodaj cykliczne"}
        </Button>
        <Button kind="ghost" onClick={() => onDone()}>
          Anuluj
        </Button>
      </div>
    </form>
  );
}

/** Przypomnienia nawyku w formularzu: przed porą (w każdy dzień nawyku) albo jednorazowo w dniu i godzinie. */
function HabitRemindersField({ reminders, onChange, start, hasTime }: { reminders: HabitReminderDraft[]; onChange: (list: HabitReminderDraft[]) => void; start: LocalDate; hasTime: boolean }) {
  const { today } = useAppEnv();
  const [choice, setChoice] = useState("");
  const [at, setAt] = useState({ date: start > today ? start : today, time: "09:00" });
  const label = (r: HabitReminderDraft) =>
    r.kind === "relative" ? (r.offsetMin === 0 ? "o porze zadania" : `${reminderOffset(r.offsetMin)} porą zadania`) : `jednorazowo: ${relativeDay(r.atDate, today)}, ${r.atTime}`;
  const offsets = REMINDER_PRESETS.filter((m) => m < 1440 && !reminders.some((r) => r.kind === "relative" && r.offsetMin === m));

  return (
    <fieldset className="flex flex-col gap-1.5 text-sm">
      <legend className="mb-1 font-medium">Przypomnienia</legend>
      {reminders.length ? (
        <ul className="flex flex-col gap-1">
          {reminders.map((r, i) => (
            <li key={r.id ?? `new-${i}`} className="flex items-center gap-2">
              <span>🔔 {label(r)}</span>
              <button type="button" aria-label="Usuń przypomnienie" className="rounded px-1 text-[var(--muted)] hover:bg-[var(--hover)]" onClick={() => onChange(reminders.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--muted)]">Brak przypomnień</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Dodaj przypomnienie"
          value={choice}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith("rel:")) onChange([...reminders, { kind: "relative", offsetMin: Number(value.slice(4)) }]);
            setChoice(value === "abs" ? "abs" : "");
          }}
          className="py-1 text-xs"
        >
          <option value="">+ Dodaj przypomnienie…</option>
          {offsets.map((m) => (
            <option key={m} value={`rel:${m}`} disabled={!hasTime}>
              {m === 0 ? "o porze zadania" : `${reminderOffset(m)} porą zadania`}
              {hasTime ? "" : " (ustaw porę)"}
            </option>
          ))}
          <option value="abs">Jednorazowo: dzień i godzina…</option>
        </Select>
        {choice === "abs" ? (
          <span className="flex gap-1">
            <Input type="date" aria-label="Dzień przypomnienia" value={at.date} onChange={(e) => setAt({ ...at, date: e.target.value as LocalDate })} className="py-0.5 text-xs" />
            <Input type="time" aria-label="Godzina przypomnienia" value={at.time} onChange={(e) => setAt({ ...at, time: e.target.value })} className="py-0.5 text-xs" />
            <Button
              onClick={() => {
                if (!at.date || !at.time) return;
                onChange([...reminders, { kind: "absolute", atDate: at.date, atTime: at.time as LocalTime }]);
                setChoice("");
              }}
            >
              Dodaj
            </Button>
          </span>
        ) : null}
      </div>
      {reminders.length ? (
        <p className="text-xs text-[var(--muted)]">
          Przed porą — w każdy zaplanowany dzień, chyba że już odhaczone; jednorazowe — raz, w wybranym dniu. Powiadomienie ma przycisk „Zrobione”. Powiadomienia przeglądarki włączysz w Ustawieniach.
        </p>
      ) : null}
    </fieldset>
  );
}

// ── Odhaczanie z powiadomienia ───────────────────────────────────────────────────────────────

const HABIT_PARAM = "habitDone";

/**
 * Akcja „Zrobione” z powiadomienia nawyku (Service Worker): wiadomość `habit-done` do otwartej karty
 * albo `/?habitDone=<id>&date=<dzień>` w nowej. Zapis po wczytaniu lokalnej bazy; dzień już
 * zaliczony zostaje bez zmian.
 */
export function HabitNotificationActions() {
  const { data, today } = useAppEnv();
  const save = useHabitEntry();
  const [pending, setPending] = useState<{ taskId: string; date: string }[]>(() => {
    if (typeof window === "undefined") return [];
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get(HABIT_PARAM);
    const date = params.get("date");
    return taskId && date ? [{ taskId, date }] : [];
  });
  const handled = useRef(new Set<string>());

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has(HABIT_PARAM)) {
      url.searchParams.delete(HABIT_PARAM);
      url.searchParams.delete("date");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const { type, taskId, date } = event.data ?? {};
      if (type === "habit-done" && typeof taskId === "string" && typeof date === "string") setPending((p) => [...p, { taskId, date }]);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!data.loaded) return;
    for (const p of pending) {
      const key = `${p.taskId}:${p.date}`;
      if (handled.current.has(key)) continue;
      handled.current.add(key);
      const task = data.tasks.find((t) => t.id === p.taskId && t.kind === "habit");
      const habit = task ? toHabit(task) : null;
      if (!task || !habit) continue;
      const status: HabitDayStatus = habitDayStatus(habit, completionsOf(data, task.id), p.date as LocalDate, today);
      if (status.state === "done") continue;
      save(task, habit, p.date as LocalDate, { kind: "done", value: habit.target ?? null }, `„${task.title}” — zrobione (z powiadomienia)`);
    }
  }, [data, pending, today, save]);
  return null;
}
