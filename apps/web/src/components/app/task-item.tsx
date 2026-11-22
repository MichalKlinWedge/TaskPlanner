"use client";

/**
 * Wiersz zadania i akcje zadań (ukończenie z „Cofnij”, zapis operacji z dymkiem). Zapisy idą
 * przez `store.mutate`; reguły ukończenia serii są w `completeTaskOps` (core).
 */
import { assigneeOf, collaboratorBadge, columnDate, completeTaskOps, descendants, describeRecurrence, isOpen, localDateAt, needsDecision, openDescendants, plural, PRIORITY, relativeDay, reopenTaskPatch, toggleTaskTagOps, LIST_COLUMN, type ListColumn, type LocalDate, type TaskOp, type ViewTask } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { listEditable } from "@/lib/app-data";

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

/** Operacje w jednej transakcji — jedno odświeżenie widoków (np. 16 zmian przy przesunięciu projektu). */
const apply = (store: TabStore, ops: readonly TaskOp[]) => store.mutateMany(ops);

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
        const result = completeTaskOps(task, { now, timeZone, subtasks: task.recurrence ? descendants(tasks, task.id) : [] });
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
  /** Dodatkowe kolumny widoku listy (`view_prefs.columns`) — po prawej, w kolejności `LIST_COLUMN`. */
  columns?: readonly ListColumn[];
  /** „+” przy tytule: dodanie podzadania (widok listy ustawia górne pole na to zadanie). */
  onAddSubtask?: () => void;
  /** Tagi jako kolumny (`view_prefs.tagColumns`): ✓ = zadanie ma tag, klik przełącza. */
  tagColumns?: readonly TagColumn[];
}

export interface TagColumn {
  id: string;
  name: string;
  color: string | null;
}

/** Szerokości kolumn — wspólne dla wiersza i nagłówka `TaskColumnsHeader`. */
const COLUMN_WIDTH: Record<ListColumn, string> = { assignee: "w-24 sm:w-36", start: "w-16 sm:w-24", due: "w-16 sm:w-24" };
const TAG_WIDTH = "w-14 sm:w-20";

/** Nagłówek kolumn nad wierszami listy. */
export function TaskColumnsHeader({ columns, tagColumns = [] }: { columns: readonly ListColumn[]; tagColumns?: readonly TagColumn[] }) {
  if (!columns.length && !tagColumns.length) return null;
  return (
    <div className="flex gap-2 border-b border-[var(--line)] pb-1 text-xs font-medium text-[var(--muted)]" data-testid="list-columns-header">
      <span className="flex-1" />
      {columns.map((c) => (
        <span key={c} className={`${COLUMN_WIDTH[c]} shrink-0 truncate`}>
          {LIST_COLUMN[c]}
        </span>
      ))}
      {tagColumns.map((t) => (
        <span key={t.id} className={`${TAG_WIDTH} shrink-0 truncate`} title={`Tag @${t.name}`} style={t.color ? { color: t.color } : undefined}>
          @{t.name}
        </span>
      ))}
    </div>
  );
}

