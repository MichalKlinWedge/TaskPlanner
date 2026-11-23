"use client";

/**
 * Widok „Karteczki” (v1.x): zadania listy jako karteczki na stole — burza mózgów zespołu. Logika
 * (siatka, wolne komórki, kolizje, grupy, dopasowanie tytułu) w core `canvas.ts`; tu rysowanie,
 * przeciąganie i powiększenie. Bez sieci widok jest tylko do odczytu (praca zespołu na żywo).
 */
import {
  addCanvasGroupOps,
  assigneeOf,
  CANVAS_CARD,
  CANVAS_DEFAULT_COLOR,
  CANVAS_FRAME,
  CANVAS_STEP,
  CANVAS_ZOOM,
  canvasArrangeOps,
  canvasBounds,
  canvasColorTag,
  canvasLayout,
  canvasMoveOps,
  canvasPlaceOps,
  canvasUnplaceOps,
  cellInGroup,
  cellKey,
  collaboratorBadge,
  fitTitle,
  moveCanvasGroupOps,
  nearestFreeCell,
  plural,
  PRIORITY,
  READONLY_LIST_NOTE,
  removeCanvasGroupOps,
  updateCanvasGroupOps,
  withCompleted,
  type CanvasCell,
  type CanvasGroup,
  type TaskOp,
  type TitleFit,
  type ViewContext,
  type ViewTask,
} from "@taskplanner/core";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { listEditable, type AppData, type List, type Tag } from "@/lib/app-data";
import { useAppEnv } from "./app-env";
import { QuickAdd } from "./quick-add";
import { TagColorPicker } from "./tag-chip";
import { useTaskActions } from "./task-item";
import { Button } from "./ui";

// ── Stan widoku na urządzeniu ─────────────────────────────────────────────────────────────────

interface Viewport {
  zoom: number;
  /** Położenie (0, 0) siatki w px względem lewego górnego rogu obszaru. */
  x: number;
  y: number;
}

const VIEW_KEY = "tp-canvas-view";
const DEFAULT_VIEW: Viewport = { zoom: 1, x: 40, y: 48 };

function loadViewport(listId: string): Viewport {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, Viewport>;
    const v = all[listId];
    if (v && Number.isFinite(v.zoom) && Number.isFinite(v.x) && Number.isFinite(v.y)) return { ...v, zoom: clampZoom(v.zoom) };
  } catch {
    // Brak dostępu do localStorage / uszkodzony wpis — widok domyślny.
  }
  return DEFAULT_VIEW;
}

function saveViewport(listId: string, view: Viewport) {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, Viewport>;
    all[listId] = view;
    localStorage.setItem(VIEW_KEY, JSON.stringify(all));
  } catch {
    // Bez zapisu — widok i tak działa.
  }
}

const clampZoom = (zoom: number) => Math.min(CANVAS_ZOOM.max, Math.max(CANVAS_ZOOM.min, zoom));

const subscribeOnline = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};
const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

// ── Tytuł: czcionka dobrana do stałego kształtu karty ─────────────────────────────────────────

const CARD_PAD = 10;
/** Pasek na dole karty (podzadania, odpowiedzialny). */
const CARD_FOOT = 24;
const TITLE_BOX = { width: CANVAS_CARD.width - 2 * CARD_PAD, height: CANVAS_CARD.height - CARD_PAD - CARD_FOOT };
/** Ramka grupy wokół komórek i jej nagłówek (mieści się w odstępie między kartami). */
const GROUP_PAD = 4;
const GROUP_TAB = 18;

let measureContext: CanvasRenderingContext2D | null = null;
const fitCache = new Map<string, TitleFit>();

function titleFit(title: string): TitleFit {
  const cached = fitCache.get(title);
  if (cached) return cached;
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d");
    if (measureContext) measureContext.font = `500 16px ${getComputedStyle(document.body).fontFamily}`;
  }
  const family = getComputedStyle(document.body).fontFamily;
  const measure = (text: string, size: number) => {
    if (!measureContext) return text.length * size * 0.55;
    measureContext.font = `500 ${size}px ${family}`;
    return measureContext.measureText(text).width;
  };
  const fit = fitTitle(title || "…", measure, TITLE_BOX);
  if (fitCache.size > 5000) fitCache.clear();
  fitCache.set(title, fit);
  return fit;
}

// ── Przeciąganie ──────────────────────────────────────────────────────────────────────────────

type Drag =
  | { kind: "cards"; ids: string[]; dx: number; dy: number; moved: boolean }
  | { kind: "pan" }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "tray"; id: string; clientX: number; clientY: number; moved: boolean }
  | { kind: "group"; id: string; dx: number; dy: number; moved: boolean }
  | { kind: "resize"; id: string; dx: number; dy: number };

const MOVE_THRESHOLD = 4;
const cellsOf = (dx: number, dy: number, zoom: number): CanvasCell => ({ col: Math.round(dx / zoom / CANVAS_STEP.x), row: Math.round(dy / zoom / CANVAS_STEP.y) });

