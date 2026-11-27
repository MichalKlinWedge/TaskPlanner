"use client";

/**
 * Strona startowa (`#/home`, domyślna po zalogowaniu i po kliknięciu „Task Planner” w nagłówku):
 * pole szybkiego dodawania do Inboxu i pulpit statystyk. Liczby liczy core `homeStats` z lokalnych danych
 * (działa offline); tu jest tylko układ i wykresy w HTML (bez biblioteki).
 */
import { addDays, dayChip, dayLabel, formatMinutes, HOME_HISTORY_DAYS, homeStats, homeStatsFrom, PRIORITY, plural, pluralForm, WEEKDAY, isoWeekday, type IsoWeekday, type Priority, type ViewContext } from "@taskplanner/core";
import { useMemo, useState, type ReactNode } from "react";

import type { AppData, List } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";
import type { Route } from "@/lib/route";

import { useAppEnv } from "./app-env";
import { useFocus } from "./focus";
import { QuickAdd } from "./quick-add";

const GREETING = (hour: number) => (hour < 5 ? "Dobranoc" : hour < 18 ? "Dzień dobry" : "Dobry wieczór");

export function HomeView({ data, ctx, targetInbox, navigate }: { data: AppData; ctx: ViewContext; targetInbox: List | undefined; navigate: (route: Route) => void }) {
  const { store, settings } = useAppEnv();
  const focus = useFocus();
  const series = useLocalQuery<Record<string, string | null>>(
    store,
    `select c.task_id, c.completed_at from task_completions c join tasks t on t.id = c.task_id
       where c.deleted_at is null and c.kind = 'done' and t.kind = 'task' and t.deleted_at is null and c.completed_at >= ?`,
    [addDays(homeStatsFrom(ctx.today), -2)],
    ["task_completions", "tasks"],
  );
  const minute = Math.floor(focus.now / 60_000);
  const stats = useMemo(
    () =>
      homeStats(
        {
          tasks: data.tasks,
          lists: data.lists,
          seriesDone: series.rows.map((r) => ({ taskId: String(r.task_id), completedAt: String(r.completed_at) })),
          habitCompletions: data.habitCompletions,
          timeEntries: focus.entries,
          now: new Date(minute * 60_000),
        },
        ctx,
      ),
    [data.tasks, data.lists, data.habitCompletions, series.rows, focus.entries, minute, ctx],
  );

  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const inboxLabel = targetInbox && !ctx.workspaceId && data.workspaces.length > 1 ? `Dodaj do Inboxu („${workspaceName.get(targetInbox.workspaceId)}”)` : "Dodaj do Inboxu";
  const trend = stats.doneWeek - stats.donePrevWeek;
  const hour = new Date(minute * 60_000).getHours();

  return (
    <div data-testid="home">
      <header className="tp-view-header mb-3">
        <h1 className="text-xl font-semibold">{GREETING(hour)}</h1>
        <p className="text-sm text-[var(--muted)]">
          {dayLabel(ctx.today)}
          {ctx.workspaceId ? ` · ${workspaceName.get(ctx.workspaceId) ?? ""}` : " · wszystkie przestrzenie"}
        </p>
      </header>

      <QuickAdd listId={targetInbox?.id} placeholder={inboxLabel} />

      <section aria-label="Podsumowanie" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Tile label="Na dziś" value={stats.today} hint={stats.today ? "otwarte z terminem dziś" : "nic na dziś"} onClick={() => navigate({ view: "today" })} />
        <Tile label="Zaległe" value={stats.overdue} danger={stats.overdue > 0} hint={stats.overdue ? "po terminie" : "wszystko na czas"} onClick={() => navigate({ view: "overdue" })} />
        <Tile label="Inbox" value={stats.inbox} hint={stats.inbox ? "do rozplanowania" : "pusty"} onClick={() => navigate({ view: "inbox" })} />
        <Tile label="Otwarte" value={stats.open} hint="wszystkie niezamknięte" />
        <Tile label="Ukończone dziś" value={stats.doneToday} hint={stats.streak > 1 ? `seria: ${plural(stats.streak, ["dzień", "dni", "dni"])} z rzędu` : stats.streak === 1 ? "seria: 1 dzień" : "jeszcze bez serii"} />
        <Tile
          label="Ukończone w 7 dni"
          value={stats.doneWeek}
          hint={trend === 0 ? "tyle samo co tydzień wcześniej" : `${trend > 0 ? "▲" : "▼"} ${Math.abs(trend)} wobec poprzednich 7 dni`}
        />
        <Tile label="Dodane w 7 dni" value={stats.createdWeek} hint={stats.createdWeek > stats.doneWeek ? "przybywa szybciej, niż ubywa" : "ubywa co najmniej tyle, ile przybywa"} />
        {stats.habitsTotal ? (
          <Tile label="Nawyki dziś" value={`${stats.habitsDone}/${stats.habitsTotal}`} hint={stats.habitsDone === stats.habitsTotal ? "wszystkie zaliczone" : "do odhaczenia"} onClick={() => navigate({ view: "habits" })} />
        ) : settings.focus.enabled ? (
          <Tile label="Skupienie dziś" value={formatMinutes(stats.focusTodayMin)} hint="minuty pracy w trybie skupienia" onClick={() => navigate({ view: "focus" })} />
        ) : null}
      </section>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <HistoryChart history={stats.history} />
        <UpcomingChart days={stats.upcoming} today={ctx.today} onOpen={() => navigate({ view: "upcoming" })} />
        <PriorityChart counts={stats.priority} total={stats.open} />
        <ListsProgress items={stats.lists} data={data} navigate={navigate} />
      </div>
    </div>
  );
}

