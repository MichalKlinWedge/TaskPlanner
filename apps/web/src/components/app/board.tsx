"use client";

/**
 * Tablica kanban (M10) na webie: kolumny z `core/kanban.ts`, przeciąganie kart (dnd-kit) zmienia
 * atrybut kolumny i kolejność (`board_sort_key`), szybkie dodanie na dole kolumny z atrybutem
 * kolumny, zwijanie kolumn. Warunek z PoC-5: kolumna rysuje porcję kart (`PAGE`) — tylko one są
 * sortowalne, reszta po „Pokaż więcej”.
 */
import { closestCorners, DndContext, KeyboardSensor, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BOARD_BY, boardColumns, boardDropOps, describeRecurrence, isOpen, PRIORITY, relativeDay, type BoardBy, type BoardColumn, type LocalDate, type ViewContext, type ViewTask } from "@taskplanner/core";
import { memo, useMemo, useState } from "react";

import type { AppData } from "@/lib/app-data";

import { useAppEnv } from "./app-env";
import { QuickAdd } from "./quick-add";
import { useTaskActions } from "./task-item";
import { Select } from "./ui";

/** Ile kart kolumna rysuje od razu (PoC-5: ~400 sortowalnych kart = 150–184 ms na starcie przeciągania). */
const PAGE = 40;
const cardId = (column: string, task: string) => `card:${column}:${task}`;

/**
 * Cel upuszczenia: pod wskaźnikiem (karta albo kolumna); z klawiatury (bez wskaźnika) — najbliższy.
 * Puszczenie poza kolumnami nic nie zmienia (`closestCorners` sam wybrałby najbliższą kolumnę).
 */
const collision: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCorners(args);
  const hits = pointerWithin(args);
  const cards = hits.filter((h) => String(h.id).startsWith("card:"));
  return cards.length ? closestCorners({ ...args, droppableContainers: args.droppableContainers.filter((c) => cards.some((h) => h.id === c.id)) }) : hits;
};

interface CardData {
  taskId: string;
  column: string;
}

const Card = memo(function Card({ task, column, today, tagNames, listName, progress }: { task: ViewTask; column: string; today: LocalDate; tagNames: string[]; listName?: string; progress?: { done: number; total: number } }) {
  const { openTask, select, selectedIds } = useAppEnv();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cardId(column, task.id), data: { taskId: task.id, column } satisfies CardData });
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;
  const overdue = isOpen(task) && task.dueDate !== null && task.dueDate < today;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, borderLeftColor: color }}
      {...attributes}
      {...listeners}
      data-card={task.id}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) return select(task.id, "toggle");
        select(task.id);
        openTask(task.id);
      }}
      className={`cursor-grab rounded-md border border-l-4 border-[var(--line)] bg-[var(--surface)] px-2.5 py-2 text-sm shadow-sm ${isDragging ? "opacity-40" : ""} ${selectedIds.has(task.id) ? "ring-2 ring-[var(--accent)]" : ""}`}
    >
      <div className={`break-words ${task.status === "done" ? "text-[var(--muted)] line-through" : ""}`}>{task.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--muted)]">
        {task.dueDate ? <span className={overdue ? "font-medium text-[var(--danger)]" : ""}>{relativeDay(task.dueDate, today)}{task.dueTime ? ` ${task.dueTime}` : ""}</span> : null}
        {task.recurrence ? <span title={describeRecurrence(task.recurrence)}>↻</span> : null}
        {progress && progress.total ? <span title="Podzadania">☑ {progress.done}/{progress.total}</span> : null}
        {tagNames.map((n) => (
          <span key={n} className="rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100">
            {n}
          </span>
        ))}
        {listName ? <span className="truncate">{listName}</span> : null}
      </div>
    </li>
  );
});