/** Przeciąganie po `pointerdown`: ruch i puszczenie przez okno (także poza obszarem). */
function track(start: ReactPointerEvent, onMove: (dx: number, dy: number, e: PointerEvent) => void, onUp: (dx: number, dy: number, e: PointerEvent) => void) {
  const x0 = start.clientX;
  const y0 = start.clientY;
  const move = (e: PointerEvent) => onMove(e.clientX - x0, e.clientY - y0, e);
  const up = (e: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onUp(e.clientX - x0, e.clientY - y0, e);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

const far = (dx: number, dy: number) => Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD;

// ── Widok ─────────────────────────────────────────────────────────────────────────────────────

export function CanvasView({ data, ctx, list }: { data: AppData; ctx: ViewContext; list: List }) {
  const { store, openTask, selectedIds, select } = useAppEnv();
  const { run } = useTaskActions();
  const online = useOnline();
  const canEdit = listEditable(data, list.id);
  const editable = canEdit && online;

  const cards = useMemo(
    () => withCompleted(data.tasks.filter((t) => t.listId === list.id && !t.parentId), list.prefs.completed ?? "today", ctx),
    [data.tasks, list.id, list.prefs.completed, ctx],
  );
  const layout = useMemo(() => canvasLayout(cards), [cards]);
  const groups = list.canvasGroups;
  const tagsById = useMemo(() => new Map(data.tags.map((t) => [t.id, t])), [data.tags]);
  const childCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of data.tasks) if (t.parentId) counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
    return counts;
  }, [data.tasks]);

  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>(() => loadViewport(list.id));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [adding, setAdding] = useState<CanvasCell | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [coloringGroup, setColoringGroup] = useState<string | null>(null);
  // Pełny ekran: obszar karteczek przykrywa aplikację (warstwa `fixed`), a przeglądarka — o ile
  // pozwoli — przechodzi w tryb pełnoekranowy. Dymki „Cofnij” zostają widoczne (są nad warstwą).
  const [full, setFull] = useState(false);
  // Najnowsze dane dla obsługi wskaźnika (zmiany z synchronizacji w trakcie przeciągania).
  const latest = useRef({ layout, groups, view });
  useEffect(() => {
    latest.current = { layout, groups, view };
  }, [layout, groups, view]);
  useEffect(() => saveViewport(list.id, view), [list.id, view]);

  const selected = useMemo(() => new Set(cards.filter((c) => selectedIds.has(c.id)).map((c) => c.id)), [cards, selectedIds]);
  const placedById = useMemo(() => new Map(layout.placed.map((p) => [p.task.id, p])), [layout]);

  const selectOnly = (ids: readonly string[]) => {
    for (const id of selectedIds) if (!ids.includes(id)) select(id, "toggle");
    for (const id of ids) if (!selectedIds.has(id)) select(id, "toggle");
  };

  const apply = async (ops: TaskOp[], text: string, undo?: TaskOp[]) => {
    if (!ops.length) return;
    await run(ops, { text, undo });
    // Praca zespołu na żywo: zmiana od razu na serwer, nie przy następnym cyklu synchronizacji.
    void store.sync().catch(() => undefined);
  };

  // ── Współrzędne ──
  const toWorld = (clientX: number, clientY: number) => {
    const rect = box.current!.getBoundingClientRect();
    const v = latest.current.view;
    return { x: (clientX - rect.left - v.x) / v.zoom, y: (clientY - rect.top - v.y) / v.zoom };
  };
  const cellAt = (clientX: number, clientY: number): CanvasCell => {
    const w = toWorld(clientX, clientY);
    return { col: Math.floor((w.x + CANVAS_CARD.gap / 2) / CANVAS_STEP.x), row: Math.floor((w.y + CANVAS_CARD.gap / 2) / CANVAS_STEP.y) };
  };
  const centerCell = (): CanvasCell => {
    const rect = box.current?.getBoundingClientRect();
    return rect ? cellAt(rect.left + rect.width / 2, rect.top + rect.height / 2) : { col: 0, row: 0 };
  };
  const overTray = (e: PointerEvent) => Boolean(document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-canvas-tray]"));
  const overBoard = (e: PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    return Boolean(rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom);
  };

  // ── Powiększenie ──
  const zoomAt = (factor: number, clientX?: number, clientY?: number) =>
    setView((v) => {
      const zoom = clampZoom(v.zoom * factor);
      const rect = box.current?.getBoundingClientRect();
      const px = clientX !== undefined && rect ? clientX - rect.left : (rect?.width ?? 0) / 2;
      const py = clientY !== undefined && rect ? clientY - rect.top : (rect?.height ?? 0) / 2;
      return { zoom, x: px - (px - v.x) * (zoom / v.zoom), y: py - (py - v.y) * (zoom / v.zoom) };
    });
  const fit = () => {
    const rect = box.current?.getBoundingClientRect();
    const bounds = canvasBounds([...layout.placed.map((p) => p.cell), ...groups.flatMap((g) => [{ col: g.col, row: g.row }, { col: g.col + g.w - 1, row: g.row + g.h - 1 }])]);
    if (!rect || !bounds) return setView(DEFAULT_VIEW);
    const width = bounds.w * CANVAS_STEP.x;
    const height = bounds.h * CANVAS_STEP.y + GROUP_TAB;
    const zoom = clampZoom(Math.min((rect.width - 64) / width, (rect.height - 64) / height, 1));
    setView({ zoom, x: (rect.width - width * zoom) / 2 - bounds.col * CANVAS_STEP.x * zoom, y: (rect.height - height * zoom) / 2 + GROUP_TAB * zoom - bounds.row * CANVAS_STEP.y * zoom });
  };

  // Kółko: przewijanie; Ctrl+kółko (i gest szczypania na touchpadzie) — powiększenie w miejscu kursora.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0025);
        setView((v) => {
          const zoom = clampZoom(v.zoom * factor);
          const rect = el.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          return { zoom, x: px - (px - v.x) * (zoom / v.zoom), y: py - (py - v.y) * (zoom / v.zoom) };
        });
      } else setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Karty ──
  const startCardDrag = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    box.current?.focus({ preventScroll: true });
    if (e.ctrlKey || e.metaKey) return select(id, "toggle");
    if (e.shiftKey) {
      if (!selectedIds.has(id)) select(id, "toggle");
      return;
    }
    const ids = selected.has(id) ? [...selected] : [id];
    if (!selected.has(id)) select(id, "only");
    if (!editable) return;
    track(
      e,
      (dx, dy) => setDrag({ kind: "cards", ids, dx, dy, moved: far(dx, dy) }),
      (dx, dy, up) => {
        setDrag(null);
        if (!far(dx, dy)) return;
        const { layout: now, view: v } = latest.current;
        const moving = ids.flatMap((cardId) => {
          const placed = now.placed.find((p) => p.task.id === cardId);
          return placed ? [{ id: cardId, cell: placed.cell, saved: placed.task.canvasPos ?? null }] : [];
        });
        if (overTray(up)) {
          const { ops, undo } = canvasUnplaceOps(moving);
          return void apply(ops, ops.length === 1 ? "Odłożono do „Do ułożenia”" : `Odłożono ${plural(ops.length, ["karteczkę", "karteczki", "karteczek"])}`, undo);
        }
        const { ops, undo } = canvasMoveOps(now, moving, cellsOf(dx, dy, v.zoom));
        void apply(ops, ops.length === 1 ? "Przesunięto karteczkę" : `Przesunięto ${plural(ops.length, ["karteczkę", "karteczki", "karteczek"])}`, undo);
      },
    );
  };

  const startTrayDrag = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) return select(id, "toggle");
    select(id, "only");
    if (!editable) return;
    e.preventDefault();
    track(
      e,
      (dx, dy, move) => setDrag({ kind: "tray", id, clientX: move.clientX, clientY: move.clientY, moved: far(dx, dy) }),
      (dx, dy, up) => {
        setDrag(null);
        if (!far(dx, dy) || !overBoard(up) || overTray(up)) return;
        const { ops, undo } = canvasPlaceOps(latest.current.layout, id, cellAt(up.clientX, up.clientY));
        void apply(ops, "Położono karteczkę", undo);
      },
    );
  };

  // ── Tło: przesuwanie widoku, zaznaczanie ramką (Shift), dwuklik = nowa karteczka ──
  const startBackground = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    box.current?.focus({ preventScroll: true });
    if (e.shiftKey && e.button === 0) {
      const w0 = toWorld(e.clientX, e.clientY);
      track(
        e,
        (_dx, _dy, move) => {
          const w = toWorld(move.clientX, move.clientY);
          setDrag({ kind: "marquee", x0: w0.x, y0: w0.y, x1: w.x, y1: w.y });
        },
        (_dx, _dy, up) => {
          setDrag(null);
          const w = toWorld(up.clientX, up.clientY);
          const [left, right] = [Math.min(w0.x, w.x), Math.max(w0.x, w.x)];
          const [top, bottom] = [Math.min(w0.y, w.y), Math.max(w0.y, w.y)];
          const hit = latest.current.layout.placed.filter((p) => {
            const x = p.cell.col * CANVAS_STEP.x;
            const y = p.cell.row * CANVAS_STEP.y;
            return x < right && x + CANVAS_CARD.width > left && y < bottom && y + CANVAS_CARD.height > top;
          });
          selectOnly([...new Set([...selected, ...hit.map((p) => p.task.id)])]);
        },
      );
      return;
    }
    const start = latest.current.view;
    track(
      e,
      (dx, dy) => {
        setDrag({ kind: "pan" });
        setView((v) => ({ ...v, x: start.x + dx, y: start.y + dy }));
      },
      (dx, dy) => {
        setDrag(null);
        if (!far(dx, dy)) selectOnly([]);
      },
    );
  };

  const startAdding = (target: CanvasCell) => {
    if (!editable) return;
    setAdding(nearestFreeCell(layout.occupied, target));
  };

  // ── Grupy ──
  const groupAround = () => {
    const cells = [...selected].flatMap((id) => {
      const p = placedById.get(id);
      return p ? [p.cell] : [];
    });
    const bounds = canvasBounds(cells) ?? { ...centerCell(), w: 3, h: 2 };
    const { ops, undo, id } = addCanvasGroupOps(list.id, groups, bounds, { name: "Grupa" });
    void apply(ops, "Dodano grupę", undo);
    setEditingGroup(id);
  };

  const startGroupDrag = (e: ReactPointerEvent, group: CanvasGroup, kind: "group" | "resize") => {
    if (e.button !== 0 || !editable) return;
    e.stopPropagation();
    e.preventDefault();
    track(
      e,
      (dx, dy) => setDrag(kind === "group" ? { kind, id: group.id, dx, dy, moved: far(dx, dy) } : { kind, id: group.id, dx, dy }),
      (dx, dy) => {
        setDrag(null);
        if (!far(dx, dy)) return;
        const { layout: now, groups: current, view: v } = latest.current;
        const delta = cellsOf(dx, dy, v.zoom);
        if (kind === "group") {
          const { ops, undo } = moveCanvasGroupOps(list.id, current, group.id, now, delta);
          void apply(ops, "Przesunięto grupę", undo);
        } else {
          const { ops, undo } = updateCanvasGroupOps(list.id, current, group.id, { w: group.w + delta.col, h: group.h + delta.row });
          void apply(ops, "Zmieniono rozmiar grupy", undo);
        }
      },
    );
  };

  // ── Klawiatura (Enter, Esc, E, T, 1–4, Delete działają z `shell.tsx` na zaznaczonych kartach) ──
  const enterFull = () => {
    setFull(true);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };
  const exitFull = () => {
    setFull(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  // Esc w trybie pełnoekranowym przeglądarki zamyka go sam — wtedy wraca też zwykły układ.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  // Panel zadania jest poza obszarem karteczek — otwarcie zadania wychodzi z pełnego ekranu.
  const open = (id: string | null) => {
    if (full) exitFull();
    openTask(id);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" && full && !adding && !editingGroup) {
      e.preventDefault();
      return exitFull();
    }
    // Pozostałe skróty tylko na samej tablicy (nie w polach nazwy grupy / nowej karteczki).
    if (e.target !== box.current) return;
    const arrows: Record<string, CanvasCell> = { ArrowLeft: { col: -1, row: 0 }, ArrowRight: { col: 1, row: 0 }, ArrowUp: { col: 0, row: -1 }, ArrowDown: { col: 0, row: 1 } };
    const ctrl = e.ctrlKey || e.metaKey;
    if (arrows[e.key] && selected.size) {
      e.preventDefault();
      if (!editable) return;
      const moving = [...selected].flatMap((id) => {
        const p = placedById.get(id);
        return p ? [{ id, cell: p.cell, saved: p.task.canvasPos ?? null }] : [];
      });
      const { ops, undo } = canvasMoveOps(layout, moving, arrows[e.key]!);
      void apply(ops, "Przesunięto", undo);
    } else if (ctrl && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectOnly(layout.placed.map((p) => p.task.id));
    } else if (!ctrl && !e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      startAdding(centerCell());
    } else if (!ctrl && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      zoomAt(CANVAS_ZOOM.step);
    } else if (!ctrl && e.key === "-") {
      e.preventDefault();
      zoomAt(1 / CANVAS_ZOOM.step);
    } else if (!ctrl && e.key === "0") {
      e.preventDefault();
      zoomAt(1 / view.zoom);
    }
  };

  // ── Podgląd przeciągania ──
  const cardDelta = drag?.kind === "cards" && drag.moved ? { x: drag.dx / view.zoom, y: drag.dy / view.zoom } : null;
  const dragging = drag?.kind === "cards" && drag.moved ? new Set(drag.ids) : null;
  const preview = useMemo(() => {
    if (drag?.kind === "cards" && drag.moved) {
      const moving = drag.ids.flatMap((id) => {
        const p = placedById.get(id);
        return p ? [{ id, cell: p.cell, saved: p.task.canvasPos ?? null }] : [];
      });
      const { delta } = canvasMoveOps(layout, moving, cellsOf(drag.dx, drag.dy, view.zoom));
      return moving.map((m) => ({ col: m.cell.col + delta.col, row: m.cell.row + delta.row }));
    }
    if (drag?.kind === "group" && drag.moved) {
      const group = groups.find((g) => g.id === drag.id);
      if (!group) return [];
      const inside = layout.placed.filter((p) => cellInGroup(p.cell, group));
      const { delta } = canvasMoveOps(layout, inside.map((p) => ({ id: p.task.id, cell: p.cell, saved: p.task.canvasPos ?? null })), cellsOf(drag.dx, drag.dy, view.zoom));
      return inside.map((p) => ({ col: p.cell.col + delta.col, row: p.cell.row + delta.row }));
    }
    return [];
  }, [drag, placedById, layout, groups, view.zoom]);
  const groupDrag = drag?.kind === "group" && drag.moved ? drag : null;
  const groupMovesCard = (cell: CanvasCell) => {
    const group = groupDrag && groups.find((g) => g.id === groupDrag.id);
    return group ? cellInGroup(cell, group) : false;
  };

  const showText = view.zoom >= CANVAS_ZOOM.textMin;
  const legend = useMemo(() => {
    const seen = new Map<string, Tag>();
    let plain = 0;
    for (const p of layout.placed) {
      const tag = canvasColorTag(p.task, tagsById);
      if (tag) seen.set(tag.id, tag);
      else plain++;
    }
    return { tags: [...seen.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)), plain };
  }, [layout, tagsById]);

  const note = !canEdit ? READONLY_LIST_NOTE : !online ? "Karteczki wymagają połączenia — bez sieci tylko podgląd." : null;

  return (
    <div className={full ? "fixed inset-0 z-[25] flex flex-col gap-2 bg-[var(--background)] p-3" : "flex flex-col gap-2"} onKeyDown={onKeyDown} data-testid="canvas-view" data-full={full || undefined}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {full ? <span className="mr-1 text-sm font-semibold">{list.name}</span> : null}
        <Button className="py-1 text-xs" disabled={!editable} onClick={() => startAdding(centerCell())} title="Nowa karteczka (N, dwuklik w puste miejsce)">
          + Karteczka
        </Button>
        <Button className="py-1 text-xs" disabled={!editable} onClick={groupAround} title={selected.size ? "Ramka wokół zaznaczonych karteczek" : "Nowa ramka na środku widoku"}>
          ▢ Grupuj
        </Button>
        <span className="flex-1" />
        <span className="hidden text-[var(--muted)] lg:inline">Dwuklik — nowa · Shift+przeciąganie — zaznaczanie · Ctrl+kółko — powiększenie</span>
        <div className="flex items-center overflow-hidden rounded-md border border-[var(--line)]" role="group" aria-label="Powiększenie">
          <button type="button" className="px-2 py-1 hover:bg-[var(--hover)]" onClick={() => zoomAt(1 / CANVAS_ZOOM.step)} aria-label="Pomniejsz" title="Pomniejsz (−)">
            −
          </button>
          <button type="button" className="min-w-12 px-2 py-1 tabular-nums hover:bg-[var(--hover)]" onClick={() => zoomAt(1 / view.zoom)} title="100 % (0)" data-testid="canvas-zoom">
            {Math.round(view.zoom * 100)} %
          </button>
          <button type="button" className="px-2 py-1 hover:bg-[var(--hover)]" onClick={() => zoomAt(CANVAS_ZOOM.step)} aria-label="Powiększ" title="Powiększ (+)">
            +
          </button>
          <button type="button" className="border-l border-[var(--line)] px-2 py-1 hover:bg-[var(--hover)]" onClick={fit}>
            Dopasuj
          </button>
        </div>
        <Button className="py-1 text-xs" onClick={full ? exitFull : enterFull} title={full ? "Zamknij pełny ekran (Esc)" : "Karteczki na cały ekran"} data-testid="canvas-full">
          {full ? "✕ Zamknij pełny ekran" : "⛶ Pełny ekran"}
        </Button>
      </div>
      {note ? (
        <p className="rounded-md bg-amber-100 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" data-testid="canvas-note">
          {note}
        </p>
      ) : null}
      <div className={`flex gap-2 ${full ? "min-h-0 flex-1" : "h-[calc(100vh-12rem)] min-h-80"}`}>
        <div
          ref={box}
          tabIndex={0}
          role="application"
          aria-label={`Karteczki listy „${list.name}”`}
          className={`relative min-w-0 flex-1 touch-none overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--background)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${drag?.kind === "pan" ? "cursor-grabbing" : ""}`}
          style={{
            backgroundImage: "radial-gradient(circle, var(--line) 1.2px, transparent 1.3px)",
            backgroundSize: `${CANVAS_STEP.x * view.zoom}px ${CANVAS_STEP.y * view.zoom}px`,
            backgroundPosition: `${view.x - (CANVAS_CARD.gap / 2) * view.zoom}px ${view.y - (CANVAS_CARD.gap / 2) * view.zoom}px`,
          }}
          onPointerDown={startBackground}
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest("[data-canvas-card], [data-canvas-group-tab], [data-canvas-add]")) startAdding(cellAt(e.clientX, e.clientY));
          }}
          data-testid="canvas-board"
        >
          <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            {groups.map((group) => (
              <GroupFrame
                key={group.id}
                group={group}
                offset={groupDrag?.id === group.id ? { x: groupDrag.dx / view.zoom, y: groupDrag.dy / view.zoom } : null}
                resize={drag?.kind === "resize" && drag.id === group.id ? cellsOf(drag.dx, drag.dy, view.zoom) : null}
                editable={editable}
                editing={editingGroup === group.id}
                coloring={coloringGroup === group.id}
                onStartDrag={(e, kind) => startGroupDrag(e, group, kind)}
                onEdit={(on) => setEditingGroup(on ? group.id : null)}
                onColoring={(on) => setColoringGroup(on ? group.id : null)}
                onRename={(name) => {
                  setEditingGroup(null);
                  if (name.trim() !== group.name) void apply(updateCanvasGroupOps(list.id, groups, group.id, { name }).ops, "Zmieniono nazwę grupy");
                }}
                onColor={(color) => {
                  setColoringGroup(null);
                  const { ops, undo } = updateCanvasGroupOps(list.id, groups, group.id, { color });
                  void apply(ops, "Zmieniono kolor grupy", undo);
                }}
                onRemove={() => {
                  const { ops, undo } = removeCanvasGroupOps(list.id, groups, group.id);
                  void apply(ops, `Usunięto grupę „${group.name || "bez nazwy"}” (karteczki zostają)`, undo);
                }}
              />
            ))}
            {preview.map((cell) => (
              <div
                key={`p-${cellKey(cell)}`}
                className="absolute rounded border-2 border-dashed border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                style={{ left: cell.col * CANVAS_STEP.x, top: cell.row * CANVAS_STEP.y, width: CANVAS_CARD.width, height: CANVAS_CARD.height }}
              />
            ))}
            {layout.placed.map((p) => {
              const offset = dragging?.has(p.task.id) ? cardDelta : groupDrag && groupMovesCard(p.cell) ? { x: groupDrag.dx / view.zoom, y: groupDrag.dy / view.zoom } : null;
              return (
                <Card
                  key={p.task.id}
                  task={p.task}
                  cell={p.cell}
                  displaced={p.displaced}
                  selected={selected.has(p.task.id)}
                  color={canvasColorTag(p.task, tagsById)?.color ?? CANVAS_DEFAULT_COLOR}
                  assignee={assigneeOf(p.task.assigneeId, data.collaborators)}
                  childCount={childCount.get(p.task.id) ?? 0}
                  showText={showText}
                  offset={offset}
                  editable={editable}
                  onPointerDown={startCardDrag}
                  onOpen={open}
                />
              );
            })}
            {adding ? (
              <div
                className="absolute z-20 rounded-md border border-[var(--accent)] bg-[var(--surface)] p-2 shadow-lg"
                style={{ left: adding.col * CANVAS_STEP.x, top: adding.row * CANVAS_STEP.y, width: CANVAS_STEP.x * 2 - CANVAS_CARD.gap }}
                onPointerDown={(e) => e.stopPropagation()}
                data-canvas-add
              >
                <QuickAdd
                  key={cellKey(adding)}
                  listId={list.id}
                  defaults={{ canvasPos: adding }}
                  placeholder="Nowa karteczka — Enter dodaje, Esc zamyka"
                  autoFocus
                  onAdded={(more) => {
                    if (!more) return setAdding(null);
                    // Ctrl+Enter — następna karteczka obok.
                    const taken = new Set(layout.occupied);
                    taken.add(cellKey(adding));
                    setAdding(nearestFreeCell(taken, { col: adding.col + 1, row: adding.row }));
                  }}
                  onCancel={() => setAdding(null)}
                />
              </div>
            ) : null}
            {drag?.kind === "marquee" ? (
              <div
                className="absolute border border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
                style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }}
              />
            ) : null}
          </div>
          {!layout.placed.length && !adding ? (
            <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-[var(--muted)]">
              {layout.tray.length ? "Przeciągnij karteczki z paska „Do ułożenia” albo kliknij „Ułóż wszystkie”." : editable ? "Kliknij dwukrotnie, aby dodać pierwszą karteczkę." : "Brak karteczek."}
            </p>
          ) : null}
          {legend.tags.length ? (
            <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[70%] flex-wrap gap-x-3 gap-y-1 rounded-md bg-[var(--surface)]/90 px-2 py-1 text-[11px] shadow-sm" data-testid="canvas-legend">
              {legend.tags.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: t.color ?? undefined }} />@{t.name}
                </span>
              ))}
              {legend.plain ? (
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: CANVAS_DEFAULT_COLOR }} />
                  bez kolorowego tagu
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <aside
          className={`flex w-56 shrink-0 flex-col rounded-lg border border-[var(--line)] bg-[var(--surface)] ${drag?.kind === "cards" && drag.moved ? "ring-2 ring-[var(--accent)]/40" : ""}`}
          data-canvas-tray
          data-testid="canvas-tray"
          aria-label="Do ułożenia"
        >
          <div className="flex items-center gap-2 whitespace-nowrap border-b border-[var(--line)] px-3 py-2 text-xs">
            <span className="font-medium">Do ułożenia</span>
            <span className="text-[var(--muted)]">{layout.tray.length}</span>
            <span className="flex-1" />
            {layout.tray.length && editable ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[var(--accent)] hover:bg-[var(--hover)]"
                onClick={() => {
                  const { ops, undo } = canvasArrangeOps(layout);
                  void apply(ops, `Ułożono ${plural(ops.length, ["karteczkę", "karteczki", "karteczek"])}`, undo);
                }}
              >
                Ułóż wszystkie
              </button>
            ) : null}
          </div>
          <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
            {layout.tray.map((task) => (
              <li
                key={task.id}
                data-task-id={task.id}
                className={`cursor-grab select-none rounded px-2 py-1.5 text-xs ${selected.has(task.id) ? "ring-2 ring-[var(--accent)]" : ""} ${drag?.kind === "tray" && drag.id === task.id && drag.moved ? "opacity-40" : ""}`}
                style={{ ...frameStyle(task), background: `color-mix(in srgb, ${canvasColorTag(task, tagsById)?.color ?? CANVAS_DEFAULT_COLOR} 30%, var(--surface))` }}
                onPointerDown={(e) => startTrayDrag(e, task.id)}
                onDoubleClick={() => open(task.id)}
                title={editable ? "Przeciągnij na tablicę · dwuklik otwiera zadanie" : "Dwuklik otwiera zadanie"}
              >
                <span className="line-clamp-2 break-words">{task.title}</span>
              </li>
            ))}
            {!layout.tray.length ? <li className="px-1 text-xs text-[var(--muted)]">Wszystkie karteczki leżą na tablicy. Przeciągnij tu kartę, aby ją odłożyć.</li> : null}
          </ul>
        </aside>
      </div>
      {drag?.kind === "tray" && drag.moved ? (
        <div
          className="pointer-events-none fixed z-50 rounded px-2 py-1.5 text-xs shadow-lg"
          style={{ left: drag.clientX + 8, top: drag.clientY + 8, width: CANVAS_CARD.width * Math.min(1, view.zoom), ...frameStyle(cards.find((c) => c.id === drag.id)), background: "var(--surface)" }}
        >
          {cards.find((c) => c.id === drag.id)?.title}
        </div>
      ) : null}
      <p className="text-[11px] text-[var(--muted)]">
        {plural(layout.placed.length, ["karteczka", "karteczki", "karteczek"])} na tablicy · kolor = pierwszy kolorowy tag zadania (kolejność tagów zmienisz w panelu zadania) · ramka = priorytet
      </p>
    </div>
  );
}

