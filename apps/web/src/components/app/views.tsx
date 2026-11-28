"use client";

/**
 * Widoki list (M9): Inbox, Dziś, Zaległe, Nadchodzące, Bez terminu, lista/projekt. Wybór i kolejność zadań liczy
 * `@taskplanner/core` (`selectInbox`, `selectToday`, `selectUpcoming`, `buildTree`, `groupTasks`…);
 * tu jest tylko układ. Widoki zbiorcze mają opcje widoku listy (`useSmartView`): „Lista | Tablica” i kolumny
 * z `settings.views` profilu; tablica z `smartBoard`.
 */
import {
  addDays,
  buildTree,
  bulkTaskOps,
  canAddSubtask,
  capitalized,
  COMPLETED_MODE,
  dayLabel,
  dayMonth,
  flattenTree,
  GROUP_BY,
  groupTasks,
  habitsForDay,
  isEmptyFilter,
  isOpen,
  LIST_COLUMN,
  LIST_KIND,
  matchesFilter,
  minutesLate,
  orderedColumns,
  overdueLaterOps,
  overdueToTodayOps,
  plural,
  progress,
  PROJECT_STATUS,
  relativeDay,
  selectInbox,
  selectToday,
  selectOverdue,
  selectUndated,
  selectUpcoming,
  smartBoard,
  smartViewsPatch,
  SORT_BY,
  smartSortChoice,
  smartSortDefault,
  smartSortOptions,
  sortSection,
  sortTasks,
  headerSortPatch,
  tagsForWorkspace,
  TRASH_DAYS,
  trashedWith,
  trashListLabel,
  trashPreview,
  trashRoots,
  undatedSections,
  VIEW_SECTION,
  withCompleted,
  type BoardBy,
  type CompletedMode,
  type FilterQuery,
  type GroupBy,
  type ListColumn,
  type LocalDate,
  type SmartView,
  type SmartViewPrefs,
  type SortBy,
  type SortDir,
  type ViewContext,
  type ViewPrefs,
  type ViewSettingsKey,
  type ViewTask,
  READONLY_LIST_NOTE,
  listShareBadge,
  type ListShareBadge,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { listEditable, useLocalMinute, type AppData, type List } from "@/lib/app-data";
import { updateListPrefs, updateSettings } from "@/lib/json-update";
import { setLocalListPrefs } from "@/lib/local-list-prefs";
import { useListWidths } from "@/lib/list-widths";
import { useTrash } from "@/lib/trash";
import { useClickOutside } from "@/lib/use-click-outside";

import { useAppEnv } from "./app-env";
import { Board } from "./board";
import { CanvasView } from "./canvas";
import { DayDnd, DayDrop, DraggableTaskItem, SortableTaskItem, SortableTaskList } from "./dnd";
import { TaskExportButton } from "./export";
import { FilterBar } from "./filter-bar";
import { HabitTodayItem } from "./habits";
import { ProjectStatusSelect } from "./project-status";
import { PurgeButton } from "./purge-button";
import { QuickAdd } from "./quick-add";
import { TaskColumnsHeader, TaskItem, useTaskActions } from "./task-item";
import { SortControls, type SortChoice } from "./sort-controls";
import { SaveTemplateButton } from "./templates";
import { Button, Select } from "./ui";

export interface ViewProps {
  data: AppData;
  ctx: ViewContext;
  /** Inbox, do którego trafiają nowe zadania z widoków zbiorczych. */
  targetInbox: List | undefined;
  /** Pasek pod nagłówkiem (chipy filtrów). */
  toolbar?: ReactNode;
}

/** Nagłówek widoku: tytuł po lewej, przyciski widoku (`children`) w prawym górnym rogu obszaru treści (`tp-view-header`). */
function Header({ title, subtitle, badge, children }: { title: string; subtitle?: string; badge?: ListShareBadge | null; children?: ReactNode }) {
  return (
    <header className="tp-view-header mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
      {/* `min-w-48`: przy wąskim ekranie przyciski schodzą do nowego wiersza, zamiast ścisnąć tytuł do zera. */}
      <div className="min-w-48 flex-1">
        <h1 className="text-xl font-semibold">
          {title}
          {badge ? (
            <span className="ml-2 align-middle text-base font-normal opacity-70" title={badge.label} aria-label={badge.label} data-testid="list-share-badge">
              {badge.icon}
            </span>
          ) : null}
        </h1>
        {subtitle ? <p className="text-sm text-[var(--muted)]">{subtitle}</p> : null}
      </div>
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

function Section({ title, count, tone, highlight, children }: { title: string; count?: number; tone?: "danger"; highlight?: boolean; children: ReactNode }) {
  return (
    <section className={`mt-4 rounded-md transition-colors ${highlight ? "bg-indigo-50 ring-2 ring-[var(--accent)] dark:bg-indigo-950/40" : ""}`}>
      <h2 className={`flex items-baseline gap-2 border-b border-[var(--line)] pb-1 text-sm font-semibold ${tone === "danger" ? "text-[var(--danger)]" : ""}`}>
        {title}
        {count !== undefined ? <span className="text-xs font-normal text-[var(--muted)]">{count}</span> : null}
      </h2>
      <ul className="divide-y divide-[var(--line)]">{children}</ul>
    </section>
  );
}

/**
 * Ile wierszy sekcja rysuje od razu — reszta po „Pokaż więcej”. Etap 13 (10 000 zadań): ~700
 * zaległych w „Dziś” i ~1 500 dni „Nadchodzących” rysowało się 250–700 ms (§9: < 100 ms).
 */
const PAGE = 50;

function Paged<T>({ items, children }: { items: readonly T[]; children: (item: T) => ReactNode }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      {items.slice(0, shown).map((item) => children(item))}
      {items.length > shown ? (
        <li className="py-1.5">
          <button type="button" className="text-xs text-[var(--accent)] hover:underline" onClick={() => setShown((n) => n + PAGE * 4)}>
            Pokaż więcej ({items.length - shown})
          </button>
        </li>
      ) : null}
    </>
  );
}

/** Aktywny filtr widoku (chipy) — pusty stan mówi wtedy „nic nie pasuje”, a nie „pusto” (shell podaje stan i czyszczenie). */
export const FilterEmptyContext = createContext<{ active: boolean; clear: () => void }>({ active: false, clear: () => undefined });

function Empty({ children }: { children: ReactNode }) {
  const filter = useContext(FilterEmptyContext);
  if (filter.active)
    return (
      <p className="py-6 text-center text-sm text-[var(--muted)]">
        Nic nie pasuje do filtra.{" "}
        <button type="button" className="font-medium text-[var(--accent)] hover:underline" onClick={filter.clear}>
          Wyczyść filtr
        </button>
      </p>
    );
  return <p className="py-6 text-center text-sm text-[var(--muted)]">{children}</p>;
}

const listNames = (data: AppData) => new Map(data.lists.map((l) => [l.id, l.name]));

// ── Opcje widoku zbiorczego ──────────────────────────────────────────────────────────────────

/** „Lista | Tablica | …” w nagłówku. */
function ViewSwitch<V extends keyof typeof VIEW_LABEL>({ views, value, onChange }: { views: readonly V[]; value: V; onChange: (view: V) => void }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-[var(--line)] text-xs" role="radiogroup" aria-label="Widok">
      {views.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={`px-2.5 py-1 ${value === v ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--hover)]"}`}>
          {VIEW_LABEL[v]}
        </button>
      ))}
    </div>
  );
}