function Tile({ label, value, hint, danger, onClick }: { label: string; value: number | string; hint?: string; danger?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${danger ? "text-[var(--danger)]" : ""}`}>{value}</span>
      {hint ? <span className="truncate text-xs text-[var(--muted)]">{hint}</span> : null}
    </>
  );
  const box = "flex min-w-0 flex-col gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${box} hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none`} data-testid={`home-tile-${label}`}>
      {body}
    </button>
  ) : (
    <div className={box} data-testid={`home-tile-${label}`}>
      {body}
    </div>
  );
}

function Card({ title, readout, legend, children }: { title: string; readout?: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {legend}
      </div>
      {children}
      {/* Odczyt najechanego słupka — zamiast dymka, który zasłaniałby sąsiednie. */}
      <p className="mt-2 min-h-4 text-xs text-[var(--muted)]" aria-live="polite">
        {readout ?? " "}
      </p>
    </section>
  );
}

const Swatch = ({ color, label }: { color: string; label: string }) => (
  <span className="flex items-center gap-1 text-xs text-[var(--muted)]">
    <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
    {label}
  </span>
);

const DONE_COLOR = "var(--accent)";
const CREATED_COLOR = "color-mix(in srgb, var(--muted) 45%, var(--surface))";
const weekday = (date: string) => WEEKDAY[isoWeekday(date) as IsoWeekday].short;

/** Słupki od podstawy do góry: wysokość w % maksimum, zaokrąglony tylko koniec z danymi. */
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return <span className="block w-full rounded-t-[3px]" style={{ height: value ? `${Math.max(3, (value / max) * 100)}%` : 0, background: color }} />;
}

