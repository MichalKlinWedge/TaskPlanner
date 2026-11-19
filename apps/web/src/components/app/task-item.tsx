"use client";

/**
 * Wiersz zadania, pole „Dodaj zadanie” i akcje zadań (ukończenie z „Cofnij”, dodanie). Zapisy
 * idą przez `store.mutate`; reguły ukończenia serii są w `completeTaskOps` (core).
 */
import { completeTaskOps, describeRecurrence, isOpen, keyBetween, localDateAt, PRIORITY, relativeDay, reopenTaskPatch, uuidv7, type LocalDate, type TaskOp, type ViewTask } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Input } from "./ui";

// ── Akcje ────────────────────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  undo?: TaskOp[];
}

export interface NewTask {
  listId: string;
  title: string;
  dueDate?: LocalDate | null;
  parentId?: string | null;
  /** Klucz ostatniego zadania na liście (nowe idzie na koniec). */
  after?: string;
}

interface TaskActions {
  toggle: (task: ViewTask, opts?: { habitDone?: boolean }) => Promise<void>;
  add: (task: NewTask) => Promise<string>;
  error: (message: string) => void;
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

/** Akcje zadań i dymek „Cofnij” na dole ekranu. */
export function TaskActionsProvider({ store, timeZone, children }: { store: TabStore; timeZone?: string; children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const next = useRef(0);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 6000);
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
        const result = completeTaskOps(task, { now: new Date(), timeZone });
        await apply(store, result.ops);
        const today = localDateAt(new Date(), timeZone);
        show(result.nextDue ? `„${task.title}” — następny termin: ${relativeDay(result.nextDue, today)}` : `Ukończono „${task.title}”`, result.undo);
      } catch (e) {
        show(e instanceof Error ? e.message : String(e));
      }
    },
    [store, timeZone, show],
  );

  const add = useCallback(
    async ({ listId, title, dueDate = null, parentId = null, after }: NewTask) => {
      const id = uuidv7();
      await store.mutate("tasks", id, {
        list_id: listId,
        parent_id: parentId,
        kind: "task",
        title,
        status: "todo",
        priority: 4,
        due_date: dueDate,
        sort_key: keyBetween(after),
        postpone_count: 0,
      });
      return id;
    },
    [store],
  );

  const undo = async () => {
    if (!toast?.undo) return;
    const ops = toast.undo;
    setToast(null);
    await apply(store, ops).catch((e: unknown) => show(e instanceof Error ? e.message : String(e)));
  };

  return (
    <ActionsContext.Provider value={{ toggle, add, error: show }}>
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
}

export function TaskItem({ task, today, showDate = true, listName, depth = 0, progress, collapsed, onCollapse, virtualDate, habitDone }: TaskItemProps) {
  const { toggle } = useTaskActions();
  const closed = task.kind === "habit" ? Boolean(habitDone) : !isOpen(task);
  const date = virtualDate ?? task.dueDate;
  const overdue = !virtualDate && !closed && task.dueDate !== null && task.dueDate < today;
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;

  return (
    <li className={`group flex items-start gap-2 py-1.5 text-sm ${virtualDate ? "opacity-60" : ""}`} style={{ paddingLeft: depth * 20 }} data-task-id={task.id}>
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
      <div className="min-w-0 flex-1">
        <div className={`break-words ${closed ? "line-through opacity-50" : ""}`}>{task.title}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--muted)]">
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
        </div>
      </div>
    </li>
  );
}

// ── Dodawanie ────────────────────────────────────────────────────────────────────────────────

/** Pole „Dodaj zadanie”: Enter dodaje i zostawia fokus (szybkie dodawanie z parserem — następny krok MVP-2). */
export function AddTask({ placeholder = "Dodaj zadanie", onAdd, disabled }: { placeholder?: string; onAdd: (title: string) => Promise<unknown>; disabled?: boolean }) {
  const [title, setTitle] = useState("");
  const { error } = useTaskActions();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    setTitle("");
    void onAdd(text.slice(0, 500)).catch((e: unknown) => error(e instanceof Error ? e.message : String(e)));
  };
  return (
    <form onSubmit={submit} className="my-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`+ ${placeholder}`} aria-label={placeholder} maxLength={500} disabled={disabled} className="w-full" />
    </form>
  );
}