/** Kolumny widoku: ustalona kolejność i tagi kolumny „Tagi” — wybrane (tylko istniejące) albo `null` = wszystkie. */
function useColumns(prefs: SmartViewPrefs, tags: AppData["tags"]) {
  const columns = orderedColumns(prefs.columns);
  const columnTagIds = prefs.columnTags;
  const columnTags = useMemo(() => {
    const known = (columnTagIds ?? []).filter((id) => tags.some((t) => t.id === id));
    return known.length ? new Set(known) : null;
  }, [columnTagIds, tags]);
  return { columns, columnTags };
}

/** Wiersze z kolumnami: bywają szersze od ekranu (szerokości z nagłówka) — przewijanie w poziomie; `pl-5` zostawia miejsce na uchwyt ⋮⋮. */
export function ColumnsScroll({ columns, children }: { columns: readonly ListColumn[]; children: ReactNode }) {
  return (
    <div className={columns.length ? "-ml-5 overflow-x-auto pl-5" : "contents"} data-testid="list-scroll">
      {/* Szerokość nie mniejsza niż minimum wierszy (stałe „Zadanie”, ściśnięte kolumny) — reszta to suwak poziomy. */}
      <div className={columns.length ? "min-w-min" : "contents"}>{children}</div>
    </div>
  );
}

/**
 * Kolumny widoku z `settings.views[id]` (synchronizowane): „Kolumny” (`picker`), nagłówek i właściwości wierszy (`cols`).
 * Widoki zbiorcze i — wspólnie dla wszystkich tagów / zapisanych filtrów — klucze `tag` / `filter`.
 */
export function useViewColumns(id: ViewSettingsKey, ctx: ViewContext, { sortable = false }: { sortable?: boolean } = {}) {
  const { store, settings, userId, data } = useAppEnv();
  const { notify } = useTaskActions();
  const prefs = settings.views[id] ?? {};
  const { columns, columnTags } = useColumns(prefs, data.tags);
  const [widths, setWidth] = useListWidths(`view:${id}`);
  // Z najnowszych ustawień w bazie, nie z renderu — szybkie kolejne kliknięcia się nie nadpisują.
  const setPrefs = (patch: Partial<SmartViewPrefs> | ((current: SmartViewPrefs) => Partial<SmartViewPrefs>)) =>
    void updateSettings(store, userId, (s) => ({ views: smartViewsPatch(s.views, id, typeof patch === "function" ? patch(s.views[id] ?? {}) : patch) })).catch((e: unknown) => notify(String(e)));
  const sort = smartSortChoice(id, prefs);
  const sortOptions = smartSortOptions(id);
  return {
    prefs,
    setPrefs,
    sort,
    cols: { columns, columnTags, widths },
    picker: (
      <ColumnsPicker
        value={columns}
        onToggle={(column, on) => setPrefs((p) => ({ columns: toggleColumn(p.columns, column, on) }))}
        tags={tagsForWorkspace(data.tags, ctx.workspaceId ?? null, prefs.columnTags)}
        tagValue={columnTags ? [...columnTags] : []}
        onTagToggle={(tagId, on) => setPrefs((p) => ({ columnTags: toggleId(p.columnTags, tagId, on) }))}
      />
    ),
    columnsHeader: (
      <TaskColumnsHeader columns={columns} widths={widths} onResize={setWidth} sort={sortable ? sort : undefined} onSort={sortable ? (by) => setPrefs((p) => { const s = smartSortChoice(id, p); return headerSortPatch({ sortBy: s.by, sortDir: s.dir }, by); }) : undefined} sortOptions={sortOptions} />
    ),
    /** Sortowanie dla tablicy widoku (te same ustawienia co lista). */
    boardSort: { by: sort.by, dir: sort.dir, labels: sortOptions, onChange: (patch) => setPrefs({ ...patch, ...(patch.sortBy === smartSortDefault(id) && { sortBy: undefined }) }) } satisfies SortChoice,
    sortControls: sortable ? (
      <SortControls
        by={sort.by}
        dir={sort.dir}
        labels={sortOptions}
        title={id === "tag" || id === "filter" ? undefined : "Sortowanie w obrębie sekcji i dni"}
        onBy={(by) => setPrefs({ sortBy: by === smartSortDefault(id) ? undefined : by, sortDir: undefined })}
        onDir={() => setPrefs((p) => ({ sortDir: p.sortDir === "desc" ? undefined : "desc" }))}
      />
    ) : null,
  };
}

