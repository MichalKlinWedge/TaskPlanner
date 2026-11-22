"use client";

/**
 * Widoki list (M9): Inbox, Dziś, Nadchodzące, lista/projekt. Wybór i kolejność zadań liczy
 * `@taskplanner/core` (`selectInbox`, `selectToday`, `selectUpcoming`, `buildTree`, `groupTasks`…);
 * tu jest tylko układ.
 */
import {
  addDays,
  buildTree,
  descendants,
  capitalized,
  COMPLETED_MODE,
  dayLabel,
  dayMonth,
  flattenTree,
  GROUP_BY,
  groupTasks,
  habitsForDay,
  isOpen,
  LIST_COLUMN,
  LIST_KIND,
  orderedColumns,
  plural,
  progress,
  relativeDay,
  restoreTaskOps,
  selectInbox,
  selectToday,
  selectUpcoming,
  SORT_BY,
  sortTasks,
  TRASH_DAYS,
  VIEW_SECTION,
  withCompleted,
  type CompletedMode,
  type GroupBy,
  type ListColumn,
  type LocalDate,
  type SortBy,
  type ViewContext,
  type ViewPrefs,
  READONLY_LIST_NOTE,
  listShareBadge,
  type ListShareBadge,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo, useState, type ReactNode } from "react";

import { listEditable, type AppData, type List } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";

import { Board } from "./board";
import { DayDnd, DayDrop, DraggableTaskItem, SortableTaskItem, SortableTaskList } from "./dnd";
import { TaskExportButton } from "./export";
import { HabitTodayItem } from "./habits";
import { QuickAdd } from "./quick-add";
import { TaskColumnsHeader, TaskItem, useTaskActions } from "./task-item";
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

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-[var(--muted)]">{children}</p>;
}

const listNames = (data: AppData) => new Map(data.lists.map((l) => [l.id, l.name]));

// ── Inbox ────────────────────────────────────────────────────────────────────────────────────

export function InboxView({ data, ctx, targetInbox, toolbar }: ViewProps) {
  const inboxIds = useMemo(() => new Set(data.lists.filter((l) => l.kind === "inbox").map((l) => l.id)), [data.lists]);
  const tasks = useMemo(() => selectInbox(data.tasks, inboxIds, ctx), [data.tasks, inboxIds, ctx]);
  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const all = !ctx.workspaceId;
  return (
    <>
      <Header title="Inbox" subtitle={plural(tasks.length, ["zadanie", "zadania", "zadań"])}>
        <TaskExportButton title="Inbox" data={data} ctx={ctx} count={tasks.length} rows={() => tasks.map((task) => ({ task }))} />
      </Header>
      {toolbar}
      <QuickAdd listId={targetInbox?.id} placeholder={targetInbox && all ? `Dodaj do Inboxu („${workspaceName.get(targetInbox.workspaceId)}”)` : "Dodaj do Inboxu"} />
      {tasks.length ? (
        <ul className="divide-y divide-[var(--line)]">
          <Paged items={tasks}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} listName={all ? workspaceName.get(t.workspaceId) : undefined} />}</Paged>
        </ul>
      ) : (
        <Empty>Inbox jest pusty.</Empty>
      )}
    </>
  );
}

// ── Dziś ─────────────────────────────────────────────────────────────────────────────────────

/** `aside` — „Plan dnia” obok listy (na szerokim ekranie po prawej, na wąskim pod listą). */
export function TodayView({ data, ctx, targetInbox, toolbar, aside }: ViewProps & { aside?: ReactNode }) {
  const view = useMemo(() => selectToday(data.tasks, ctx), [data.tasks, ctx]);
  // Etap 8: nawyki dnia ze stanem odhaczenia, postępem i passą (kolejność jak w `selectToday`).
  const habits = useMemo(() => habitsForDay(view.habits, data.habitCompletions, ctx.today, ctx.today), [view.habits, data.habitCompletions, ctx.today]);
  const names = listNames(data);
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
      </Header>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-8">
        <div className="min-w-0">
          {toolbar}
          <QuickAdd listId={targetInbox?.id} dueDate={ctx.today} placeholder="Dodaj zadanie na dziś" />
          {view.overdue.length ? (
            <Section title={VIEW_SECTION.overdue} count={view.overdue.length} tone="danger">
              <Paged items={view.overdue}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} />}</Paged>
            </Section>
          ) : null}
          {view.today.length ? (
            <Section title={VIEW_SECTION.today} count={view.today.length}>
              <Paged items={view.today}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} listName={names.get(t.listId)} />}</Paged>
            </Section>
          ) : null}
          {view.ongoing.length ? (
            <Section title={VIEW_SECTION.ongoing} count={view.ongoing.length}>
              <Paged items={view.ongoing}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} />}</Paged>
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
              <Paged items={view.done}>{(t) => <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} listName={names.get(t.listId)} />}</Paged>
            </Section>
          ) : null}
          {empty ? <Empty>Na dziś nic nie ma.</Empty> : null}
        </div>
        {aside}
      </div>
    </>
  );
}