function HistoryChart({ history }: { history: { date: string; done: number; created: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...history.flatMap((d) => [d.done, d.created]));
  const day = hover === null ? null : history[hover];
  const totalDone = history.reduce((n, d) => n + d.done, 0);
  return (
    <Card
      title={`Ukończone i dodane — ${HOME_HISTORY_DAYS} dni`}
      legend={
        <>
          <Swatch color={DONE_COLOR} label="ukończone" />
          <Swatch color={CREATED_COLOR} label="dodane" />
        </>
      }
      readout={day ? `${dayChip(day.date)}: ukończone ${day.done}, dodane ${day.created}` : `Razem ukończone: ${totalDone}`}
    >
      <div className="flex h-36 items-end gap-1 border-b border-[var(--line)]" onMouseLeave={() => setHover(null)} data-testid="home-history">
        {history.map((d, i) => (
          <div
            key={d.date}
            className={`flex h-full min-w-0 flex-1 items-end justify-center gap-px rounded-t ${hover === i ? "bg-[var(--hover)]" : ""}`}
            onMouseEnter={() => setHover(i)}
            role="img"
            aria-label={`${dayLabel(d.date)}: ukończone ${d.done}, dodane ${d.created}`}
          >
            <span className="flex h-full w-1/2 max-w-3 items-end">
              <Bar value={d.done} max={max} color={DONE_COLOR} />
            </span>
            <span className="flex h-full w-1/2 max-w-3 items-end">
              <Bar value={d.created} max={max} color={CREATED_COLOR} />
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[10px] text-[var(--muted)]">
        {history.map((d, i) => (
          <span key={d.date} className="min-w-0 flex-1 truncate text-center">
            {i === history.length - 1 ? "dziś" : i % 2 === (history.length - 1) % 2 ? weekday(d.date) : ""}
          </span>
        ))}
      </div>
    </Card>
  );
}

function UpcomingChart({ days, today, onOpen }: { days: { date: string; items: number; minutes: number }[]; today: string; onOpen: () => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.items));
  const day = hover === null ? null : days[hover];
  const total = days.reduce((n, d) => n + d.items, 0);
  return (
    <Card
      title="Najbliższe dni"
      readout={
        day
          ? `${dayChip(day.date)}: ${plural(day.items, ["zadanie", "zadania", "zadań"])}${day.minutes ? `, ${formatMinutes(day.minutes)} zaplanowanego czasu` : ""}`
          : `Razem: ${plural(total, ["zadanie", "zadania", "zadań"])} w ${days.length} dni`
      }
    >
      <div className="flex h-36 items-end gap-2 border-b border-[var(--line)]" onMouseLeave={() => setHover(null)} data-testid="home-upcoming">
        {days.map((d, i) => (
          <button
            type="button"
            key={d.date}
            onClick={onOpen}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${dayLabel(d.date)}: ${plural(d.items, ["zadanie", "zadania", "zadań"])} — otwórz Nadchodzące`}
            className={`flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-t px-1 focus-visible:outline-none ${hover === i ? "bg-[var(--hover)]" : ""}`}
          >
            {d.items ? <span className="mb-0.5 text-[11px] text-[var(--muted)] tabular-nums">{d.items}</span> : null}
            <span className="flex w-full max-w-8 items-end" style={{ height: d.items ? `${(d.items / max) * 85}%` : 0 }}>
              <Bar value={d.items} max={d.items || 1} color={d.date === today ? DONE_COLOR : "color-mix(in srgb, var(--accent) 55%, var(--surface))"} />
            </span>
          </button>
        ))}
      </div>
      <div className="mt-1 flex gap-2 text-[10px] text-[var(--muted)]">
        {days.map((d) => (
          <span key={d.date} className="min-w-0 flex-1 truncate text-center">
            {d.date === today ? "dziś" : `${weekday(d.date)} ${Number(d.date.slice(8, 10))}`}
          </span>
        ))}
      </div>
    </Card>
  );
}

function PriorityChart({ counts, total }: { counts: Record<Priority, number>; total: number }) {
  const max = Math.max(1, ...Object.values(counts));
  return (
    <Card title="Otwarte według priorytetu" readout={total ? `Razem ${plural(total, ["otwarte zadanie", "otwarte zadania", "otwartych zadań"])}` : "Brak otwartych zadań"}>
      <ul className="flex flex-col gap-2" data-testid="home-priority">
        {([1, 2, 3, 4] as const).map((p) => (
          <li key={p} className="flex items-center gap-2 text-sm">
            <span className="w-20 shrink-0 text-xs text-[var(--muted)]">{PRIORITY[p].label}</span>
            <span className="h-3 min-w-0 flex-1">
              <span className="block h-full rounded-r-[3px]" style={{ width: counts[p] ? `${Math.max(1.5, (counts[p] / max) * 100)}%` : 0, background: PRIORITY[p].color }} />
            </span>
            <span className="w-10 shrink-0 text-right text-xs tabular-nums">{counts[p]}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ListsProgress({ items, data, navigate }: { items: { listId: string; open: number; done: number }[]; data: AppData; navigate: (route: Route) => void }) {
  const lists = new Map(data.lists.map((l) => [l.id, l]));
  return (
    <Card title="Listy i projekty z największą liczbą otwartych" readout={items.length ? "Pasek = ukończone z wszystkich zadań listy (bez anulowanych)" : "Brak otwartych zadań poza Inboxem"}>
      <ul className="flex flex-col gap-2" data-testid="home-lists">
        {items.map((item) => {
          const list = lists.get(item.listId);
          const total = item.open + item.done;
          const pct = total ? Math.round((item.done / total) * 100) : 0;
          return (
            <li key={item.listId}>
              <a
                href={`#/list/${item.listId}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ view: "list", id: item.listId });
                }}
                className="block rounded px-1 py-0.5 hover:bg-[var(--hover)]"
              >
                <span className="flex items-baseline gap-2 text-sm">
                  <span aria-hidden className={`h-2 w-2 shrink-0 ${list?.kind === "project" ? "rotate-45 rounded-[2px]" : "rounded-full"}`} style={{ background: list?.color ?? "var(--muted)" }} />
                  <span className="min-w-0 flex-1 truncate">{list?.name ?? "(lista)"}</span>
                  <span className="shrink-0 text-xs text-[var(--muted)] tabular-nums">
                    {item.open} {pluralForm(item.open, ["otwarte", "otwarte", "otwartych"])} · {pct}%
                  </span>
                </span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-[var(--hover)]">
                  <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: DONE_COLOR }} />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