function frameStyle(task: Pick<ViewTask, "priority"> | undefined) {
  const priority = task?.priority ?? 4;
  const frame = CANVAS_FRAME[priority];
  return { borderStyle: frame.style, borderWidth: frame.width, borderColor: PRIORITY[priority].color };
}

// ── Karta ─────────────────────────────────────────────────────────────────────────────────────

const Card = memo(function Card({
  task,
  cell,
  displaced,
  selected,
  color,
  assignee,
  childCount,
  showText,
  offset,
  editable,
  onPointerDown,
  onOpen,
}: {
  task: ViewTask;
  cell: CanvasCell;
  displaced: boolean;
  selected: boolean;
  color: string;
  assignee: { id: string; name: string; acronym?: string | null } | null;
  childCount: number;
  showText: boolean;
  offset: { x: number; y: number } | null;
  editable: boolean;
  onPointerDown: (e: ReactPointerEvent, id: string) => void;
  onOpen: (id: string) => void;
}) {
  const fit = showText ? titleFit(task.title) : null;
  const closed = task.status === "done" || task.status === "cancelled";
  return (
    <div
      data-canvas-card
      data-task-id={task.id}
      role="button"
      aria-label={`${task.title} — ${PRIORITY[task.priority].label.toLowerCase()} priorytet${assignee ? `, ${assignee.name}` : ""}`}
      aria-pressed={selected}
      title={`${task.title}${displaced ? "\n(pokazana obok — ktoś położył kartę w tym samym miejscu)" : ""}`}
      className={`absolute flex select-none flex-col overflow-hidden rounded-[3px] shadow-sm transition-shadow ${editable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${selected ? "z-10 shadow-md outline outline-2 outline-offset-2 outline-[var(--accent)]" : ""} ${offset ? "z-20 opacity-80 shadow-xl" : ""} ${closed ? "opacity-50" : ""}`}
      style={{
        left: cell.col * CANVAS_STEP.x,
        top: cell.row * CANVAS_STEP.y,
        width: CANVAS_CARD.width,
        height: CANVAS_CARD.height,
        padding: `${CARD_PAD}px ${CARD_PAD}px 0`,
        background: `color-mix(in srgb, ${color} 38%, var(--surface))`,
        transform: offset ? `translate(${offset.x}px, ${offset.y}px) rotate(1.5deg)` : undefined,
        ...frameStyle(task),
        // Ramka wewnątrz stałego kształtu karty (grubsza ramka nie powiększa karty).
        boxSizing: "border-box",
      }}
      onPointerDown={(e) => onPointerDown(e, task.id)}
      onDoubleClick={() => onOpen(task.id)}
    >
      {fit ? (
        <div className={`min-h-0 flex-1 font-medium ${closed ? "line-through" : ""}`} style={{ fontSize: fit.size, lineHeight: 1.2 }}>
          {fit.lines.map((line, i) => (
            <div key={i} className="whitespace-nowrap">
              {line}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex h-6 shrink-0 items-center gap-1 text-[11px] text-[var(--muted)]">
        {childCount && showText ? <span title={`Podzadania: ${childCount}`}>↳ {childCount}</span> : null}
        <span className="flex-1" />
        {assignee ? (
          <span
            title={`Odpowiedzialny: ${assignee.name}`}
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-600 px-1 text-[10px] font-semibold text-white dark:bg-sky-500"
            data-testid="canvas-assignee"
          >
            {collaboratorBadge(assignee)}
          </span>
        ) : null}
      </div>
    </div>
  );
});

// ── Grupa ─────────────────────────────────────────────────────────────────────────────────────

function GroupFrame({
  group,
  offset,
  resize,
  editable,
  editing,
  coloring,
  onStartDrag,
  onEdit,
  onColoring,
  onRename,
  onColor,
  onRemove,
}: {
  group: CanvasGroup;
  offset: { x: number; y: number } | null;
  resize: CanvasCell | null;
  editable: boolean;
  editing: boolean;
  coloring: boolean;
  onStartDrag: (e: ReactPointerEvent, kind: "group" | "resize") => void;
  onEdit: (on: boolean) => void;
  onColoring: (on: boolean) => void;
  onRename: (name: string) => void;
  onColor: (color: string | null) => void;
  onRemove: () => void;
}) {
  const w = Math.max(1, group.w + (resize?.col ?? 0));
  const h = Math.max(1, group.h + (resize?.row ?? 0));
  const color = group.color ?? "var(--muted)";
  return (
    <div
      className="absolute rounded-lg border-2"
      data-canvas-group={group.id}
      style={{
        left: group.col * CANVAS_STEP.x - GROUP_PAD,
        top: group.row * CANVAS_STEP.y - GROUP_PAD,
        width: w * CANVAS_STEP.x - CANVAS_CARD.gap + 2 * GROUP_PAD,
        height: h * CANVAS_STEP.y - CANVAS_CARD.gap + 2 * GROUP_PAD,
        borderColor: `color-mix(in srgb, ${color} 75%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        transform: offset ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
      }}
    >
      <div
        data-canvas-group-tab
        className={`absolute left-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-t-md px-1.5 text-[11px] font-medium ${editable ? "cursor-move" : ""}`}
        style={{ top: -GROUP_TAB - 2, height: GROUP_TAB, background: `color-mix(in srgb, ${color} 25%, var(--surface))` }}
        onPointerDown={(e) => (editing ? e.stopPropagation() : onStartDrag(e, "group"))}
        onDoubleClick={() => editable && onEdit(true)}
      >
        {editable ? (
          <button
            type="button"
            aria-label={`Kolor grupy ${group.name}`}
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-current"
            style={{ background: group.color ?? "transparent" }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onColoring(!coloring)}
          />
        ) : null}
        {editing ? (
          <input
            autoFocus
            defaultValue={group.name}
            maxLength={60}
            aria-label="Nazwa grupy"
            className="w-32 bg-transparent text-[11px] outline-none"
            onFocus={(e) => e.target.select()}
            onBlur={(e) => onRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") onEdit(false);
            }}
          />
        ) : (
          <span className="truncate" title={editable ? "Przeciągnij, aby przesunąć grupę z karteczkami · dwuklik zmienia nazwę" : undefined}>
            {group.name || "Grupa"}
          </span>
        )}
        {editable && !editing ? (
          <button type="button" aria-label={`Usuń grupę ${group.name}`} title="Usuń grupę (karteczki zostają)" className="opacity-60 hover:opacity-100" onPointerDown={(e) => e.stopPropagation()} onClick={onRemove}>
            ✕
          </button>
        ) : null}
      </div>
      {coloring ? (
        <div className="absolute left-2 z-30 rounded-md border border-[var(--line)] bg-[var(--surface)] p-2 shadow-lg" style={{ top: 2 }} onPointerDown={(e) => e.stopPropagation()}>
          <TagColorPicker value={group.color} label={`Kolor grupy ${group.name}`} onChange={onColor} />
        </div>
      ) : null}
      {editable ? (
        <div
          aria-hidden
          title="Przeciągnij, aby zmienić rozmiar grupy"
          className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm border-2 bg-[var(--surface)]"
          style={{ borderColor: `color-mix(in srgb, ${color} 70%, transparent)` }}
          onPointerDown={(e) => onStartDrag(e, "resize")}
        />
      ) : null}
    </div>
  );
}
