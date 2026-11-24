"use client";

/**
 * Wiersz zadania i akcje zadań (ukończenie z „Cofnij”, zapis operacji z dymkiem). Zapisy idą
 * przez `store.mutate`; reguły ukończenia serii są w `completeTaskOps` (core).
 */
import { assigneeOf, columnDate, completeTaskOps, descendants, describeRecurrence, isOpen, localDateAt, needsDecision, openDescendants, plural, PRIORITY, relativeDay, reopenTaskPatch, LIST_COLUMN, type ListColumn, type LocalDate, type TaskOp, type ViewTask } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { listEditable } from "@/lib/app-data";
import { clampWidth, type ColumnWidths, type WidthColumn } from "@/lib/list-widths";
import { onRejectedOps } from "@/lib/local-store";

import { useAppEnv } from "./app-env";
import { PeopleBadges } from "./people-badges";
import { TAG_CHIP, tagChipStyle } from "./tag-chip";

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
export function TaskActionsProvider({ store, userId, timeZone, tasks, children }: { store: TabStore; userId: string; timeZone?: string; tasks: readonly ViewTask[]; children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const next = useRef(0);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const show = useCallback((text: string, undo?: TaskOp[]) => setToast({ id: ++next.current, text, undo }), []);

  // Zmiana odrzucona przez serwer jest już cofnięta lokalnie — bez dymku znikałaby bez słowa.
  useEffect(
    () => onRejectedOps(userId, (messages) => show(`Serwer odrzucił zmianę — cofnięto ją: ${messages.join("; ")}`)),
    [userId, show],
  );

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
  /** Przycisk „→ Jutro” po prawej (widok „Dziś”: zaległe i dzisiejsze); ukryty przy zadaniu tylko do podglądu. */
  onTomorrow?: () => void;
  /** Tagi pokazywane w kolumnie „Tagi” (`view_prefs.columnTags`); `null` / brak = wszystkie. */
  columnTags?: ReadonlySet<string> | null;
  /** Szerokości kolumn ustawione w nagłówku (`useListWidths`); brak = domyślne. */
  widths?: ColumnWidths;
}

/** Szerokości kolumn — wspólne dla wiersza i nagłówka `TaskColumnsHeader`. */
const COLUMN_WIDTH: Record<ListColumn, number> = { assignee: 144, start: 96, due: 96, tags: 176 };
/** Najwęższa kolumna po ściśnięciu (wąskie okno); dalej — suwak poziomy listy. */
const COLUMN_MIN = 44;
/** „Zadanie” bez ustawionej szerokości: zajmuje resztę miejsca, ale nie mniej niż tyle (od krawędzi wiersza). */
const TITLE_MIN = 260;

/** Obszar zadania przed tytułem: zwijanie (16) + odstęp + odhaczenie (18) + odstęp. */
const TITLE_INSET = 50;

/**
 * Kolumna danych: szerokość domyślna albo przeciągnięta to podstawa, przy braku miejsca kolumny ściskają
 * się (do `COLUMN_MIN`) zamiast „Zadanie”.
 */
const columnStyle = (c: ListColumn, widths: ColumnWidths): CSSProperties => ({ flex: `0 1 ${widths[c] ?? COLUMN_WIDTH[c]}px`, minWidth: COLUMN_MIN });

/**
 * Obszar „Zadanie” (nagłówek: od krawędzi wiersza; wiersz: bez `inset` — zwijanie, odhaczenie, wcięcie).
 * Przeciągnięta szerokość jest stała; bez niej — reszta miejsca, nie mniej niż `TITLE_MIN`.
 */
const titleStyle = (widths: ColumnWidths, inset = 0): CSSProperties =>
  widths.title ? { flex: "none", width: Math.max(40, widths.title - inset) } : { flex: "1 1 0%", minWidth: Math.max(40, TITLE_MIN - inset) };

/** Uchwyt na prawej krawędzi nagłówka kolumny: przeciąganie zmienia szerokość, podwójny klik przywraca domyślną. */
function ResizeHandle({ column, label, onResize }: { column: WidthColumn; label: string; onResize: (column: WidthColumn, px: number | null) => void }) {
  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    const cell = e.currentTarget.parentElement;
    if (!cell || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => onResize(column, clampWidth(column, startWidth + ev.clientX - startX));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Szerokość kolumny „${label}”`}
      title="Przeciągnij, żeby zmienić szerokość (podwójny klik — domyślna)"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(column, null)}
      className="absolute top-0 right-0 bottom-0 z-10 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:right-0 after:w-0.5 after:rounded after:bg-[var(--accent)] after:opacity-0 hover:after:opacity-100"
      data-resize={column}
    />
  );
}

/** Nagłówek kolumn nad wierszami listy; z `onResize` kolumny (także „Zadanie”) da się poszerzać przeciąganiem. */
export function TaskColumnsHeader({ columns, widths = {}, onResize }: { columns: readonly ListColumn[]; widths?: ColumnWidths; onResize?: (column: WidthColumn, px: number | null) => void }) {
  if (!columns.length) return null;
  return (
    <div className="flex gap-2 border-b border-[var(--line)] pb-1 text-xs font-medium text-[var(--muted)]" data-testid="list-columns-header">
      <span className="relative" style={{ ...titleStyle(widths), paddingLeft: TITLE_INSET }} data-header="title">
        <span className="block truncate">Zadanie</span>
        {onResize ? <ResizeHandle column="title" label="Zadanie" onResize={onResize} /> : null}
      </span>
      {columns.map((c) => (
        <span key={c} className="relative" style={columnStyle(c, widths)} data-header={c}>
          <span className="block truncate">{LIST_COLUMN[c]}</span>
          {onResize ? <ResizeHandle column={c} label={LIST_COLUMN[c]} onResize={onResize} /> : null}
        </span>
      ))}
    </div>
  );
}

function TagChips({ tags }: { tags: readonly { id: string; name: string; color: string | null }[] }) {
  return tags.map((tag) => (
    <span key={tag.id} className={`max-w-full truncate px-1.5 py-px text-[11px] ${TAG_CHIP}`} style={tagChipStyle(tag.color)} title={`@${tag.name}`} data-tag={tag.id}>
      {tag.name}
    </span>
  ));
}

/** Kółko ukończenia w kolorze priorytetu (wiersz zadania, karta tablicy). */
export function DoneCircle({ task, closed, readOnly, onToggle, className = "" }: { task: ViewTask; closed: boolean; readOnly: boolean; onToggle: () => void; className?: string }) {
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={closed}
      aria-label={closed ? `Przywróć „${task.title}”` : `Ukończ „${task.title}”`}
      disabled={readOnly}
      title={readOnly ? "Tylko podgląd" : undefined}
      onClick={(e) => {
        // Na karcie tablicy klik w kartę otwiera zadanie.
        e.stopPropagation();
        onToggle();
      }}
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 text-[11px] text-white transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      style={{ borderColor: color, background: closed ? color : `${color}14` }}
    >
      {closed ? "✓" : ""}
    </button>
  );
}

export function TaskItem({ task, today, showDate = true, listName, depth = 0, progress, collapsed, onCollapse, virtualDate, habitDone, dnd, columns = [], onAddSubtask, onTomorrow, columnTags, widths = {} }: TaskItemProps) {
  const { toggle } = useTaskActions();
  const { openTask, selectedIds, select, data, trashed } = useAppEnv();
  const inTrash = trashed?.has(task.id) ?? false;
  const selected = !inTrash && selectedIds.has(task.id);
  const attachments = data.attachments.get(task.id)?.length ?? 0;
  const assignee = assigneeOf(task.assigneeId, data.collaborators);
  const closed = task.kind === "habit" ? Boolean(habitDone) : !isOpen(task);
  // Przestrzeń albo lista udostępniona do podglądu, zadanie w koszu: da się otworzyć, ale nie odhaczyć.
  const readOnly = inTrash || !listEditable(data, task.listId);
  const date = virtualDate ?? task.dueDate;
  const overdue = !virtualDate && !closed && task.dueDate !== null && task.dueDate < today;
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;
  // Kolumna „Koniec” / „Odpowiedzialny” zastępuje to samo w szarym wierszu pod tytułem.
  const onOpen = (e: MouseEvent) => {
    // Zadań z kosza nie zaznacza się do operacji grupowych.
    if (inTrash) return openTask(task.id);
    // Ctrl / Shift + klik — zaznaczanie wielu (operacje grupowe), zwykły klik — panel.
    if (e.ctrlKey || e.metaKey) return select(task.id, "toggle");
    if (e.shiftKey) return select(task.id, "range");
    select(task.id);
    openTask(task.id);
  };
  const dueColumn = columns.includes("due");
  // Tagi: w kolumnie „Tagi” (wybrane), a bez niej — w szarym wierszu pod tytułem.
  const tagsColumn = columns.includes("tags");
  const tags = task.tagIds.filter((id) => !tagsColumn || !columnTags || columnTags.has(id)).flatMap((id) => data.tags.find((t) => t.id === id) ?? []);

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
        <DoneCircle task={task} closed={closed} readOnly={readOnly} onToggle={() => void toggle(task, { habitDone })} className="mt-0.5" />
      )}
      <div
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-1"
        // Szerokość „Zadanie” liczona od krawędzi wiersza — wcięcie podzadań jej nie przesuwa.
        style={columns.length ? titleStyle(widths, TITLE_INSET + depth * 20) : undefined}
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
          {tagsColumn ? null : <TagChips tags={tags} />}
        </span>
      </button>
      <PeopleBadges task={task} className="mt-0.5" />
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
        <span key={c} className={`mt-0.5 text-xs ${c === "tags" ? "" : "truncate"} ${closed ? "opacity-50" : ""}`} style={columnStyle(c, widths)} data-column={c}>
          {c === "assignee" ? (
            assignee ? (
              <span title={`Odpowiedzialny: ${assignee.name}`}>{assignee.name}</span>
            ) : (
              <span className="text-[var(--muted)]" title="Nikt nie jest wskazany — odpowiada twórca zadania">
                —
              </span>
            )
          ) : c === "tags" ? (
            tags.length ? (
              <span className="flex flex-wrap gap-1">
                <TagChips tags={tags} />
              </span>
            ) : (
              <span className="text-[var(--muted)]">—</span>
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
      {onTomorrow && !readOnly ? (
        <button
          type="button"
          aria-label={`Przesuń „${task.title}” na jutro`}
          title="Przesuń na jutro"
          onClick={onTomorrow}
          className="mt-px shrink-0 rounded-md px-2 py-0.5 text-xs whitespace-nowrap text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          data-testid="task-tomorrow"
        >
          → Jutro
        </button>
      ) : null}
    </li>
  );
}