export function TaskItem({ task, today, showDate = true, listName, depth = 0, progress, collapsed, onCollapse, virtualDate, habitDone, dnd, columns = [], onAddSubtask, tagColumns = [] }: TaskItemProps) {
  const { toggle, run } = useTaskActions();
  const { openTask, selectedIds, select, data } = useAppEnv();
  const selected = selectedIds.has(task.id);
  const attachments = data.attachments.get(task.id)?.length ?? 0;
  const assignee = assigneeOf(task.assigneeId, data.collaborators);
  const closed = task.kind === "habit" ? Boolean(habitDone) : !isOpen(task);
  // Przestrzeń albo lista udostępniona do podglądu: zadanie da się otworzyć, ale nie odhaczyć.
  const readOnly = !listEditable(data, task.listId);
  const date = virtualDate ?? task.dueDate;
  const overdue = !virtualDate && !closed && task.dueDate !== null && task.dueDate < today;
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;
  // Kolumna „Koniec” / „Odpowiedzialny” zastępuje to samo w szarym wierszu pod tytułem.
  const onOpen = (e: MouseEvent) => {
    // Ctrl / Shift + klik — zaznaczanie wielu (operacje grupowe), zwykły klik — panel.
    if (e.ctrlKey || e.metaKey) return select(task.id, "toggle");
    if (e.shiftKey) return select(task.id, "range");
    select(task.id);
    openTask(task.id);
  };
  const dueColumn = columns.includes("due");
  // Osoby przy tytule: odpowiedzialny (pełny znaczek), potem uczestnicy (obrys); nieznani pominięci.
  const people = [
    ...(assignee ? [{ person: assignee, role: "Odpowiedzialny" }] : []),
    ...(data.participants.get(task.id) ?? [])
      .filter((id) => id !== task.assigneeId)
      .map((id) => assigneeOf(id, data.collaborators))
      .filter((c) => c !== null)
      .map((person) => ({ person, role: "Uczestnik" })),
  ];

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
          disabled={readOnly}
          title={readOnly ? "Tylko podgląd" : undefined}
          onClick={() => void toggle(task, { habitDone })}
          className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 text-[11px] text-white transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: color, background: closed ? color : `${color}14` }}
        >
          {closed ? "✓" : ""}
        </button>
      )}
      <div
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-1"
        onClick={(e) => {
          // Puste miejsce obok tytułu działa jak tytuł.
          if (e.target === e.currentTarget) onOpen(e);
        }}
      >
      <button type="button" className="min-w-0 cursor-pointer text-left" onClick={onOpen}>
        <span className={`block break-words ${closed ? "line-through opacity-50" : ""}`}>{task.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--muted)]">
          {showDate && date && !dueColumn ? <span className={overdue ? "font-medium text-[var(--danger)]" : ""}>{relativeDay(date, today)}</span> : null}
          {task.dueTime && !dueColumn ? <span>{task.dueTime}</span> : null}
          {task.recurrence ? <span title={describeRecurrence(task.recurrence)}>↻ {describeRecurrence(task.recurrence)}</span> : null}
          {needsDecision(task) && !closed ? (
            <span className="text-amber-700 dark:text-amber-300" title="Przesuwane 3 razy lub więcej — zrób, zmniejsz albo usuń">
              ⇥ {task.postponeCount}×
            </span>
          ) : null}
          {progress && progress.total > 0 ? (
            <span title="Ukończone podzadania">
              {progress.done}/{progress.total}
            </span>
          ) : null}
          {task.status === "in_progress" || task.status === "waiting" ? <span>{task.status === "in_progress" ? "w trakcie" : "oczekuje"}</span> : null}
          {attachments ? <span title={`Załączniki: ${attachments}`}>📎 {attachments}</span> : null}
          {listName ? <span className="truncate">{listName}</span> : null}
        </span>
      </button>
      {people.length ? (
        <span className="mt-0.5 flex shrink-0 items-center gap-0.5" data-testid="task-people">
          {people.slice(0, 4).map(({ person, role }) => (
            <span
              key={person.id}
              title={`${role}: ${person.name}`}
              className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                role === "Odpowiedzialny"
                  ? "bg-sky-100 text-sky-900 dark:bg-sky-900/60 dark:text-sky-100"
                  : "border border-sky-300 text-sky-800 dark:border-sky-700 dark:text-sky-200"
              }`}
            >
              {collaboratorBadge(person)}
              <span className="sr-only">
                {role}: {person.name}
              </span>
            </span>
          ))}
          {people.length > 4 ? (
            <span className="text-[10px] text-[var(--muted)]" title={people.slice(4).map(({ person }) => person.name).join(", ")}>
              +{people.length - 4}
            </span>
          ) : null}
        </span>
      ) : null}
      {onAddSubtask ? (
        <button
          type="button"
          aria-label={`Dodaj podzadanie do „${task.title}”`}
          title="Dodaj podzadanie"
          onClick={onAddSubtask}
          className="mt-px shrink-0 rounded px-1 text-base leading-5 font-semibold text-[var(--accent)] opacity-0 group-hover:opacity-100 hover:bg-[var(--hover)] focus:opacity-100"
          data-testid="add-subtask"
        >
          +
        </button>
      ) : null}
      </div>
      {columns.map((c) => (
        <span key={c} className={`${COLUMN_WIDTH[c]} mt-0.5 shrink-0 truncate text-xs ${closed ? "opacity-50" : ""}`} data-column={c}>
          {c === "assignee" ? (
            assignee ? (
              <span title={`Odpowiedzialny: ${assignee.name}`}>{assignee.name}</span>
            ) : (
              <span className="text-[var(--muted)]" title="Nikt nie jest wskazany — odpowiada twórca zadania">
                —
              </span>
            )
          ) : c === "start" ? (
            task.startDate ? (
              <span title={task.startDate}>{columnDate(task.startDate, today)}</span>
            ) : (
              <span className="text-[var(--muted)]">—</span>
            )
          ) : date ? (
            <span className={overdue ? "font-medium text-[var(--danger)]" : ""} title={`${date}${task.dueTime ? ` ${task.dueTime}` : ""}`}>
              {columnDate(date, today)}
              {task.dueTime ? ` ${task.dueTime}` : ""}
            </span>
          ) : (
            <span className="text-[var(--muted)]">—</span>
          )}
        </span>
      ))}
      {tagColumns.map((tag) => {
        const on = task.tagIds.includes(tag.id);
        const locked = readOnly || Boolean(virtualDate) || task.kind !== "task";
        return (
          <span key={tag.id} className={`${TAG_WIDTH} mt-0.5 shrink-0 ${closed ? "opacity-50" : ""}`} data-tag-column={tag.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Tag @${tag.name}: „${task.title}”`}
              title={locked ? (on ? `@${tag.name}` : undefined) : on ? `Zdejmij @${tag.name}` : `Dodaj @${tag.name}`}
              disabled={locked}
              onClick={() => {
                const { ops, undo } = toggleTaskTagOps(task.id, tag.id, !on);
                void run(ops, { text: on ? `Zdjęto @${tag.name} z „${task.title}”` : `Dodano @${tag.name} do „${task.title}”`, undo });
              }}
              className={`flex h-[18px] w-[18px] items-center justify-center rounded border text-[11px] font-bold transition enabled:hover:border-[var(--accent)] disabled:cursor-default ${
                on ? "border-transparent text-white" : "border-[var(--line)] text-transparent"
              } ${locked && !on ? "opacity-40" : ""}`}
              style={on ? { background: tag.color ?? "var(--accent)" } : undefined}
            >
              ✓
            </button>
          </span>
        );
      })}
    </li>
  );
}