// ── Nadchodzące ──────────────────────────────────────────────────────────────────────────────

export function UpcomingView({ data, ctx, targetInbox, toolbar }: ViewProps) {
  const view = useMemo(() => selectUpcoming(data.tasks, ctx), [data.tasks, ctx]);
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
      </Header>
      {toolbar}
      <DayDnd>
        {view.days.map(({ date, items }) => (
          <DayDrop key={date} date={date}>
            {(over) => (
              <Section title={`${capitalized(relativeDay(date, ctx.today))}${date === ctx.today || date === addDays(ctx.today, 1) ? ` · ${dayLabel(date)}` : ""}`} count={items.length || undefined} highlight={over}>
                <Paged items={items}>
                  {(item) =>
                    item.virtual ? (
                      <TaskItem key={`${item.task.id}:${item.date}`} task={item.task} today={ctx.today} showDate={false} listName={names.get(item.task.listId)} virtualDate={item.date} />
                    ) : (
                      <DraggableTaskItem key={`${item.task.id}:${item.date}`} dragKey={`${item.task.id}:${item.date}`} task={item.task} today={ctx.today} showDate={false} listName={names.get(item.task.listId)} />
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
              <Paged items={items}>{(item) => <TaskItem key={item.task.id} task={item.task} today={ctx.today} listName={names.get(item.task.listId)} />}</Paged>
            </Section>
          ))}
        </>
      ) : null}
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

/** „Kolumny”: dodatkowe kolumny listy (odpowiedzialny, początek, koniec) zapisywane w `view_prefs.columns`. */
function ColumnsPicker({ value, onChange }: { value: readonly ListColumn[]; onChange: (next: ListColumn[]) => void }) {
  return (
    <details className="relative" data-testid="list-columns">
      <summary className="cursor-pointer list-none rounded-md border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--hover)]">
        Kolumny{value.length ? ` (${value.length})` : ""} ▾
      </summary>
      <div className="absolute z-20 mt-1 w-44 rounded-md border border-[var(--line)] bg-[var(--background)] p-2 shadow-lg">
        {(Object.keys(LIST_COLUMN) as ListColumn[]).map((c) => (
          <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--hover)]">
            <input type="checkbox" checked={value.includes(c)} onChange={(e) => onChange(orderedColumns(e.target.checked ? [...value, c] : value.filter((v) => v !== c)))} />
            {LIST_COLUMN[c]}
          </label>
        ))}
      </div>
    </details>
  );
}

export function ListView({ data, ctx, list, store, toolbar }: { data: AppData; ctx: ViewContext; list: List; store: TabStore; toolbar?: ReactNode }) {
  const { notify } = useTaskActions();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const sortBy: SortBy = list.prefs.sortBy ?? "manual";
  const groupBy: GroupBy = list.prefs.groupBy ?? "none";
  const completed: CompletedMode = list.prefs.completed ?? "today";
  const columns = orderedColumns(list.prefs.columns);

  const kanban = list.prefs.view === "kanban";
  const tasks = useMemo(() => withCompleted(data.tasks.filter((t) => t.listId === list.id), completed, ctx), [data.tasks, list.id, completed, ctx]);
  const tree = sortBy === "manual" && groupBy === "none";
  const rows = useMemo(() => {
    if (!tree) return null;
    return flattenTree(buildTree(tasks), collapsed);
  }, [tree, tasks, collapsed]);
  const groups = useMemo(() => (tree ? null : groupTasks(sortTasks(tasks, sortBy), groupBy, { lists: data.lists, tags: data.tags })), [tree, tasks, sortBy, groupBy, data.lists, data.tags]);
  const openCount = tasks.filter(isOpen).length;

  const setPrefs = (patch: Partial<ViewPrefs>) => void store.mutate("lists", list.id, { view_prefs: { ...list.prefs, ...patch } }).catch((e: unknown) => notify(String(e)));
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const listBody = (
      <>
      {listEditable(data, list.id) ? <QuickAdd listId={list.id} placeholder={`Dodaj do „${list.name}”`} /> : <p className="text-xs text-[var(--muted)]" data-testid="list-read-only">{READONLY_LIST_NOTE}</p>}
      {!tasks.length ? <Empty>Brak zadań.</Empty> : <TaskColumnsHeader columns={columns} />}
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
            />
          ))}
        </SortableTaskList>
      ) : (
        groups?.map((group) =>
          group.label ? (
            <Section key={group.key} title={group.label} count={group.tasks.length}>
              {group.tasks.map((t) => (
                <TaskItem key={t.id} task={t} today={ctx.today} columns={columns} />
              ))}
            </Section>
          ) : (
            <ul key={group.key} className="divide-y divide-[var(--line)]">
              {group.tasks.map((t) => (
                <TaskItem key={t.id} task={t} today={ctx.today} columns={columns} />
              ))}
            </ul>
          ),
        )
      )}
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
        <div className="flex overflow-hidden rounded-md border border-[var(--line)] text-xs" role="radiogroup" aria-label="Widok">
          {(["list", "kanban"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={(list.prefs.view ?? "list") === v} onClick={() => setPrefs({ view: v })} className={`px-2.5 py-1 ${(list.prefs.view ?? "list") === v ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--hover)]"}`}>
              {v === "list" ? "Lista" : "Tablica"}
            </button>
          ))}
        </div>
      </Header>
      {/* Sortowanie / grupowanie listy — pod nagłówkiem, przyciski widoku zostają w rogu. */}
      {kanban ? null : (
        <div className="mb-2 flex flex-wrap gap-2">
          <Select aria-label="Sortowanie" value={sortBy} onChange={(e) => setPrefs({ sortBy: e.target.value as SortBy })} className="py-1 text-xs">
            {(Object.keys(SORT_BY) as SortBy[]).map((k) => (
              <option key={k} value={k}>
                {SORT_BY[k]}
              </option>
            ))}
          </Select>
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
            onChange={(next) => {
              const prefs = { ...list.prefs };
              delete prefs.columns;
              if (next.length) prefs.columns = next;
              void store.mutate("lists", list.id, { view_prefs: prefs }).catch((e: unknown) => notify(String(e)));
            }}
          />
        </div>
      )}
      {toolbar}
      {kanban ? (
        <Board data={data} ctx={ctx} tasks={data.tasks.filter((t) => t.listId === list.id)} by={list.prefs.boardBy ?? "status"} onBy={(boardBy) => setPrefs({ boardBy })} listId={list.id} showList={false} addLabel={`Dodaj do „${list.name}”`} />
      ) : (
        listBody
      )}
    </>
  );
}

