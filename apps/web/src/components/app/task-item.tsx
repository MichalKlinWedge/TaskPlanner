"use client";

/**
 * Wiersz zadania i akcje zadań (ukończenie z „Cofnij”, zapis operacji z dymkiem). Zapisy idą
 * przez `store.mutate`; reguły ukończenia serii są w `completeTaskOps` (core).
 */
import { completeTaskOps, describeRecurrence, isOpen, localDateAt, openDescendants, plural, PRIORITY, relativeDay, reopenTaskPatch, type LocalDate, type TaskOp, type ViewTask } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useAppEnv } from "./app-env";

// ── Akcje ────────────────────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  undo?: TaskOp[];
}

interface TaskActions {
  toggle: (task: ViewTask, opts?: { habitDone?: boolean }) => Promise<void>;
  /** Zapis operacji po kolei; z `toast` — dymek, z `undo` — także „Cofnij”. */
  run: (ops: readonly TaskOp[], toast?: { text: string; undo?: TaskOp[] }) => Promise<void>;
  /** Dymek z komunikatem (np. błąd). */
  notify: (message: string) => void;
}

const ActionsContext = createContext<TaskActions | null>(null);

export const useTaskActions = (): TaskActions => {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("useTaskActions poza <TaskActionsProvider>.");
  return actions;
};

const apply = async (store: TabStore, ops: readonly TaskOp[]) => {
  for (const op of ops) await store.mutate(op.table, op.id, op.patch);
};

