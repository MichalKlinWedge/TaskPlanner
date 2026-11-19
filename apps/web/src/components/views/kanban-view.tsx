"use client";

import {
  closestCorners,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { keyBetween, PRIORITY, TASK_STATUS, type Priority, type TaskStatus } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useLocalQuery } from "@/lib/local-store";

import { afterPaint, formatDrag, syntheticDrag } from "./perf";

const COLUMNS: TaskStatus[] = ["todo", "in_progress", "waiting", "done"];

interface Card extends Record<string, string | number | null> {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  sort_key: string;
}

const TaskCard = memo(function TaskCard({ card }: { card: Card }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
      {...listeners}
      data-card={card.id}
      className="cursor-grab rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-xs"
    >
      <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: PRIORITY[card.priority as Priority]?.color }} />
      {card.title}
    </li>
  );
});

/** Ile kart kolumna rysuje od razu (reszta po „pokaż więcej”) — pełne 500 sortowalnych kart to ~1 s renderu. */
const PAGE = 100;

function Column({ status, cards, limit }: { status: TaskStatus; cards: Card[]; limit: number | null }) {
  const { setNodeRef } = useDroppable({ id: `column:${status}` });
  const [shown, setShown] = useState(limit ?? Infinity);
  const visible = useMemo(() => cards.slice(0, shown), [cards, shown]);
  const ids = useMemo(() => visible.map((c) => c.id), [visible]);
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-1 rounded bg-black/5 p-2 dark:bg-white/5" data-column={status}>
      <h3 className="text-xs font-semibold">
        {TASK_STATUS[status]} <span className="opacity-60">{cards.length}</span>
      </h3>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className="flex max-h-[60vh] min-h-10 flex-col gap-1 overflow-y-auto">
          {visible.map((card) => (
            <TaskCard key={card.id} card={card} />
          ))}
          {cards.length > visible.length && (
            <li>
              <button type="button" className="w-full text-xs underline" onClick={() => setShown((n) => n + (limit ?? PAGE))}>
                Pokaż więcej ({cards.length - visible.length})
              </button>
            </li>
          )}
        </ul>
      </SortableContext>
    </section>
  );
}

/** Kanban na dnd-kit: kolumny = status, przeciągnięcie zmienia status i `sort_key`. */
export function KanbanView({ store, onRendered }: { store: TabStore; onRendered: (ms: number | null) => void }) {
  const { rows, ms } = useLocalQuery<Card>(
    store,
    "select id, title, status, priority, sort_key from tasks where deleted_at is null and kind = 'task' and status in ('todo','in_progress','waiting','done') order by sort_key, id",
    [],
    ["tasks"],
  );
  const [measure, setMeasure] = useState<string | null>(null);
  const [paged, setPaged] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const columns = useMemo(() => {
    const map = new Map<TaskStatus, Card[]>(COLUMNS.map((s) => [s, []]));
    for (const row of rows) map.get(row.status)?.push(row);
    return map;
  }, [rows]);

  useEffect(() => {
    if (rows.length) afterPaint(() => onRendered(ms));
  }, [rows.length, ms, onRendered]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const card = rows.find((r) => r.id === active.id);
    if (!card) return;
    const overId = String(over.id);
    const status = overId.startsWith("column:") ? (overId.slice(7) as TaskStatus) : rows.find((r) => r.id === overId)?.status;
    if (!status) return;
    const target = (columns.get(status) ?? []).filter((c) => c.id !== card.id);
    const index = overId.startsWith("column:") ? target.length : Math.max(0, target.findIndex((c) => c.id === overId));
    const before = target[index - 1]?.sort_key;
    const after = target[index]?.sort_key;
    let sortKey: string;
    try {
      sortKey = keyBetween(before, after);
    } catch {
      // Klucze z różnych list nie są uporządkowane między sobą (zob. POC_WYNIKI): wstaw za poprzednikiem.
      sortKey = keyBetween(before);
    }
    void store.mutate("tasks", card.id, { status, sort_key: sortKey });
  };

  const runMeasure = async () => {
    const card = root.current?.querySelector('[data-column="todo"] [data-card]');
    const column = root.current?.querySelector('[data-column="done"] ul');
    if (!card || !column) return;
    const box = column.getBoundingClientRect();
    setMeasure("mierzę…");
    const result = await syntheticDrag(card, { x: box.left + box.width / 2, y: box.top + 40 });
    setMeasure(formatDrag(result));
  };

  return (
    <div ref={root} className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span>{rows.length} kart · zapytanie {ms?.toFixed(1) ?? "—"} ms</span>
        <button type="button" className="rounded border px-2 py-0.5" onClick={() => void runMeasure()}>
          Zmierz przeciąganie
        </button>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={paged} onChange={(e) => setPaged(e.target.checked)} /> po {PAGE} w kolumnie
        </label>
        <span data-testid="kanban-drag">{measure}</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <div className="flex gap-2">
          {COLUMNS.map((status) => (
            <Column key={`${status}:${paged}`} status={status} cards={columns.get(status) ?? []} limit={paged ? PAGE : null} />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
