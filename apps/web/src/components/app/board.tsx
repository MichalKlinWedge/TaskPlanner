"use client";

/**
 * Tablica kanban (M10) na webie: kolumny z `core/kanban.ts`, przeciąganie kart (dnd-kit) zmienia
 * atrybut kolumny i kolejność (`board_sort_key`), szybkie dodanie u góry kolumny z atrybutem
 * kolumny, zwijanie kolumn. Tryb „Własne”: kolumny listy tablicy (`lists.board_columns`) —
 * dodawanie, zmiana nazwy, usuwanie (z cofnięciem) i przeciąganie kolumn za uchwyt. Warunek z PoC-5: kolumna rysuje porcję kart (`PAGE`) — tylko one są
 * sortowalne, reszta po „Pokaż więcej”.
 */
import { closestCenter, closestCorners, DndContext, KeyboardSensor, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { addBoardColumnOps, BOARD_BY, type BoardColumnDef, type TaskOp, boardColumns, boardDropOps, describeRecurrence, moveBoardColumnOps, removeBoardColumnOps, renameBoardColumnOps, isOpen, PRIORITY, relativeDay, tagsForWorkspace, type BoardBy, type BoardColumn, type LocalDate, type ViewContext, type ViewTask } from "@taskplanner/core";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { listEditable, type AppData } from "@/lib/app-data";

import { useAppEnv } from "./app-env";
import { PeopleBadges } from "./people-badges";
import { QuickAdd } from "./quick-add";
import { TAG_CHIP, tagChipStyle } from "./tag-chip";
import { DoneCircle, useTaskActions } from "./task-item";
import { Button, Input, Select } from "./ui";

/** Ile kart kolumna rysuje od razu (PoC-5: ~400 sortowalnych kart = 150–184 ms na starcie przeciągania). */
const PAGE = 40;
const cardId = (column: string, task: string) => `card:${column}:${task}`;
const columnSortId = (column: string) => `colsort:${column}`;

/**
 * Cel upuszczenia: pod wskaźnikiem (karta albo kolumna); z klawiatury (bez wskaźnika) — najbliższy.
 * Puszczenie poza kolumnami nic nie zmienia (`closestCorners` sam wybrałby najbliższą kolumnę).
 * Przeciągana kolumna (tryb „Własne”) celuje tylko w inne kolumny-do-sortowania, karta — nigdy w nie.
 */
const collision: CollisionDetection = (args) => {
  const columnDrag = String(args.active.id).startsWith("colsort:");
  args = { ...args, droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith("colsort:") === columnDrag) };
  if (columnDrag) return closestCenter(args);
  if (!args.pointerCoordinates) return closestCorners(args);
  const hits = pointerWithin(args);
  const cards = hits.filter((h) => String(h.id).startsWith("card:"));
  return cards.length ? closestCorners({ ...args, droppableContainers: args.droppableContainers.filter((c) => cards.some((h) => h.id === c.id)) }) : hits;
};

interface CardData {
  taskId: string;
  column: string;
}

interface ColumnDragData {
  kind: "column";
  key: string;
}

/** Uchwyt i edycja własnej kolumny (tryb „Własne”, bez „Do przypisania”). */
interface ColumnEdit {
  handle: ReactNode;
  onRename: (name: string) => void;
  onRemove: () => void;
}