/** Ustawienia widoku zbiorczego (`settings.views`, synchronizowane) i części układu: przełącznik, „Kolumny”, tablica. */
function useSmartView(id: SmartView, ctx: ViewContext, targetInbox: List | undefined) {
  const { prefs, setPrefs, sort, boardSort, cols, picker, columnsHeader, sortControls } = useViewColumns(id, ctx, { sortable: true });
  const kanban = prefs.view === "kanban";
  return {
    kanban,
    cols,
    sort,
    switcher: <ViewSwitch views={["list", "kanban"]} value={kanban ? "kanban" : "list"} onChange={(view) => setPrefs({ view })} />,
    columnsBar: kanban ? null : (
      <div className="mb-2 flex flex-wrap gap-2">
        {sortControls}
        {picker}
      </div>
    ),
    columnsHeader,
    board: (tasks: readonly ViewTask[], opts: { inboxIds?: ReadonlySet<string>; now?: string; addLabel?: string }) => (
      <SmartBoardView id={id} tasks={tasks} ctx={ctx} targetInbox={targetInbox} by={prefs.boardBy ?? (id === "upcoming" ? "weekday" : "status")} onBy={(boardBy) => setPrefs({ boardBy })} sort={boardSort} {...opts} />
    ),
  };
}

const NO_IDS: ReadonlySet<string> = new Set();

/** Tablica widoku zbiorczego: `tasks` po filtrze; pozostałe dane (podzadania, listy) pełne. */
function SmartBoardView({ id, tasks, ctx, targetInbox, by, onBy, sort, inboxIds = NO_IDS, now = "", addLabel }: { id: SmartView; tasks: readonly ViewTask[]; ctx: ViewContext; targetInbox: List | undefined; by: BoardBy; onBy: (by: BoardBy) => void; sort: SortChoice; inboxIds?: ReadonlySet<string>; now?: string; addLabel?: string }) {
  const { data } = useAppEnv();
  const smart = useMemo(() => smartBoard(id, tasks, ctx, { inboxIds, now }), [id, tasks, ctx, inboxIds, now]);
  return <Board data={data} ctx={ctx} tasks={smart.tasks} by={by} onBy={onBy} listId={targetInbox?.id} showList={id !== "inbox" || !ctx.workspaceId} addLabel={addLabel} smart={smart} sort={sort} />;
}

// ── Inbox ────────────────────────────────────────────────────────────────────────────────────

export function InboxView({ data, ctx, targetInbox, toolbar }: ViewProps) {
  const inboxIds = useMemo(() => new Set(data.lists.filter((l) => l.kind === "inbox").map((l) => l.id)), [data.lists]);
  const view = useSmartView("inbox", ctx, targetInbox);
  const { by, dir } = view.sort;
  const tasks = useMemo(() => sortSection(selectInbox(data.tasks, inboxIds, ctx), by, dir, (t) => t), [data.tasks, inboxIds, ctx, by, dir]);
  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const all = !ctx.workspaceId;
  const addLabel = targetInbox && all ? `Dodaj do Inboxu („${workspaceName.get(targetInbox.workspaceId)}”)` : "Dodaj do Inboxu";
  return (
    <>
      <Header title="Inbox" subtitle={plural(tasks.length, ["zadanie", "zadania", "zadań"])}>
        <TaskExportButton title="Inbox" data={data} ctx={ctx} count={tasks.length} rows={() => tasks.map((task) => ({ task }))} />
        {view.switcher}
      </Header>
      {view.columnsBar}
      {toolbar}
      {view.kanban ? (
        view.board(data.tasks, { inboxIds, addLabel })
      ) : (
        <>
          <QuickAdd listId={targetInbox?.id} placeholder={addLabel} />
          {tasks.length ? (
            <ColumnsScroll columns={view.cols.columns}>
              {view.columnsHeader}
              <ul className="divide-y divide-[var(--line)]">
                <Paged items={tasks}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} listName={all ? workspaceName.get(t.workspaceId) : undefined} {...view.cols} />}</Paged>
              </ul>
            </ColumnsScroll>
          ) : (
            <Empty>Inbox jest pusty.</Empty>
          )}
        </>
      )}
    </>
  );
}

/** Przycisk „→ Jutro” przy wierszu: przeniesienie z „Cofnij”. */
function useToTomorrow(data: AppData, ctx: ViewContext) {
  const { run } = useTaskActions();
  return (task: ViewTask) => {
    const { ops, undo } = bulkTaskOps([task], data.tasks, { kind: "tomorrow" }, { today: ctx.today, now: new Date(), timeZone: ctx.timeZone });
    void run(ops, { text: `„${task.title}” → ${relativeDay(addDays(ctx.today, 1), ctx.today)}`, undo });
  };
}

/** Przycisk „→ Dziś” w „Zaległych” (`overdueToTodayOps`); `undefined` = nie ma czego przenieść. */
function useToToday(ctx: ViewContext, now: string) {
  const { run } = useTaskActions();
  return (task: ViewTask) => {
    const move = overdueToTodayOps(task, { today: ctx.today, now });
    return move ? () => void run(move.ops, { text: move.text, undo: move.undo }) : undefined;
  };
}

/** Przyciski „+15 min / +30 min / +1 h” przy zaległym zadaniu (`overdueLaterOps`); `undefined` = seria. */
function useLater(ctx: ViewContext, now: string) {
  const { run } = useTaskActions();
  return (task: ViewTask) =>
    task.recurrence
      ? undefined
      : (minutes: number) => {
          const move = overdueLaterOps(task, minutes, { today: ctx.today, now });
          if (move) void run(move.ops, { text: move.text, undo: move.undo });
        };
}

// ── Dziś ─────────────────────────────────────────────────────────────────────────────────────