// ── Kosz ─────────────────────────────────────────────────────────────────────────────────────

/** Kosz (M3): usunięte w ostatnich 30 dniach, przywracanie razem z podzadaniami usuniętymi naraz. */
export function TrashView({ data, store }: { data: AppData; store: TabStore }) {
  const { run } = useTaskActions();
  // Granica liczona przy wejściu do widoku (stabilna wartość parametru zapytania).
  const [since] = useState(() => new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString());
  const { rows } = useLocalQuery<Record<string, string | number | null>>(
    store,
    "select id, parent_id, list_id, title, deleted_at from tasks where deleted_at is not null and deleted_at > ? order by deleted_at desc",
    [since],
    ["tasks"],
  );
  const trashed = rows.map((r) => ({ id: String(r.id), parentId: r.parent_id as string | null, listId: String(r.list_id), title: String(r.title), deletedAt: r.deleted_at as string }));
  const byId = new Map(trashed.map((t) => [t.id, t]));
  // Podzadania usunięte razem z rodzicem są pod nim (przywracają się z nim), nie osobno.
  const roots = trashed.filter((t) => !(t.parentId && byId.get(t.parentId)?.deletedAt === t.deletedAt));
  const alive = new Set(data.tasks.map((t) => t.id));
  const names = listNames(data);

  return (
    <>
      <Header title="Kosz" subtitle={`Usunięte zadania zostają tu ${TRASH_DAYS} dni, potem znikają na stałe.`} />
      {roots.length ? (
        <ul className="divide-y divide-[var(--line)]">
          {roots.map((t) => {
            const inside = descendants(trashed, t.id).filter((d) => d.deletedAt === t.deletedAt).length;
            return (
              <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="break-words">{t.title}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {names.get(t.listId) ?? "lista zarchiwizowana"} · usunięte {new Date(t.deletedAt).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}
                    {inside ? ` · z ${plural(inside, ["podzadaniem", "podzadaniami", "podzadaniami"])}` : ""}
                  </div>
                </div>
                <Button onClick={() => void run(restoreTaskOps(trashed, t.id, { parentAlive: !t.parentId || alive.has(t.parentId) }), { text: `Przywrócono „${t.title}”` })}>
                  Przywróć
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>Kosz jest pusty.</Empty>
      )}
    </>
  );
}