const Card = memo(function Card({ task, column, by, today, tags, listName, progress }: { task: ViewTask; column: string; by: BoardBy; today: LocalDate; tags: readonly { id: string; name: string; color: string | null }[]; listName?: string; progress?: { done: number; total: number } }) {
  const { openTask, select, selectedIds, data } = useAppEnv();
  const { toggle } = useTaskActions();
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
      <div className="flex items-start gap-2">
        {/* Spacja / Enter na kółku odhacza, a nie podnosi karty. */}
        <span className="contents" onKeyDown={(e) => e.stopPropagation()}>
          <DoneCircle task={task} closed={!isOpen(task)} readOnly={!listEditable(data, task.listId)} onToggle={() => void toggle(task)} className="mt-px" />
        </span>
        <div className={`min-w-0 flex-1 break-words ${task.status === "done" ? "text-[var(--muted)] line-through" : ""}`}>{task.title}</div>
        <PeopleBadges task={task} className="mt-px" />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--muted)]">
        {task.dueDate ? <span className={overdue ? "font-medium text-[var(--danger)]" : ""}>{relativeDay(task.dueDate, today)}{task.dueTime ? ` ${task.dueTime}` : ""}</span> : null}
        {task.recurrence ? <span title={describeRecurrence(task.recurrence)}>↻</span> : null}
        {by !== "status" && (task.status === "in_progress" || task.status === "waiting") ? <span>{task.status === "in_progress" ? "w trakcie" : "oczekuje"}</span> : null}
        {progress && progress.total ? <span title="Podzadania">☑ {progress.done}/{progress.total}</span> : null}
        {tags.map((tag) => (
          <span key={tag.id} className={`px-1.5 ${TAG_CHIP}`} style={tagChipStyle(tag.color)}>
            {tag.name}
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
  edit,
  sortRef,
  sortStyle,
}: {
  column: BoardColumn;
  by: BoardBy;
  data: AppData;
  today: LocalDate;
  /** Lista nowych kart (widok listy / domyślny Inbox). */
  listId?: string;
  showList: boolean;
  edit?: ColumnEdit;
  /** Węzeł i styl kolumny przeciąganej (tryb „Własne”). */
  sortRef?: (node: HTMLElement | null) => void;
  sortStyle?: CSSProperties;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.key}`, data: { column: column.key } });
  const [shown, setShown] = useState(PAGE);
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const ref = (node: HTMLElement | null) => {
    setNodeRef(node);
    sortRef?.(node);
  };
  const visible = column.tasks.slice(0, shown);
  const ids = useMemo(() => visible.map((t) => cardId(column.key, t.id)), [visible, column.key]);
  const tagById = useMemo(() => new Map(data.tags.map((t) => [t.id, t])), [data.tags]);
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
              : by === "custom" && column.key !== "none"
                ? { defaults: { boardColumnId: column.key } }
                : {};

  if (collapsed) {
    return (
      <section ref={sortRef} style={sortStyle} className="flex w-10 shrink-0 flex-col items-center rounded-lg bg-black/5 py-2 dark:bg-white/5" data-column={column.key}>
        <button type="button" className="text-xs text-[var(--muted)] [writing-mode:vertical-rl]" onClick={() => setCollapsed(false)} aria-label={`Rozwiń kolumnę ${column.label}`}>
          {column.label} · {column.tasks.length}
        </button>
      </section>
    );
  }

  return (
    <section
      ref={ref}
      style={sortStyle}
      className={`flex w-72 shrink-0 flex-col rounded-lg p-2 transition-colors ${isOver ? "bg-indigo-50 ring-2 ring-[var(--accent)] dark:bg-indigo-950/40" : "bg-black/5 dark:bg-white/5"}`}
      data-column={column.key}
      aria-label={`Kolumna ${column.label}`}
    >
      <header className="group mb-2 flex items-center gap-2 px-1 text-sm font-semibold">
        {edit?.handle}
        {renaming && edit ? (
          <input
            autoFocus
            defaultValue={column.label}
            maxLength={60}
            aria-label="Nazwa kolumny"
            className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--surface)] px-1 py-0.5 text-sm font-semibold outline-none"
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value.trim()) edit.onRename(e.target.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = column.label;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span
            className={`min-w-0 flex-1 truncate ${column.hint ? "cursor-help" : ""}`}
            title={column.hint ?? (edit ? "Kliknij dwukrotnie, aby zmienić nazwę" : undefined)}
            onDoubleClick={edit ? () => setRenaming(true) : undefined}
          >
            {column.label}
          </span>
        )}
        <span className="text-xs font-normal text-[var(--muted)]">{column.tasks.length}</span>
        {edit ? (
          <>
            <button type="button" className="text-xs text-[var(--muted)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[var(--foreground)]" onClick={() => setRenaming(true)} aria-label={`Zmień nazwę kolumny ${column.label}`} title="Zmień nazwę">
              ✎
            </button>
            <button type="button" className="text-xs text-[var(--muted)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[var(--danger)]" onClick={edit.onRemove} aria-label={`Usuń kolumnę ${column.label}`} title="Usuń kolumnę (zadania wrócą do „Do przypisania”)">
              ✕
            </button>
          </>
        ) : null}
        <button type="button" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]" onClick={() => setCollapsed(true)} aria-label={`Zwiń kolumnę ${column.label}`} title="Zwiń">
          ⟨
        </button>
      </header>
      {/* Dodanie nad kartami — widoczne bez przewijania długiej kolumny. */}
      {!listId || listEditable(data, listId) ? (
        <div className="mb-1.5">
          <QuickAdd placeholder="Dodaj kartę" listId={listId} {...add} />
        </div>
      ) : null}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="flex min-h-12 flex-col gap-1.5">
          {visible.map((t) => (
            <Card key={t.id} task={t} column={column.key} by={by} today={today} tags={t.tagIds.flatMap((id) => tagById.get(id) ?? [])} listName={showList ? listName.get(t.listId) : undefined} progress={children.get(t.id)} />
          ))}
        </ul>
      </SortableContext>
      {column.tasks.length > shown ? (
        <button type="button" className="mt-1 text-xs text-[var(--accent)] hover:underline" onClick={() => setShown((n) => n + PAGE)}>
          Pokaż więcej ({column.tasks.length - shown})
        </button>
      ) : null}
    </section>
  );
}

/** Własna kolumna z uchwytem do przeciągania (dnd-kit `useSortable`, poziomo). */
function SortableColumn({ onRename, onRemove, ...props }: Omit<Parameters<typeof Column>[0], "edit" | "sortRef" | "sortStyle"> & { onRename: (name: string) => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: columnSortId(props.column.key),
    data: { kind: "column", key: props.column.key } satisfies ColumnDragData,
  });
  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      className="cursor-grab touch-none text-[var(--muted)] hover:text-[var(--foreground)]"
      aria-label={`Przenieś kolumnę ${props.column.label}`}
      title="Przeciągnij, aby zmienić kolejność"
    >
      ⠿
    </button>
  );
  return (
    <Column
      {...props}
      edit={{ handle, onRename, onRemove }}
      sortRef={setNodeRef}
      sortStyle={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.6 : undefined, zIndex: isDragging ? 10 : undefined }}
    />
  );
}

const NO_COLUMNS: never[] = [];

/** Dodanie własnej kolumny (pole nazwy w pasku tablicy). */
function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button className="py-1 text-xs" onClick={() => setOpen(true)} data-testid="board-add-column">
        + Kolumna
      </Button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("name") as HTMLInputElement;
        if (!input.value.trim()) return;
        onAdd(input.value);
        input.value = "";
      }}
    >
      <Input name="name" autoFocus maxLength={60} placeholder="Nazwa kolumny" aria-label="Nazwa nowej kolumny" className="w-44 py-1 text-xs" onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
      <Button kind="primary" type="submit" className="py-1 text-xs">
        Dodaj
      </Button>
      <Button kind="ghost" className="py-1 text-xs" onClick={() => setOpen(false)}>
        Gotowe
      </Button>
    </form>
  );
}

/**
 * Tablica z zadań `tasks` (lista, przestrzeń albo wynik filtra). `listId` — lista nowych kart (pole
 * dodawania nad tablicą i „Dodaj kartę” u góry kolumny z jej polami); `showList` — nazwa listy na karcie.
 */
export function Board({
  data,
  ctx,
  tasks,
  by,
  onBy,
  listId,
  showList,
  addLabel,
}: {
  data: AppData;
  ctx: ViewContext;
  tasks: readonly ViewTask[];
  by: BoardBy;
  onBy: (by: BoardBy) => void;
  listId?: string;
  showList: boolean;
  /** Podpowiedź pola dodawania nad tablicą (dokąd trafi zadanie). */
  addLabel?: string;
}) {
  const { run, notify } = useTaskActions();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const lists = useMemo(() => {
    const used = new Set(tasks.map((t) => t.listId));
    return data.lists.filter((l) => used.has(l.id) || l.id === listId);
  }, [data.lists, tasks, listId]);
  // Przestrzeń tablicy: wybrana albo wspólna dla jej list (tagi przestrzeni, własne kolumny).
  const space = ctx.workspaceId ?? (lists.length && lists.every((l) => l.workspaceId === lists[0]!.workspaceId) ? lists[0]!.workspaceId : null);
  const custom = by === "custom";
  // Własne kolumny należą do listy: tylko tablica jednej listy (widok listy albo przestrzeń z jedną listą).
  const owner = lists.length === 1 ? lists[0] : undefined;
  // Lista tylko do podglądu (gość): bez dodawania kart i zmian kolumn.
  const locked = listId ? !listEditable(data, listId) : false;
  const defs = owner?.boardColumns ?? NO_COLUMNS;
  // Kolumny tagów: tagi przestrzeni tablicy + użyte na kartach.
  const tags = useMemo(() => tagsForWorkspace(data.tags, space, tasks.flatMap((t) => t.tagIds)), [data.tags, space, tasks]);
  const columns = useMemo(
    () => (custom && !owner ? [] : boardColumns(tasks, by, { today: ctx.today, firstDayOfWeek: ctx.firstDayOfWeek }, { tags, lists, columns: defs })),
    [tasks, by, custom, owner, ctx.today, ctx.firstDayOfWeek, tags, lists, defs],
  );
  // Kolumna bez wartości (do przypisania / bez terminu / bez tagu) — pierwsza i przypięta.
  const pinned = columns[0]?.key === "none" ? columns[0] : undefined;
  const scrolled = pinned ? columns.filter((c) => c !== pinned) : columns;
  const columnIds = useMemo(() => (custom ? defs.map((d) => columnSortId(d.id)) : []), [custom, defs]);
  // Kolumny po ostatniej własnej zmianie: dwie zmiany szybciej niż odświeżenie zapytania nie nadpisują się.
  const latest = useRef(defs);
  useEffect(() => {
    latest.current = defs;
  }, [defs]);
  const editColumns = (make: (current: readonly BoardColumnDef[]) => TaskOp[] | { ops: TaskOp[]; undo?: TaskOp[] }, text?: string) => {
    try {
      const result = make(latest.current);
      const { ops, undo } = Array.isArray(result) ? { ops: result, undo: undefined } : result;
      const next = ops.find((op) => op.table === "lists")?.patch.board_columns;
      if (next !== undefined) latest.current = (next as BoardColumnDef[] | null) ?? [];
      void run(ops, text ? { text, undo } : undefined);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const dragged = active.data.current as CardData | ColumnDragData | undefined;
    if (dragged && "kind" in dragged) {
      const target = over.data.current as ColumnDragData | undefined;
      if (owner && target?.kind === "column") editColumns((current) => moveBoardColumnOps(owner.id, current, dragged.key, current.findIndex((d) => d.id === target.key)));
      return;
    }
    const from = dragged;
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
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted)]">Kolumny:</span>
        <Select aria-label="Kryterium kolumn" value={by} onChange={(e) => onBy(e.target.value as BoardBy)} className="py-1 text-xs">
          {(Object.keys(BOARD_BY) as BoardBy[]).map((k) => (
            <option key={k} value={k}>
              {BOARD_BY[k]}
            </option>
          ))}
        </Select>
        {by === "status" ? <span className="text-[var(--muted)]">„Gotowe” z ostatnich 7 dni</span> : null}
        {custom && owner ? <span className="text-[var(--muted)]">Kolumny listy „{owner.kind === "inbox" ? "Inbox" : owner.name}” — przeciągnij ⠿, by zmienić kolejność</span> : null}
        {custom && owner && !locked ? (
          <div className="ml-auto">
            <AddColumn onAdd={(name) => editColumns((current) => addBoardColumnOps(owner.id, current, name))} />
          </div>
        ) : null}
      </div>
      {locked ? null : (
        <div className="max-w-xl">
          <QuickAdd listId={listId} placeholder={addLabel ?? "Dodaj zadanie"} />
        </div>
      )}
      {custom && !owner ? (
        <p className="py-6 text-sm text-[var(--muted)]" data-testid="board-custom-no-list">
          Własne kolumny należą do listy — otwórz listę i przełącz ją na „Tablica”.
        </p>
      ) : null}
      <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onDragEnd}>
        {/* Kolumna bez wartości stoi w miejscu, przewijają się pozostałe (na wąskim ekranie — całość). */}
        <div className="flex gap-3 overflow-x-auto pb-4 sm:overflow-visible sm:pb-0" data-testid="board">
          {pinned ? (
            <div className="flex shrink-0 sm:pb-4">
              <Column column={pinned} by={by} data={data} today={ctx.today} listId={listId} showList={showList} />
            </div>
          ) : null}
          <div className="flex gap-3 sm:min-w-0 sm:flex-1 sm:overflow-x-auto sm:pb-4" data-testid="board-scroll">
          <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
            {scrolled.map((c) =>
              custom && owner && !locked && c.key !== "none" ? (
                <SortableColumn
                  key={c.key}
                  column={c}
                  by={by}
                  data={data}
                  today={ctx.today}
                  listId={listId}
                  showList={showList}
                  onRename={(name) => editColumns((current) => renameBoardColumnOps(owner.id, current, c.key, name))}
                  onRemove={() => editColumns((current) => removeBoardColumnOps(owner.id, current, c.key, data.tasks), `Usunięto kolumnę „${c.label}”`)}
                />
              ) : (
                <Column key={c.key} column={c} by={by} data={data} today={ctx.today} listId={listId} showList={showList} />
              ),
            )}
          </SortableContext>
          {!columns.length && !custom ? <p className="py-6 text-sm text-[var(--muted)]">{by === "tag" ? "Brak tagów." : "Brak kolumn."}</p> : null}
          </div>
        </div>
      </DndContext>
    </div>
  );
}
