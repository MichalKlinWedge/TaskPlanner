"use client";

/**
 * Widoki list (M9): Inbox, Dziś, Nadchodzące, lista/projekt. Wybór i kolejność zadań liczy
 * `@taskplanner/core` (`selectInbox`, `selectToday`, `selectUpcoming`, `buildTree`, `groupTasks`…);
 * tu jest tylko układ.
 */
import {
  addDays,
  buildTree,
  capitalized,
  COMPLETED_MODE,
  dayLabel,
  flattenTree,
  GROUP_BY,
  groupTasks,
  isOpen,
  LIST_KIND,
  plural,
  progress,
  relativeDay,
  selectInbox,
  selectToday,
  selectUpcoming,
  SORT_BY,
  sortTasks,
  VIEW_SECTION,
  withCompleted,
  type CompletedMode,
  type GroupBy,
  type LocalDate,
  type SortBy,
  type ViewContext,
  type ViewPrefs,
  type ViewTask,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo, useState, type ReactNode } from "react";

import type { AppData, List } from "@/lib/app-data";

import { AddTask, TaskItem, useTaskActions } from "./task-item";
import { Select } from "./ui";

export interface ViewProps {
  data: AppData;
  ctx: ViewContext;
  /** Inbox, do którego trafiają nowe zadania z widoków zbiorczych. */
  targetInbox: List | undefined;
}

const lastKey = (tasks: readonly ViewTask[], listId: string): string | undefined =>
  tasks.reduce<string | undefined>((max, t) => (t.listId === listId && t.parentId === null && (!max || t.sortKey > max) ? t.sortKey : max), undefined);

function Header({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle ? <p className="text-sm text-[var(--muted)]">{subtitle}</p> : null}
      </div>
      {children}
    </header>
  );
}

function Section({ title, count, tone, children }: { title: string; count?: number; tone?: "danger"; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h2 className={`flex items-baseline gap-2 border-b border-[var(--line)] pb-1 text-sm font-semibold ${tone === "danger" ? "text-[var(--danger)]" : ""}`}>
        {title}
        {count !== undefined ? <span className="text-xs font-normal text-[var(--muted)]">{count}</span> : null}
      </h2>
      <ul className="divide-y divide-[var(--line)]">{children}</ul>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-[var(--muted)]">{children}</p>;
}

const listNames = (data: AppData) => new Map(data.lists.map((l) => [l.id, l.name]));

// ── Inbox ────────────────────────────────────────────────────────────────────────────────────

export function InboxView({ data, ctx, targetInbox }: ViewProps) {
  const { add } = useTaskActions();
  const inboxIds = useMemo(() => new Set(data.lists.filter((l) => l.kind === "inbox").map((l) => l.id)), [data.lists]);
  const tasks = useMemo(() => selectInbox(data.tasks, inboxIds, ctx), [data.tasks, inboxIds, ctx]);
  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const all = !ctx.workspaceId;
  return (
    <>
      <Header title="Inbox" subtitle={plural(tasks.length, ["zadanie", "zadania", "zadań"])} />
      <AddTask
        placeholder={targetInbox && all ? `Dodaj do Inboxu („${workspaceName.get(targetInbox.workspaceId)}”)` : "Dodaj do Inboxu"}
        disabled={!targetInbox}
        onAdd={(title) => add({ listId: targetInbox!.id, title, after: lastKey(data.tasks, targetInbox!.id) })}
      />
      {tasks.length ? (
        <ul className="divide-y divide-[var(--line)]">
          {tasks.map((t) => (
            <TaskItem key={t.id} task={t} today={ctx.today} listName={all ? workspaceName.get(t.workspaceId) : undefined} />
          ))}
        </ul>
      ) : (
        <Empty>Inbox jest pusty.</Empty>
      )}
    </>
  );
}

// ── Dziś ─────────────────────────────────────────────────────────────────────────────────────

export function TodayView({ data, ctx, targetInbox }: ViewProps) {
  const { add } = useTaskActions();
  const view = useMemo(() => selectToday(data.tasks, ctx), [data.tasks, ctx]);
  const names = listNames(data);
  const open = view.overdue.length + view.today.length;
  const empty = !open && !view.ongoing.length && !view.habits.length && !view.done.length;
  return (
    <>
      <Header title="Dziś" subtitle={`${capitalized(dayLabel(ctx.today))} · ${plural(open, ["zadanie", "zadania", "zadań"])}`} />
      <AddTask
        placeholder="Dodaj zadanie na dziś"
        disabled={!targetInbox}
        onAdd={(title) => add({ listId: targetInbox!.id, title, dueDate: ctx.today, after: lastKey(data.tasks, targetInbox!.id) })}
      />
      {view.overdue.length ? (
        <Section title={VIEW_SECTION.overdue} count={view.overdue.length} tone="danger">
          {view.overdue.map((t) => (
            <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} />
          ))}
        </Section>
      ) : null}
      {view.today.length ? (
        <Section title={VIEW_SECTION.today} count={view.today.length}>
          {view.today.map((t) => (
            <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} listName={names.get(t.listId)} />
          ))}
        </Section>
      ) : null}
      {view.ongoing.length ? (
        <Section title={VIEW_SECTION.ongoing} count={view.ongoing.length}>
          {view.ongoing.map((t) => (
            <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} />
          ))}
        </Section>
      ) : null}
      {view.habits.length ? (
        <Section title={VIEW_SECTION.habits} count={view.habits.length}>
          {view.habits.map((t) => (
            <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} habitDone={data.habitsDoneToday.has(t.id)} />
          ))}
        </Section>
      ) : null}
      {view.done.length ? (
        <Section title={VIEW_SECTION.done} count={view.done.length}>
          {view.done.map((t) => (
            <TaskItem key={t.id} task={t} today={ctx.today} showDate={false} listName={names.get(t.listId)} />
          ))}
        </Section>
      ) : null}
      {empty ? <Empty>Na dziś nic nie ma.</Empty> : null}
    </>
  );
}