/** `aside` — „Plan dnia” obok listy (na szerokim ekranie po prawej, na wąskim pod listą); tablica zajmuje całą szerokość, bez planu i „Cyklicznych”. */
export function TodayView({ data, ctx, targetInbox, toolbar, aside }: ViewProps & { aside?: ReactNode }) {
  const smart = useSmartView("today", ctx, targetInbox);
  const { by, dir } = smart.sort;
  // Wybrane sortowanie działa w obrębie sekcji (zaległe / dziś / w toku / ukończone); nawyki bez zmian.
  const view = useMemo(() => {
    const day = selectToday(data.tasks, ctx);
    const sort = (items: ViewTask[]) => [...sortSection(items, by, dir, (t) => t)];
    return { ...day, overdue: sort(day.overdue), today: sort(day.today), ongoing: sort(day.ongoing), done: sort(day.done) };
  }, [data.tasks, ctx, by, dir]);
  // Etap 8: nawyki dnia ze stanem odhaczenia, postępem i passą (kolejność jak w `selectToday`).
  const habits = useMemo(() => habitsForDay(view.habits, data.habitCompletions, ctx.today, ctx.today), [view.habits, data.habitCompletions, ctx.today]);
  const names = listNames(data);
  const now = useLocalMinute(ctx.timeZone);
  const toTomorrow = useToTomorrow(data, ctx);
  const later = useLater(ctx, now);
  const open = view.overdue.length + view.today.length;
  const empty = !open && !view.ongoing.length && !view.habits.length && !view.done.length;
  return (
    <>
      <Header title="Dziś" subtitle={`${capitalized(dayLabel(ctx.today))} · ${plural(open, ["zadanie", "zadania", "zadań"])}`}>
        <TaskExportButton
          title="Dziś"
          data={data}
          ctx={ctx}
          count={open + view.ongoing.length + view.done.length}
          rows={() =>
            (["overdue", "today", "ongoing", "done"] as const).flatMap((key) => view[key].map((task) => ({ task, section: VIEW_SECTION[key] })))
          }
        />
        {smart.switcher}
      </Header>
      {smart.columnsBar}
      {smart.kanban ? (
        <>
          {toolbar}
          {smart.board(data.tasks, { addLabel: "Dodaj zadanie na dziś" })}
        </>
      ) : (
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-8">
        <div className="min-w-0">
          {toolbar}
          <QuickAdd listId={targetInbox?.id} dueDate={ctx.today} placeholder="Dodaj zadanie na dziś" />
          <ColumnsScroll columns={smart.cols.columns}>
          {open || view.ongoing.length || view.done.length ? smart.columnsHeader : null}
          {view.overdue.length ? (
            <Section title={VIEW_SECTION.overdue} count={view.overdue.length} tone="danger">
              <Paged items={view.overdue}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} onLater={later(t)} onTomorrow={() => toTomorrow(t)} {...smart.cols} />}</Paged>
            </Section>
          ) : null}
          {view.today.length ? (
            <Section title={VIEW_SECTION.today} count={view.today.length}>
              <Paged items={view.today}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} lateMin={minutesLate(t, now)} listName={names.get(t.listId)} onLater={minutesLate(t, now) > 0 ? later(t) : undefined} onTomorrow={() => toTomorrow(t)} {...smart.cols} />}</Paged>
            </Section>
          ) : null}
          {view.ongoing.length ? (
            <Section title={VIEW_SECTION.ongoing} count={view.ongoing.length}>
              <Paged items={view.ongoing}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} {...smart.cols} />}</Paged>
            </Section>
          ) : null}
          {habits.length ? (
            <Section title={VIEW_SECTION.habits} count={habits.filter((h) => !h.settled).length || undefined}>
              {habits.map((item) => (
                <HabitTodayItem key={item.task.id} item={item} />
              ))}
            </Section>
          ) : null}
          {view.done.length ? (
            <Section title={VIEW_SECTION.done} count={view.done.length}>
              <Paged items={view.done}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} listName={names.get(t.listId)} {...smart.cols} />}</Paged>
            </Section>
          ) : null}
          </ColumnsScroll>
          {empty ? <Empty>Na dziś nic nie ma.</Empty> : null}
        </div>
        {aside}
      </div>
      )}
    </>
  );
}

// ── Zaległe ──────────────────────────────────────────────────────────────────────────────────

/** Wszystko po terminie: dzisiejsze po godzinie (na górze — nie giną pod długą listą) i z wcześniejszych dni. */
export function OverdueView({ data, ctx, targetInbox, toolbar }: ViewProps) {
  const now = useLocalMinute(ctx.timeZone);
  const smart = useSmartView("overdue", ctx, targetInbox);
  const { by, dir } = smart.sort;
  // Wybrane sortowanie działa w obrębie sekcji („dziś po godzinie” / „wcześniej”).
  const view = useMemo(() => {
    const overdue = selectOverdue(data.tasks, ctx, now);
    return { today: sortSection(overdue.today, by, dir, (t) => t), earlier: sortSection(overdue.earlier, by, dir, (t) => t) };
  }, [data.tasks, ctx, now, by, dir]);
  const names = listNames(data);
  const toTomorrow = useToTomorrow(data, ctx);
  const toToday = useToToday(ctx, now);
  const later = useLater(ctx, now);
  const count = view.today.length + view.earlier.length;
  return (
    <>
      <Header title={VIEW_SECTION.overdue} subtitle={plural(count, ["zadanie", "zadania", "zadań"])}>
        <TaskExportButton
          title={VIEW_SECTION.overdue}
          data={data}
          ctx={ctx}
          count={count}
          rows={() => [...view.today.map((task) => ({ task, section: VIEW_SECTION.lateToday })), ...view.earlier.map((task) => ({ task, section: VIEW_SECTION.earlier }))]}
        />
        {smart.switcher}
      </Header>
      {smart.columnsBar}
      {toolbar}
      {smart.kanban ? (
        smart.board(data.tasks, { now })
      ) : (
      <ColumnsScroll columns={smart.cols.columns}>
      {count ? smart.columnsHeader : null}
      {view.today.length ? (
        <Section title={VIEW_SECTION.lateToday} count={view.today.length} tone="danger">
          <Paged items={view.today}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} lateMin={minutesLate(t, now)} listName={names.get(t.listId)} onLater={later(t)} onToday={toToday(t)} onTomorrow={() => toTomorrow(t)} {...smart.cols} />}</Paged>
        </Section>
      ) : null}
      {view.earlier.length ? (
        <Section title={VIEW_SECTION.earlier} count={view.earlier.length} tone="danger">
          <Paged items={view.earlier}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} onLater={later(t)} onToday={toToday(t)} onTomorrow={() => toTomorrow(t)} {...smart.cols} />}</Paged>
        </Section>
      ) : null}
      {count ? null : <Empty>Nic nie zalega.</Empty>}
      </ColumnsScroll>
      )}
    </>
  );
}

