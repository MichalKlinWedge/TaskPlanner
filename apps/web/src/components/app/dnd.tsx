"use client";

/**
 * Przeciąganie zadań (dnd-kit, jak w PoC-5): kolejność ręczna i drzewo w widoku listy
 * (`dropTaskOps`) oraz przenoszenie między dniami w „Nadchodzących” (`bulkTaskOps` → termin).
 * Uchwyt „⋮⋮” w wierszu; klawiatura: fokus na uchwycie, Spacja, strzałki, Spacja.
 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { bulkTaskOps, dropTaskOps, relativeDay, type LocalDate } from "@taskplanner/core";
import type { ReactNode } from "react";

import { useAppEnv } from "./app-env";
import { TaskItem, useTaskActions, type TaskItemProps } from "./task-item";

const useTaskSensors = () =>
  useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

// ── Lista: kolejność i drzewo ────────────────────────────────────────────────────────────────

/** Lista z przeciąganiem: `ids` — wiersze w kolejności na ekranie (spłaszczone drzewo). */
export function SortableTaskList({ ids, children }: { ids: readonly string[]; children: ReactNode }) {
  const { data } = useAppEnv();
  const { run, notify } = useTaskActions();
  const sensors = useTaskSensors();

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    const ops = dropTaskOps(data.tasks, String(active.id), String(over.id), from < to ? "after" : "before");
    if (ops === null) return notify("Tu nie można upuścić: we własne podzadanie albo ponad 4 poziomy zadań.");
    if (ops.length) void run(ops);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <ul className="divide-y divide-[var(--line)]">{children}</ul>
      </SortableContext>
    </DndContext>
  );
}

export function SortableTaskItem(props: TaskItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.task.id });
  return (
    <TaskItem
      {...props}
      dnd={{ ref: setNodeRef, style: { transform: CSS.Transform.toString(transform), transition }, handle: { ...attributes, ...listeners }, dragging: isDragging }}
    />
  );
}

// ── Nadchodzące: między dniami ───────────────────────────────────────────────────────────────

const DAY = "day:";

/** Kontener dni: upuszczenie zadania na dzień zmienia termin (godzina zostaje, zakres się przesuwa). */
export function DayDnd({ children }: { children: ReactNode }) {
  const { data, today, timeZone } = useAppEnv();
  const { run, notify } = useTaskActions();
  const sensors = useTaskSensors();

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const date = over && String(over.id).startsWith(DAY) ? (String(over.id).slice(DAY.length) as LocalDate) : null;
    const task = data.tasks.find((t) => t.id === active.data.current?.taskId);
    if (!date || !task || task.dueDate === date) return;
    const { ops, undo } = bulkTaskOps([task], data.tasks, { kind: "date", date }, { today, now: new Date(), timeZone });
    if (!ops.length) return notify("Nic do zmiany.");
    void run(ops, { text: `„${task.title}” → ${relativeDay(date, today)}`, undo });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
      {children}
    </DndContext>
  );
}

/** Sekcja dnia jako cel upuszczenia (podświetlona, gdy nad nią jest zadanie). */
export function DayDrop({ date, children }: { date: LocalDate; children: (over: boolean) => ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${DAY}${date}` });
  return <div ref={setNodeRef}>{children(isOver)}</div>;
}

/** Zadanie do przeciągnięcia na inny dzień (wirtualne wystąpienia serii — nie). */
export function DraggableTaskItem(props: TaskItemProps & { dragKey: string }) {
  const { dragKey, ...rest } = props;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: dragKey, data: { taskId: props.task.id } });
  return (
    <TaskItem
      {...rest}
      dnd={{ ref: setNodeRef, style: { transform: CSS.Translate.toString(transform), zIndex: isDragging ? 20 : undefined, position: "relative" }, handle: { ...attributes, ...listeners }, dragging: isDragging }}
    />
  );
}