// ── Nadchodzące ──────────────────────────────────────────────────────────────────────────────

export function UpcomingView({ data, ctx, targetInbox }: ViewProps) {
  const { add } = useTaskActions();
  const view = useMemo(() => selectUpcoming(data.tasks, ctx), [data.tasks, ctx]);
  const names = listNames(data);
  return (
    <>
      <Header title="Nadchodzące" subtitle="14 dni, dalej tygodniami" />
      {view.days.map(({ date, items }) => (
        <Section key={date} title={`${capitalized(relativeDay(date, ctx.today))}${date === ctx.today || date === addDays(ctx.today, 1) ? ` · ${dayLabel(date)}` : ""}`} count={items.length || undefined}>
          {items.map((item) => (
            <TaskItem key={`${item.task.id}:${item.date}`} task={item.task} today={ctx.today} showDate={false} listName={names.get(item.task.listId)} virtualDate={item.virtual ? item.date : undefined} />
          ))}
          {targetInbox ? <AddInline date={date} onAdd={(title) => add({ listId: targetInbox.id, title, dueDate: date, after: lastKey(data.tasks, targetInbox.id) })} /> : null}
        </Section>
      ))}
      {view.later.length ? (
        <>
          <h2 className="mt-6 text-sm font-semibold">{VIEW_SECTION.later}</h2>
          {view.later.map(({ weekStart, items }) => (
            <Section key={weekStart} title={`Tydzień od ${relativeDay(weekStart, ctx.today)}`} count={items.length}>
              {items.map((item) => (
                <TaskItem key={item.task.id} task={item.task} today={ctx.today} listName={names.get(item.task.listId)} />
              ))}
            </Section>
          ))}
        </>
      ) : null}
    </>
  );
}

/** Dodanie na konkretny dzień: link „+ Dodaj” rozwijany do pola. */
function AddInline({ date, onAdd }: { date: LocalDate; onAdd: (title: string) => Promise<unknown> }) {
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
      <AddTask placeholder={`Dodaj na ${dayLabel(date)}`} onAdd={onAdd} />
    </li>
  );
}

// ── Lista / projekt ──────────────────────────────────────────────────────────────────────────

export function ListView({ data, ctx, list, store }: { data: AppData; ctx: ViewContext; list: List; store: TabStore }) {
  const { add, error } = useTaskActions();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const sortBy: SortBy = list.prefs.sortBy ?? "manual";
  const groupBy: GroupBy = list.prefs.groupBy ?? "none";
  const completed: CompletedMode = list.prefs.completed ?? "today";

  const tasks = useMemo(() => withCompleted(data.tasks.filter((t) => t.listId === list.id), completed, ctx), [data.tasks, list.id, completed, ctx]);
  const tree = sortBy === "manual" && groupBy === "none";
  const rows = useMemo(() => {
    if (!tree) return null;
    return flattenTree(buildTree(tasks), collapsed);
  }, [tree, tasks, collapsed]);
  const groups = useMemo(() => (tree ? null : groupTasks(sortTasks(tasks, sortBy), groupBy, { lists: data.lists, tags: data.tags })), [tree, tasks, sortBy, groupBy, data.lists, data.tags]);
  const openCount = tasks.filter(isOpen).length;

  const setPrefs = (patch: Partial<ViewPrefs>) => void store.mutate("lists", list.id, { view_prefs: { ...list.prefs, ...patch } }).catch((e: unknown) => error(String(e)));
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <Header title={list.name} subtitle={`${LIST_KIND[list.kind]} · ${plural(openCount, ["otwarte", "otwarte", "otwartych"])}`}>
        <div className="flex flex-wrap gap-2">
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
        </div>
      </Header>
      <AddTask placeholder={`Dodaj do „${list.name}”`} onAdd={(title) => add({ listId: list.id, title, after: lastKey(data.tasks, list.id) })} />
      {!tasks.length ? <Empty>Brak zadań.</Empty> : null}
      {rows ? (
        <ul className="divide-y divide-[var(--line)]">
          {rows.map((node) => (
            <TaskItem
              key={node.task.id}
              task={node.task}
              today={ctx.today}
              depth={node.depth}
              progress={node.children.length ? progress(node) : undefined}
              collapsed={node.children.length ? collapsed.has(node.task.id) : undefined}
              onCollapse={() => toggle(node.task.id)}
            />
          ))}
        </ul>
      ) : (
        groups?.map((group) =>
          group.label ? (
            <Section key={group.key} title={group.label} count={group.tasks.length}>
              {group.tasks.map((t) => (
                <TaskItem key={t.id} task={t} today={ctx.today} />
              ))}
            </Section>
          ) : (
            <ul key={group.key} className="divide-y divide-[var(--line)]">
              {group.tasks.map((t) => (
                <TaskItem key={t.id} task={t} today={ctx.today} />
              ))}
            </ul>
          ),
        )
      )}
    </>
  );
}