// ── Nadchodzące ──────────────────────────────────────────────────────────────────────────────

export function UpcomingView({ data, ctx, targetInbox, toolbar }: ViewProps) {
  const smart = useSmartView("upcoming", ctx, targetInbox);
  const { by, dir } = smart.sort;
  // Wybrane sortowanie działa w obrębie dnia / tygodnia; dni zostają po kolei.
  const view = useMemo(() => {
    const upcoming = selectUpcoming(data.tasks, ctx);
    const sort = <T extends { task: ViewTask }>(items: T[]) => [...sortSection(items, by, dir, (i) => i.task)];
    return { days: upcoming.days.map((d) => ({ ...d, items: sort(d.items) })), later: upcoming.later.map((w) => ({ ...w, items: sort(w.items) })) };
  }, [data.tasks, ctx, by, dir]);
  const names = listNames(data);
  return (
    <>
      <Header title="Nadchodzące" subtitle="14 dni, dalej tygodniami">
        <TaskExportButton
          title="Nadchodzące"
          data={data}
          ctx={ctx}
          count={view.days.reduce((n, d) => n + d.items.length, 0) + view.later.reduce((n, w) => n + w.items.length, 0)}
          rows={() => [
            ...view.days.flatMap(({ date, items }) => items.map((item) => ({ task: item.task, section: capitalized(dayLabel(date)), date: item.virtual ? item.date : undefined }))),
            ...view.later.flatMap(({ weekStart, items }) => items.map((item) => ({ task: item.task, section: `Tydzień od ${dayMonth(weekStart)}` }))),
          ]}
        />
        {smart.switcher}
      </Header>
      {smart.columnsBar}
      {toolbar}
      {smart.kanban ? (
        smart.board(data.tasks, { addLabel: "Dodaj zadanie na dziś" })
      ) : (
      <ColumnsScroll columns={smart.cols.columns}>
      {smart.columnsHeader}
      <DayDnd>
        {view.days.map(({ date, items }) => (
          <DayDrop key={date} date={date}>
            {(over) => (
              <Section title={`${capitalized(relativeDay(date, ctx.today))}${date === ctx.today || date === addDays(ctx.today, 1) ? ` · ${dayLabel(date)}` : ""}`} count={items.length || undefined} highlight={over}>
                <Paged items={items}>
                  {(item) =>
                    item.virtual ? (
                      <TaskItem key={`${item.task.id}:${item.date}`} task={item.task} today={ctx.today} showDate={false} listName={names.get(item.task.listId)} virtualDate={item.date} {...smart.cols} />
                    ) : (
                      <DraggableTaskItem key={`${item.task.id}:${item.date}`} dragKey={`${item.task.id}:${item.date}`} task={item.task} today={ctx.today} showDate={false} listName={names.get(item.task.listId)} {...smart.cols} />
                    )
                  }
                </Paged>
                {targetInbox ? <AddInline date={date} listId={targetInbox.id} /> : null}
              </Section>
            )}
          </DayDrop>
        ))}
      </DayDnd>
      {view.later.length ? (
        <>
          <h2 className="mt-6 text-sm font-semibold">{VIEW_SECTION.later}</h2>
          {view.later.map(({ weekStart, items }) => (
            <Section key={weekStart} title={`Tydzień od ${relativeDay(weekStart, ctx.today)}`} count={items.length}>
              <Paged items={items}>{(item) => <TaskItem key={item.task.id} task={item.task} today={ctx.today} listName={names.get(item.task.listId)} {...smart.cols} />}</Paged>
            </Section>
          ))}
        </>
      ) : null}
      </ColumnsScroll>
      )}
    </>
  );
}

// ── Bez terminu ──────────────────────────────────────────────────────────────────────────────

/** Otwarte zadania bez terminu (`selectUndated`) w sekcjach list — do przejrzenia i zaplanowania („→ Dziś” / „→ Jutro”). */
export function UndatedView({ data, ctx, targetInbox, toolbar }: ViewProps) {
  const smart = useSmartView("undated", ctx, targetInbox);
  const { by, dir } = smart.sort;
  // Wybrane sortowanie działa w obrębie sekcji listy.
  const sections = useMemo(
    () => undatedSections(sortSection(selectUndated(data.tasks, ctx), by, dir, (t) => t), { lists: data.lists, workspaces: data.workspaces }),
    [data.tasks, data.lists, data.workspaces, ctx, by, dir],
  );
  const { run } = useTaskActions();
  const move = (task: ViewTask, kind: "today" | "tomorrow") => {
    const { ops, undo } = bulkTaskOps([task], data.tasks, { kind }, { today: ctx.today, now: new Date(), timeZone: ctx.timeZone });
    void run(ops, { text: `„${task.title}” → ${relativeDay(kind === "today" ? ctx.today : addDays(ctx.today, 1), ctx.today)}`, undo });
  };
  const count = sections.reduce((n, s) => n + s.tasks.length, 0);
  return (
    <>
      <Header title={VIEW_SECTION.noDate} subtitle={`${plural(count, ["zadanie", "zadania", "zadań"])} do zaplanowania`}>
        <TaskExportButton title={VIEW_SECTION.noDate} data={data} ctx={ctx} count={count} rows={() => sections.flatMap((s) => s.tasks.map((task) => ({ task, section: s.title })))} />
        {smart.switcher}
      </Header>
      {smart.columnsBar}
      {toolbar}
      {smart.kanban ? (
        smart.board(data.tasks, { addLabel: "Dodaj zadanie bez terminu" })
      ) : (
        <>
          <QuickAdd listId={targetInbox?.id} placeholder="Dodaj zadanie bez terminu" />
          <ColumnsScroll columns={smart.cols.columns}>
            {count ? smart.columnsHeader : null}
            {sections.map((s) => (
              <Section key={s.key} title={s.title} count={s.tasks.length}>
                <Paged items={s.tasks}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} onToday={() => move(t, "today")} onTomorrow={() => move(t, "tomorrow")} {...smart.cols} />}</Paged>
              </Section>
            ))}
            {count ? null : <Empty>Wszystko ma termin.</Empty>}
          </ColumnsScroll>
        </>
      )}
    </>
  );
}