function Column({
  column,
  by,
  data,
  today,
  listId,
  showList,
}: {
  column: BoardColumn;
  by: BoardBy;
  data: AppData;
  today: LocalDate;
  /** Lista nowych kart (widok listy / domyślny Inbox). */
  listId?: string;
  showList: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.key}`, data: { column: column.key } });
  const [shown, setShown] = useState(PAGE);
  const [collapsed, setCollapsed] = useState(false);
  const visible = column.tasks.slice(0, shown);
  const ids = useMemo(() => visible.map((t) => cardId(column.key, t.id)), [visible, column.key]);
  const tagName = useMemo(() => new Map(data.tags.map((t) => [t.id, t.name])), [data.tags]);
  const listName = useMemo(() => new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? "Inbox" : l.name])), [data.lists]);
  const children = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const t of data.tasks) {
      if (!t.parentId || t.status === "cancelled") continue;
      const p = map.get(t.parentId) ?? { done: 0, total: 0 };
      p.total++;
      if (t.status === "done") p.done++;
      map.set(t.parentId, p);
    }
    return map;
  }, [data.tasks]);

  // Dodanie w kolumnie dostaje jej atrybut (status / priorytet / dzień / tag / lista).
  const add =
    by === "status"
      ? { defaults: { status: column.key } }
      : by === "priority"
        ? { defaults: { priority: Number(column.key) } }
        : by === "weekday"
          ? { dueDate: column.key === "none" ? null : (column.key as LocalDate) }
          : by === "tag" && column.key !== "none"
            ? { defaults: { tagNames: [column.label] } }
            : by === "list"
              ? { listId: column.key }
              : {};

  if (collapsed) {
    return (
      <section className="flex w-10 shrink-0 flex-col items-center rounded-lg bg-black/5 py-2 dark:bg-white/5" data-column={column.key}>
        <button type="button" className="text-xs text-[var(--muted)] [writing-mode:vertical-rl]" onClick={() => setCollapsed(false)} aria-label={`Rozwiń kolumnę ${column.label}`}>
          {column.label} · {column.tasks.length}
        </button>
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-lg p-2 transition-colors ${isOver ? "bg-indigo-50 ring-2 ring-[var(--accent)] dark:bg-indigo-950/40" : "bg-black/5 dark:bg-white/5"}`}
      data-column={column.key}
      aria-label={`Kolumna ${column.label}`}
    >
      <header className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold">
        <span className={`min-w-0 flex-1 truncate ${column.hint ? "cursor-help" : ""}`} title={column.hint}>
          {column.label}
        </span>
        <span className="text-xs font-normal text-[var(--muted)]">{column.tasks.length}</span>
        <button type="button" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]" onClick={() => setCollapsed(true)} aria-label={`Zwiń kolumnę ${column.label}`} title="Zwiń">
          ⟨
        </button>
      </header>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="flex min-h-12 flex-col gap-1.5">
          {visible.map((t) => (
            <Card key={t.id} task={t} column={column.key} today={today} tagNames={t.tagIds.map((id) => tagName.get(id) ?? "").filter(Boolean)} listName={showList ? listName.get(t.listId) : undefined} progress={children.get(t.id)} />
          ))}
        </ul>
      </SortableContext>
      {column.tasks.length > shown ? (
        <button type="button" className="mt-1 text-xs text-[var(--accent)] hover:underline" onClick={() => setShown((n) => n + PAGE)}>
          Pokaż więcej ({column.tasks.length - shown})
        </button>
      ) : null}
      <QuickAdd placeholder="Dodaj kartę" listId={listId} {...add} />
    </section>
  );
}

/**
 * Tablica z zadań `tasks` (lista, przestrzeń albo wynik filtra). `listId` — lista nowych kart;
 * `showList` — nazwa listy na karcie (tablica z kilku list).
 */
export function Board({ data, ctx, tasks, by, onBy, listId, showList }: { data: AppData; ctx: ViewContext; tasks: readonly ViewTask[]; by: BoardBy; onBy: (by: BoardBy) => void; listId?: string; showList: boolean }) {
  const { run, notify } = useTaskActions();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const lists = useMemo(() => {
    const used = new Set(tasks.map((t) => t.listId));
    return data.lists.filter((l) => used.has(l.id) || l.id === listId);
  }, [data.lists, tasks, listId]);
  const columns = useMemo(() => boardColumns(tasks, by, { today: ctx.today, firstDayOfWeek: ctx.firstDayOfWeek }, { tags: data.tags, lists }), [tasks, by, ctx.today, ctx.firstDayOfWeek, data.tags, lists]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const from = active.data.current as CardData | undefined;
    const overCard = over.data.current as (CardData & { sortable?: { index: number } }) | { column: string } | undefined;
    if (!from || !overCard) return;
    const toKey = overCard.column;
    const target = columns.find((c) => c.key === toKey);
    const task = data.tasks.find((t) => t.id === from.taskId);
    if (!target || !task) return;
    // Na kartę — jej miejsce (przy przesuwaniu w dół tej samej kolumny — za nią); na pustą część kolumny — koniec.
    const rest = target.tasks.filter((t) => t.id !== task.id);
    const same = from.column === toKey;
    const fromIndex = target.tasks.findIndex((t) => t.id === task.id);
    let index = rest.length;
    if ("taskId" in overCard) {
      const overIndex = rest.findIndex((t) => t.id === overCard.taskId);
      index = same && fromIndex < target.tasks.findIndex((t) => t.id === overCard.taskId) ? overIndex + 1 : overIndex;
    }
    if (same && index === fromIndex) return;
    if (by === "tag" && toKey !== "none" && from.column !== toKey && task.tagIds.includes(toKey)) return notify("Zadanie ma już ten tag.");
    const { ops, undo } = boardDropOps(task, data.tasks, by, from.column, toKey, target.tasks, Math.max(0, index), { today: ctx.today, now: new Date(), timeZone: ctx.timeZone });
    void run(ops, from.column === toKey ? undefined : { text: `„${task.title}” → ${target.label}`, undo });
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[var(--muted)]">Kolumny:</span>
        <Select aria-label="Kryterium kolumn" value={by} onChange={(e) => onBy(e.target.value as BoardBy)} className="py-1 text-xs">
          {(Object.keys(BOARD_BY) as BoardBy[]).map((k) => (
            <option key={k} value={k}>
              {BOARD_BY[k]}
            </option>
          ))}
        </Select>
        {by === "status" ? <span className="text-[var(--muted)]">„Gotowe” z ostatnich 7 dni</span> : null}
      </div>
      <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4" data-testid="board">
          {columns.map((c) => (
            <Column key={c.key} column={c} by={by} data={data} today={ctx.today} listId={listId} showList={showList} />
          ))}
          {!columns.length ? <p className="py-6 text-sm text-[var(--muted)]">{by === "tag" ? "Brak tagów." : "Brak kolumn."}</p> : null}
        </div>
      </DndContext>
    </div>
  );
}