/** Akcje zadań i dymek „Cofnij” na dole ekranu. `tasks` — do pytania o otwarte podzadania. */
export function TaskActionsProvider({ store, timeZone, tasks, children }: { store: TabStore; timeZone?: string; tasks: readonly ViewTask[]; children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const next = useRef(0);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const show = useCallback((text: string, undo?: TaskOp[]) => setToast({ id: ++next.current, text, undo }), []);

  const toggle = useCallback(
    async (task: ViewTask, { habitDone }: { habitDone?: boolean } = {}) => {
      try {
        if (task.kind === "habit" && habitDone) {
          // Odznaczenie dzisiejszego wykonania = cofnięcie tych samych operacji.
          const { undo } = completeTaskOps(task, { now: new Date(), timeZone });
          await apply(store, undo);
          return;
        }
        if (task.kind === "task" && !isOpen(task)) {
          await store.mutate("tasks", task.id, reopenTaskPatch());
          return;
        }
        const now = new Date();
        const result = completeTaskOps(task, { now, timeZone });
        // M3: rodzic z otwartymi podzadaniami — „Ukończyć też podzadania?” (domyślnie tak).
        const open = task.recurrence ? [] : openDescendants(tasks, task.id);
        if (open.length && window.confirm(`„${task.title}” ma ${plural(open.length, ["otwarte podzadanie", "otwarte podzadania", "otwartych podzadań"])}. Ukończyć też je?`)) {
          for (const child of open) {
            const done = completeTaskOps({ ...child, recurrence: null }, { now, timeZone });
            result.ops.push(...done.ops);
            result.undo.push(...done.undo);
          }
        }
        await apply(store, result.ops);
        const today = localDateAt(now, timeZone);
        show(result.nextDue ? `„${task.title}” — następny termin: ${relativeDay(result.nextDue, today)}` : `Ukończono „${task.title}”`, result.undo);
      } catch (e) {
        show(e instanceof Error ? e.message : String(e));
      }
    },
    [store, timeZone, show, tasks],
  );

  const run = useCallback(
    async (ops: readonly TaskOp[], toast?: { text: string; undo?: TaskOp[] }) => {
      try {
        await apply(store, ops);
        if (toast) show(toast.text, toast.undo);
      } catch (e) {
        show(e instanceof Error ? e.message : String(e));
      }
    },
    [store, show],
  );

  const undo = async () => {
    if (!toast?.undo) return;
    const ops = toast.undo;
    setToast(null);
    await apply(store, ops).catch((e: unknown) => show(e instanceof Error ? e.message : String(e)));
  };

  return (
    <ActionsContext.Provider value={{ toggle, run, notify: show }}>
      {children}
      {toast ? (
        <div role="status" className="fixed bottom-4 left-1/2 z-30 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          <span className="truncate">{toast.text}</span>
          {toast.undo ? (
            <button type="button" className="shrink-0 font-semibold text-indigo-300 hover:underline dark:text-indigo-700" onClick={() => void undo()}>
              Cofnij
            </button>
          ) : null}
          <button type="button" aria-label="Zamknij" className="shrink-0 opacity-60 hover:opacity-100" onClick={() => setToast(null)}>
            ✕
          </button>
        </div>
      ) : null}
    </ActionsContext.Provider>
  );
}

// ── Wiersz zadania ───────────────────────────────────────────────────────────────────────────

export interface TaskItemProps {
  task: ViewTask;
  today: LocalDate;
  /** Pokazać termin (w sekcji „Dziś” zbędny). */
  showDate?: boolean;
  /** Nazwa listy w widokach zbiorczych. */
  listName?: string;
  depth?: number;
  progress?: { done: number; total: number };
  /** `true`/`false` — węzeł z podzadaniami (zwinięty / rozwinięty); brak — bez podzadań. */
  collapsed?: boolean;
  onCollapse?: () => void;
  /** Przyszłe wystąpienie serii (Nadchodzące) — tylko do odczytu. */
  virtualDate?: LocalDate;
  /** Nawyk odhaczony dziś. */
  habitDone?: boolean;
  /** Przeciąganie (`dnd.tsx`): element, styl przesunięcia i atrybuty uchwytu. */
  dnd?: { ref: (el: HTMLElement | null) => void; style: CSSProperties; handle: Record<string, unknown>; dragging: boolean };
}

export function TaskItem({ task, today, showDate = true, listName, depth = 0, progress, collapsed, onCollapse, virtualDate, habitDone, dnd }: TaskItemProps) {
  const { toggle } = useTaskActions();
  const { openTask, selectedIds, select } = useAppEnv();
  const selected = selectedIds.has(task.id);
  const closed = task.kind === "habit" ? Boolean(habitDone) : !isOpen(task);
  const date = virtualDate ?? task.dueDate;
  const overdue = !virtualDate && !closed && task.dueDate !== null && task.dueDate < today;
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;

  return (
    <li
      ref={dnd?.ref}
      className={`group relative flex items-start gap-2 py-1.5 text-sm ${virtualDate ? "opacity-60" : ""} ${selected ? "bg-[var(--hover)] shadow-[inset_3px_0_0_var(--accent)]" : "bg-[var(--background)]"} ${dnd?.dragging ? "z-10 opacity-80 shadow-lg" : ""}`}
      style={{ ...dnd?.style, paddingLeft: depth * 20 }}
      data-task-id={task.id}
      data-virtual={virtualDate ? "" : undefined}
      data-selected={selected || undefined}
    >
      {dnd ? (
        <button
          type="button"
          aria-label={`Przeciągnij „${task.title}”`}
          title="Przeciągnij"
          {...dnd.handle}
          className="absolute top-2 -left-5 cursor-grab touch-none px-1 text-xs leading-none text-[var(--muted)] opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          ⋮⋮
        </button>
      ) : null}
      {collapsed === undefined ? (
        <span className="w-4 shrink-0" />
      ) : (
        <button type="button" aria-label={collapsed ? "Rozwiń podzadania" : "Zwiń podzadania"} aria-expanded={!collapsed} onClick={onCollapse} className="mt-0.5 w-4 shrink-0 text-xs opacity-60 hover:opacity-100">
          {collapsed ? "▸" : "▾"}
        </button>
      )}
      {virtualDate ? (
        <span className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border border-dashed" style={{ borderColor: color }} title="Przyszłe wystąpienie serii" />
      ) : (
        <button
          type="button"
          role="checkbox"
          aria-checked={closed}
          aria-label={closed ? `Przywróć „${task.title}”` : `Ukończ „${task.title}”`}
          onClick={() => void toggle(task, { habitDone })}
          className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 text-[11px] text-white transition hover:opacity-80"
          style={{ borderColor: color, background: closed ? color : `${color}14` }}
        >
          {closed ? "✓" : ""}
        </button>
      )}
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        onClick={(e) => {
          // Ctrl / Shift + klik — zaznaczanie wielu (operacje grupowe), zwykły klik — panel.
          if (e.ctrlKey || e.metaKey) return select(task.id, "toggle");
          if (e.shiftKey) return select(task.id, "range");
          select(task.id);
          openTask(task.id);
        }}
      >
        <span className={`block break-words ${closed ? "line-through opacity-50" : ""}`}>{task.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--muted)]">
          {showDate && date ? <span className={overdue ? "font-medium text-[var(--danger)]" : ""}>{relativeDay(date, today)}</span> : null}
          {task.dueTime ? <span>{task.dueTime}</span> : null}
          {task.recurrence ? <span title={describeRecurrence(task.recurrence)}>↻ {describeRecurrence(task.recurrence)}</span> : null}
          {progress && progress.total > 0 ? (
            <span title="Ukończone podzadania">
              {progress.done}/{progress.total}
            </span>
          ) : null}
          {task.status === "in_progress" || task.status === "waiting" ? <span>{task.status === "in_progress" ? "w trakcie" : "oczekuje"}</span> : null}
          {listName ? <span className="truncate">{listName}</span> : null}
        </span>
      </button>
    </li>
  );
}