/** Dodanie na konkretny dzień: link „+ Dodaj” rozwijany do pola. */
function AddInline({ date, listId }: { date: LocalDate; listId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <li className="py-1">
        <button type="button" className="text-xs text-[var(--muted)] hover:text-[var(--accent)]" onClick={() => setOpen(true)} aria-label={`Dodaj zadanie na ${dayLabel(date)}`}>
          + Dodaj
        </button>
      </li>
    );
  }
  return (
    <li>
      <QuickAdd listId={listId} dueDate={date} placeholder={`Dodaj na ${dayLabel(date)}`} autoFocus onCancel={() => setOpen(false)} />
    </li>
  );
}

// ── Lista / projekt ──────────────────────────────────────────────────────────────────────────

/** Kolumny po włączeniu / wyłączeniu jednej (kolejność stała). */
const toggleColumn = (current: readonly ListColumn[] | undefined, column: ListColumn, on: boolean): ListColumn[] =>
  orderedColumns(on ? [...(current ?? []), column] : (current ?? []).filter((c) => c !== column));

/** Lista id po dodaniu / zdjęciu jednego (bez powtórzeń). */
const toggleId = (current: readonly string[] | undefined, id: string, on: boolean): string[] => {
  const rest = (current ?? []).filter((v) => v !== id);
  return on ? [...rest, id] : rest;
};

/** Puste listy nie są zapisywane w `view_prefs`. */
const orNone = <T,>(values: T[]): T[] | undefined => (values.length ? values : undefined);

/**
 * „Kolumny”: dodatkowe kolumny listy (początek, koniec, czas, opis, załączniki, tagi — `view_prefs.columns`);
 * przy „Tagi” wybór tagów pokazywanych w kolumnie (`view_prefs.columnTags`, żaden = wszystkie).
 */
function ColumnsPicker({
  value,
  onToggle,
  tags,
  tagValue,
  onTagToggle,
}: {
  value: readonly ListColumn[];
  /** Włączenie / wyłączenie jednej kolumny — zapis liczy się z aktualnych ustawień (kilka szybkich kliknięć). */
  onToggle: (column: ListColumn, on: boolean) => void;
  tags: readonly { id: string; name: string }[];
  tagValue: readonly string[];
  onTagToggle: (tagId: string, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDetailsElement>(null);
  useClickOutside(open, () => setOpen(false), root);
  return (
    <details ref={root} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="relative" data-testid="list-columns">
      <summary className="cursor-pointer list-none rounded-md border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--hover)]">
        Kolumny{value.length ? ` (${value.length})` : ""} ▾
      </summary>
      <div className="absolute z-20 mt-1 max-h-96 w-52 overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--background)] p-2 shadow-lg">
        {(Object.keys(LIST_COLUMN) as ListColumn[]).map((c) => (
          <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--hover)]">
            <input type="checkbox" checked={value.includes(c)} onChange={(e) => onToggle(c, e.target.checked)} />
            {LIST_COLUMN[c]}
          </label>
        ))}
        {value.includes("tags") ? (
          <div className="mt-1 border-t border-[var(--line)] pt-1 pl-5" data-testid="column-tags">
            <p className="px-1 py-1 text-xs text-[var(--muted)]">{tagValue.length ? `Tylko wybrane tagi (${tagValue.length})` : "Wszystkie tagi — zaznacz, żeby zawęzić"}</p>
            {tags.length ? (
              tags.map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-[var(--hover)]">
                  <input type="checkbox" checked={tagValue.includes(t.id)} onChange={(e) => onTagToggle(t.id, e.target.checked)} />
                  <span className="truncate">@{t.name}</span>
                </label>
              ))
            ) : (
              <p className="px-1 py-1 text-xs text-[var(--muted)]">Brak tagów w tej przestrzeni.</p>
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}

const collapsedKey = (listId: string) => `tp-collapsed:${listId}`;
function readCollapsed(listId: string): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(collapsedKey(listId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function writeCollapsed(listId: string, ids: ReadonlySet<string>) {
  try {
    if (ids.size) localStorage.setItem(collapsedKey(listId), JSON.stringify([...ids].slice(-500)));
    else localStorage.removeItem(collapsedKey(listId));
  } catch {
    // Bez pamięci przeglądarki — zwinięcie do przeładowania.
  }
}

/** Tryby widoku listy (`view_prefs.view`) w przełączniku nagłówka. */
const VIEW_LABEL = { list: "Lista", kanban: "Tablica", canvas: "Karteczki" } as const;

export function ListView({ data, ctx, list, store, toolbar }: { data: AppData; ctx: ViewContext; list: List; store: TabStore; toolbar?: ReactNode }) {
  const { notify, run } = useTaskActions();
  // Zwinięte podzadania pamiętane per lista w tej przeglądarce — powrót do listy nie rozwija drzewa.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsed(list.id));
  useEffect(() => writeCollapsed(list.id, collapsed), [list.id, collapsed]);
  // „+” przy zadaniu: górne pole dodaje podzadania tego zadania, po dodaniu wraca do zwykłego trybu.
  const [subParent, setSubParent] = useState<{ id: string; title: string } | null>(null);
  const sortBy: SortBy = list.prefs.sortBy ?? "manual";
  const sortDir: SortDir = list.prefs.sortDir ?? "asc";
  const groupBy: GroupBy = list.prefs.groupBy ?? "none";
  const completed: CompletedMode = list.prefs.completed ?? "today";
  const { columns, columnTags } = useColumns(list.prefs, data.tags);
  const [widths, setWidth] = useListWidths(list.id);

  const kanban = list.prefs.view === "kanban";
  const canvas = list.prefs.view === "canvas";
  const tasks = useMemo(() => withCompleted(data.tasks.filter((t) => t.listId === list.id), completed, ctx), [data.tasks, list.id, completed, ctx]);
  const tree = sortBy === "manual" && groupBy === "none";
  const rows = useMemo(() => {
    if (!tree) return null;
    return flattenTree(buildTree(tasks), collapsed);
  }, [tree, tasks, collapsed]);
  const groups = useMemo(
    () => (tree ? null : groupTasks(sortTasks(tasks, sortBy, sortDir), groupBy, { lists: data.lists, tags: data.tags })),
    [tree, tasks, sortBy, sortDir, groupBy, data.lists, data.tags],
  );
  const openCount = tasks.filter(isOpen).length;

  // Z najnowszych `view_prefs` w bazie, nie z renderu — szybkie kolejne zmiany się nie nadpisują.
  // Lista tylko do podglądu — ustawienia lokalnie w tej karcie (`local-list-prefs.ts`; shell podaje je w `list.prefs`).
  const setPrefs = (patch: Partial<ViewPrefs> | ((current: ViewPrefs) => Partial<ViewPrefs>)) => {
    const fn = typeof patch === "function" ? patch : () => patch;
    if (!listEditable(data, list.id)) return setLocalListPrefs(list.id, list.prefs, fn);
    void updateListPrefs(store, list.id, fn).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
  };
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const editable = listEditable(data, list.id);
  const addSubtask = (task: { id: string; title: string }) => {
    setSubParent({ id: task.id, title: task.title });
    setCollapsed((current) => {
      if (!current.has(task.id)) return current;
      const next = new Set(current);
      next.delete(task.id);
      return next;
    });
    document.querySelector("[data-list-quick-add]")?.scrollIntoView({ block: "nearest" });
  };
  const subtaskAction = (task: { id: string; title: string; kind: string }) =>
    editable && task.kind === "task" && canAddSubtask(data.tasks, task.id) ? () => addSubtask(task) : undefined;

  const listBody = (
      <>
      {editable ? (
        <div data-list-quick-add>
          {subParent ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-[var(--muted)]" data-testid="subtask-context">
              <span className="truncate">
                ↳ Podzadanie do <strong className="font-medium text-[var(--foreground)]">„{subParent.title}”</strong>
              </span>
              <button type="button" className="shrink-0 rounded px-1 hover:bg-[var(--hover)]" onClick={() => setSubParent(null)} aria-label="Wróć do dodawania zadań na liście" title="Esc — wróć do dodawania na listę">
                ✕
              </button>
            </p>
          ) : null}
          <QuickAdd
            key={subParent?.id ?? "list"}
            listId={list.id}
            parent={subParent ? { id: subParent.id, listId: list.id } : undefined}
            placeholder={subParent ? `Dodaj podzadanie do „${subParent.title}”` : `Dodaj do „${list.name}”`}
            autoFocus={!!subParent}
            onAdded={subParent ? (more) => !more && setSubParent(null) : undefined}
            onCancel={subParent ? () => setSubParent(null) : undefined}
          />
        </div>
      ) : (
        <p className="text-xs text-[var(--muted)]" data-testid="list-read-only">{READONLY_LIST_NOTE}</p>
      )}
      <ColumnsScroll columns={columns}>
      {!tasks.length ? (
        <Empty>Brak zadań.</Empty>
      ) : (
        <TaskColumnsHeader columns={columns} widths={widths} onResize={setWidth} sort={{ by: sortBy, dir: sortDir }} onSort={(by) => setPrefs((p) => headerSortPatch(p, by))} />
      )}
      {rows ? (
        <SortableTaskList ids={rows.map((n) => n.task.id)}>
          {rows.map((node) => (
            <SortableTaskItem
              key={node.task.id}
              task={node.task}
              today={ctx.today}
              depth={node.depth}
              progress={node.children.length ? progress(node) : undefined}
              collapsed={node.children.length ? collapsed.has(node.task.id) : undefined}
              onCollapse={() => toggle(node.task.id)}
              columns={columns}
              columnTags={columnTags}
              widths={widths}
              onAddSubtask={subtaskAction(node.task)}
            />
          ))}
        </SortableTaskList>
      ) : (
        groups?.map((group) =>
          group.label ? (
            <Section key={group.key} title={group.label} count={group.tasks.length}>
              {group.tasks.map((t) => (
                <TaskItem key={t.id} task={t} today={ctx.today} columns={columns} columnTags={columnTags} widths={widths} onAddSubtask={subtaskAction(t)} />
              ))}
            </Section>
          ) : (
            <ul key={group.key} className="divide-y divide-[var(--line)]">
              {group.tasks.map((t) => (
                <TaskItem key={t.id} task={t} today={ctx.today} columns={columns} columnTags={columnTags} widths={widths} onAddSubtask={subtaskAction(t)} />
              ))}
            </ul>
          ),
        )
      )}
      </ColumnsScroll>
    </>
  );

  return (
    <>
      <Header
        title={list.name}
        subtitle={`${LIST_KIND[list.kind]} · ${plural(openCount, ["otwarte", "otwarte", "otwartych"])}`}
        badge={(() => {
          const ws = data.workspaces.find((w) => w.id === list.workspaceId);
          return listShareBadge(ws?.role, list.guestAccess, ws?.members);
        })()}
      >
        {list.kind === "project" ? (
          <ProjectStatusSelect
            name={list.name}
            value={list.projectStatus}
            onChange={
              editable
                ? (status) =>
                    void run([{ table: "lists", id: list.id, patch: { project_status: status } }], {
                      text: `„${list.name}” — ${PROJECT_STATUS[status].toLowerCase()}`,
                      undo: [{ table: "lists", id: list.id, patch: { project_status: list.projectStatus } }],
                    })
                : undefined
            }
          />
        ) : null}
        {list.kind === "project" ? <SaveTemplateButton listId={list.id} listName={list.name} /> : null}
        <TaskExportButton
          title={list.name}
          data={data}
          ctx={ctx}
          count={tasks.length}
          rows={() =>
            !kanban && groups
              ? groups.flatMap((g) => g.tasks.map((task) => ({ task, section: g.label || undefined })))
              : flattenTree(buildTree(tasks)).map((n) => ({ task: n.task, depth: n.depth }))
          }
        />
        <ViewSwitch views={["list", "kanban", "canvas"]} value={canvas ? "canvas" : kanban ? "kanban" : "list"} onChange={(view) => setPrefs({ view })} />
      </Header>
      {/* Sortowanie / grupowanie listy — pod nagłówkiem, przyciski widoku zostają w rogu. */}
      {kanban ? null : canvas ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <Select aria-label="Ukończone" value={completed} onChange={(e) => setPrefs({ completed: e.target.value as CompletedMode })} className="py-1 text-xs">
            {(Object.keys(COMPLETED_MODE) as CompletedMode[]).map((k) => (
              <option key={k} value={k}>
                {COMPLETED_MODE[k]}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="mb-2 flex flex-wrap gap-2">
          <SortControls
            by={sortBy}
            dir={sortDir}
            labels={SORT_BY}
            onBy={(by) => setPrefs({ sortBy: by, sortDir: undefined })}
            onDir={() => setPrefs((p) => ({ sortDir: p.sortDir === "desc" ? undefined : "desc" }))}
          />
          <Select aria-label="Grupowanie" value={groupBy} onChange={(e) => setPrefs({ groupBy: e.target.value as GroupBy })} className="py-1 text-xs">
            {(Object.keys(GROUP_BY) as GroupBy[]).map((k) => (
              <option key={k} value={k}>
                {GROUP_BY[k]}
              </option>
            ))}
          </Select>
          <Select aria-label="Ukończone" value={completed} onChange={(e) => setPrefs({ completed: e.target.value as CompletedMode })} className="py-1 text-xs">
            {(Object.keys(COMPLETED_MODE) as CompletedMode[]).map((k) => (
              <option key={k} value={k}>
                {COMPLETED_MODE[k]}
              </option>
            ))}
          </Select>
          <ColumnsPicker
            value={columns}
            onToggle={(column, on) => setPrefs((p) => ({ columns: orNone(toggleColumn(p.columns, column, on)) }))}
            tags={tagsForWorkspace(data.tags, list.workspaceId, list.prefs.columnTags)}
            tagValue={columnTags ? [...columnTags] : []}
            onTagToggle={(tagId, on) => setPrefs((p) => ({ columnTags: orNone(toggleId(p.columnTags, tagId, on)) }))}
          />
        </div>
      )}
      {toolbar}
      {canvas ? (
        <CanvasView key={list.id} data={data} ctx={ctx} list={list} />
      ) : kanban ? (
        <Board data={data} ctx={ctx} tasks={data.tasks.filter((t) => t.listId === list.id)} by={list.prefs.boardBy ?? "status"} onBy={(boardBy) => setPrefs({ boardBy })} sort={{ by: sortBy, dir: sortDir, labels: SORT_BY, onChange: (patch) => setPrefs(patch) }} listId={list.id} showList={false} addLabel={`Dodaj do „${list.name}”`} />
      ) : (
        listBody
      )}
    </>
  );
}

// ── Kosz ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Kosz (M3): usunięte w ostatnich 30 dniach, przywracanie razem z podzadaniami usuniętymi naraz; kliknięcie
 * otwiera szczegóły w panelu tylko do odczytu (`TaskPanel`).
 */
export function TrashView({ data, store, today }: { data: AppData; store: TabStore; today: LocalDate }) {
  const { run } = useTaskActions();
  const { openTask, openTaskId } = useAppEnv();
  const { tasks: trashed, alive } = useTrash(store, data);
  const roots = trashRoots(trashed);
  const [filter, setFilter] = useState<FilterQuery>({});
  const filtered = !isEmptyFilter(filter);
  const shown = filtered ? roots.filter(matchesFilter(filter, today)) : roots;
  const names = listNames(data);
  const open = openTaskId ? trashPreview(trashed, openTaskId, alive)?.root.id : undefined;

  return (
    <>
      <Header title="Kosz" subtitle={`Usunięte zadania zostają tu ${TRASH_DAYS} dni, potem znikają na stałe. Kliknij zadanie, aby zobaczyć szczegóły.`} />
      <FilterBar query={filter} onChange={setFilter} />
      {shown.length ? (
        <ul className="divide-y divide-[var(--line)]" aria-label="Zadania w koszu">
          {shown.map((t) => {
            const inside = trashedWith(trashed, t.id).length;
            return (
              // `data-card`: kliknięcie w wiersz nie zamyka panelu (jak karty tablicy).
              <li key={t.id} data-card={t.id} className={`flex items-center gap-3 text-sm ${open === t.id ? "bg-[var(--hover)] shadow-[inset_3px_0_0_var(--accent)]" : ""}`}>
                <button type="button" className="min-w-0 flex-1 cursor-pointer py-2 pl-2 text-left hover:text-[var(--accent)]" title="Pokaż szczegóły" aria-current={open === t.id || undefined} onClick={() => openTask(t.id)}>
                  <span className="block break-words">{t.title}</span>
                  <span className="block text-xs text-[var(--muted)]">
                    {trashListLabel(t, names.get(t.listId))} · usunięte {new Date(t.deletedAt).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}
                    {inside ? ` · z ${plural(inside, ["podzadaniem", "podzadaniami", "podzadaniami"])}` : ""}
                  </span>
                </button>
                <Button disabled={!listEditable(data, t.listId)} onClick={() => void run(trashPreview(trashed, t.id, alive)?.restore ?? [], { text: `Przywrócono „${t.title}”` })}>
                  Przywróć
                </Button>
                <PurgeButton task={t} inside={inside} />
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>{filtered && roots.length ? "Nic w koszu nie pasuje do filtra." : "Kosz jest pusty."}</Empty>
      )}
    </>
  );
}
