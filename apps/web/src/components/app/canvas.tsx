"use client";

/**
 * Widok „Karteczki” (v1.x): zadania listy jako karteczki na stole — burza mózgów zespołu. Logika
 * (siatka, wolne komórki, kolizje, grupy, dopasowanie tytułu) w core `canvas.ts`; tu rysowanie,
 * przeciąganie i powiększenie. Bez sieci widok jest tylko do odczytu (praca zespołu na żywo).
 */
import {
  addCanvasGroupOps,
  addDependencyOps,
  addDerivedLinkOps,
  assigneeOf,
  CANVAS_ARROW,
  CANVAS_CARD,
  CANVAS_DEFAULT_COLOR,
  CANVAS_FRAME,
  CANVAS_STEP,
  CANVAS_ZOOM,
  canvasArrangeOps,
  canvasArrowHead,
  canvasArrows,
  canvasArrowSegment,
  canvasBounds,
  canvasCardRect,
  canvasColorTag,
  canvasLayout,
  canvasMoveOps,
  canvasPlaceOps,
  canvasSubtaskProgress,
  canvasTasks,
  canvasUnplaceOps,
  CANVAS_TASKS,
  cellInGroup,
  clampCanvasZoom,
  cellKey,
  collaboratorBadge,
  dependencyErrorText,
  derivedLinkErrorText,
  fitTitle,
  moveCanvasGroupOps,
  nearestFreeCell,
  plural,
  PRIORITY,
  READONLY_LIST_NOTE,
  removeCanvasGroupOps,
  removeDependencyOps,
  removeDerivedLinkOps,
  updateCanvasGroupOps,
  violations,
  withCompleted,
  zoomCanvasViewport,
  type CanvasArrow,
  type CanvasArrowKind,
  type CanvasCell,
  type CanvasLinkKind,
  type CanvasSegment,
  type CanvasTasks,
  type CanvasViewport,
  type CanvasGroup,
  type TaskOp,
  type TitleFit,
  type ViewContext,
  type Collaborator,
  type ViewTask,
} from "@taskplanner/core";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { listEditable, type AppData, type List, type Tag } from "@/lib/app-data";
import { useDependencies } from "@/lib/dependencies";
import { useAppEnv } from "./app-env";
import { CanvasExportButton } from "./canvas-export";
import { QuickAdd } from "./quick-add";
import { TagColorPicker } from "./tag-chip";
import { useTaskActions } from "./task-item";
import { Button } from "./ui";

// ── Stan widoku na urządzeniu ─────────────────────────────────────────────────────────────────

type Viewport = CanvasViewport;

const VIEW_KEY = "tp-canvas-view";
const DEFAULT_VIEW: Viewport = { zoom: 1, x: 40, y: 48 };

function loadViewport(listId: string): Viewport {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, Viewport>;
    const v = all[listId];
    if (v && Number.isFinite(v.zoom) && Number.isFinite(v.x) && Number.isFinite(v.y)) return { ...v, zoom: clampCanvasZoom(v.zoom) };
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
/** Pasek na dole karty (podzadania, odpowiedzialny): 20 px treści + 8 px nad zagiętym rogiem. */
const CARD_FOOT = 28;
const TITLE_BOX = { width: CANVAS_CARD.width - 2 * CARD_PAD, height: CANVAS_CARD.height - CARD_PAD - CARD_FOOT };
/**
 * Ramka grupy: odstęp od karteczek (mniej niż pół odstępu między kartami, więc ramki sąsiednich grup
 * się nie stykają) i wysokość nagłówka, który leży na górnej krawędzi ramki (mieści się w odstępie).
 */
const GROUP_PAD = 10;
const GROUP_TAB = 18;
/** Zagięty róg karteczki (prawy dolny, px przy 100 %). */
const CARD_FOLD = 18;
/** Cień karty (filtr, więc idzie za kształtem z zagiętym rogiem): leży / zaznaczona / w ręku. */
const CARD_SHADOW = {
  rest: "drop-shadow(0 1px 1px rgb(0 0 0 / 0.22)) drop-shadow(0 3px 5px rgb(0 0 0 / 0.12))",
  selected: "drop-shadow(0 2px 2px rgb(0 0 0 / 0.25)) drop-shadow(0 6px 10px rgb(0 0 0 / 0.16))",
  lifted: "drop-shadow(0 6px 6px rgb(0 0 0 / 0.22)) drop-shadow(0 16px 24px rgb(0 0 0 / 0.22))",
} as const;
/** Przód karteczki: kolor + światło z lewego górnego rogu i lekkie wygięcie u dołu (3D). */
const CARD_FACE = [
  "linear-gradient(135deg, rgb(255 255 255 / 0.35) 0%, rgb(255 255 255 / 0) 45%)",
  "linear-gradient(to bottom, rgb(0 0 0 / 0) 65%, rgb(0 0 0 / 0.09) 100%)",
  "color-mix(in srgb, var(--card-color) 38%, var(--surface))",
].join(", ");
/** Przód karteczki bez prawego dolnego rogu (miejsce na zagięcie). */
const CARD_CLIP = `polygon(0 0, 100% 0, 100% calc(100% - ${CARD_FOLD}px), calc(100% - ${CARD_FOLD}px) 100%, 0 100%)`;

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
  | { kind: "resize"; id: string; dx: number; dy: number }
  /** Rysowanie strzałki z uchwytu karty: koniec szkicu w px tablicy, karta pod kursorem. */
  | { kind: "link"; fromId: string; x: number; y: number; overId: string | null };

/** Karta pod wskaźnikiem (id zadania) — cel strzałki. */
const cardIdAt = (e: PointerEvent) => document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-canvas-card]")?.getAttribute("data-task-id") ?? null;

const MOVE_THRESHOLD = 4;
const cellsOf = (dx: number, dy: number, zoom: number): CanvasCell => ({ col: Math.round(dx / zoom / CANVAS_STEP.x), row: Math.round(dy / zoom / CANVAS_STEP.y) });

/**
 * Przeciąganie po `pointerdown`: ruch i puszczenie przez okno (także poza obszarem). Tylko ten sam
 * wskaźnik — drugi palec na ekranie dotykowym to szczypanie, nie drugie przeciąganie.
 */
function track(start: ReactPointerEvent, onMove: (dx: number, dy: number, e: PointerEvent) => void, onUp: (dx: number, dy: number, e: PointerEvent) => void) {
  const x0 = start.clientX;
  const y0 = start.clientY;
  const id = start.pointerId;
  const move = (e: PointerEvent) => {
    if (e.pointerId === id) onMove(e.clientX - x0, e.clientY - y0, e);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
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
  const { run, notify } = useTaskActions();
  const online = useOnline();
  const canEdit = listEditable(data, list.id);
  const editable = canEdit && online;

  // „Tylko główne / Z podzadaniami” — `view_prefs.canvasTasks` listy (jak „Ukończone”); na liście
  // tylko do odczytu (gość bez edycji nie zapisze preferencji) wybór trzyma sama karta przeglądarki.
  const [localShow, setLocalShow] = useState<CanvasTasks | null>(null);
  const show: CanvasTasks = (canEdit ? null : localShow) ?? list.prefs.canvasTasks ?? "top";
  const setShow = (next: CanvasTasks) => {
    if (!canEdit) return setLocalShow(next);
    const prefs = { ...list.prefs };
    delete prefs.canvasTasks;
    if (next !== "top") prefs.canvasTasks = next;
    void store.mutate("lists", list.id, { view_prefs: prefs }).catch((e: unknown) => notify(String(e)));
  };

  const cards = useMemo(
    () => withCompleted(canvasTasks(data.tasks, list.id, show), list.prefs.completed ?? "today", ctx),
    [data.tasks, list.id, show, list.prefs.completed, ctx],
  );
  const layout = useMemo(() => canvasLayout(cards), [cards]);
  const groups = list.canvasGroups;
  const tagsById = useMemo(() => new Map(data.tags.map((t) => [t.id, t])), [data.tags]);
  const subtasks = useMemo(() => canvasSubtaskProgress(data.tasks), [data.tasks]);
  const titles = useMemo(() => new Map(data.tasks.map((t) => [t.id, t.title])), [data.tasks]);
  const quoted = useCallback((id: string) => `„${titles.get(id) ?? "?"}”`, [titles]);

  // Strzałki: „blokuje” = zależności (te same co na osi czasu i w panelu), „wynika z” = `tasks.derived_from`.
  const deps = useDependencies(store);
  const violated = useMemo(() => new Set(violations(data.tasks, deps).map((v) => v.dependency.id)), [data.tasks, deps]);
  const links = useMemo(() => canvasArrows(new Set(layout.placed.map((p) => p.task.id)), data.tasks, deps, violated), [layout, data.tasks, deps, violated]);
  // „⇢ N” na karcie: połączenia z kartami, których nie ma na tablicy (tekst = tytuły do dymka).
  const offBoard = useMemo(() => new Map([...links.offBoard].map(([id, others]) => [id, others.map((o) => titles.get(o) ?? "?").join("\n")])), [links, titles]);

  // Osoby na karcie: odpowiedzialny (pełny znaczek) i uczestnicy (obrys) — te same obiekty między
  // przerysowaniami, żeby `memo` kart działało.
  const people = useMemo(() => {
    const map = new Map<string, { assignee: Collaborator | null; participants: Collaborator[] }>();
    for (const t of data.tasks) {
      if (t.listId !== list.id) continue;
      const assignee = assigneeOf(t.assigneeId, data.collaborators);
      const participants = (data.participants.get(t.id) ?? []).filter((id) => id !== t.assigneeId).flatMap((id) => assigneeOf(id, data.collaborators) ?? []);
      if (assignee || participants.length) map.set(t.id, { assignee, participants });
    }
    return map;
  }, [data.tasks, list.id, data.collaborators, data.participants]);

  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>(() => loadViewport(list.id));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [adding, setAdding] = useState<CanvasCell | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  // Nazwa wpisana, zanim nowa grupa pojawi się na tablicy (zapis lokalny trwa chwilę) — bez tego
  // pierwsze litery trafiały do skrótów aplikacji, a Enter otwierał panel zadania.
  const [groupDraft, setGroupDraft] = useState<{ text: string; commit: boolean } | null>(null);
  const [coloringGroup, setColoringGroup] = useState<string | null>(null);
  // Pełny ekran: obszar karteczek przykrywa aplikację (warstwa `fixed`), a przeglądarka — o ile
  // pozwoli — przechodzi w tryb pełnoekranowy. Dymki „Cofnij” zostają widoczne (są nad warstwą).
  const [full, setFull] = useState(false);
  const [spacePan, setSpacePan] = useState(false);
  // Strzałki: zaznaczona (klucz `CanvasArrow.key`), menu rodzaju po upuszczeniu, ostatnio wybrany rodzaj.
  const [selectedArrow, setSelectedArrow] = useState<string | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ fromId: string; toId: string; x: number; y: number } | null>(null);
  const [lastKind, setLastKind] = useState<CanvasLinkKind>("blocks");
  // Najnowsze dane dla obsługi wskaźnika (zmiany z synchronizacji w trakcie przeciągania).
  const latest = useRef({ layout, groups, view });
  useEffect(() => {
    latest.current = { layout, groups, view };
  }, [layout, groups, view]);
  useEffect(() => saveViewport(list.id, view), [list.id, view]);

  const selected = useMemo(() => new Set(cards.filter((c) => selectedIds.has(c.id)).map((c) => c.id)), [cards, selectedIds]);
  const placedById = useMemo(() => new Map(layout.placed.map((p) => [p.task.id, p])), [layout]);
  // Zaznaczona karta wygrywa ze strzałką (Delete działa wtedy na karty, jak dotąd).
  const arrowSel = selected.size ? null : selectedArrow;

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
  // Przyciski i klawisze — względem środka obszaru.
  const zoomAt = (factor: number) =>
    setView((v) => {
      const rect = box.current?.getBoundingClientRect();
      return zoomCanvasViewport(v, factor, { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 });
    });
  const fit = () => {
    const rect = box.current?.getBoundingClientRect();
    const bounds = canvasBounds([...layout.placed.map((p) => p.cell), ...groups.flatMap((g) => [{ col: g.col, row: g.row }, { col: g.col + g.w - 1, row: g.row + g.h - 1 }])]);
    if (!rect || !bounds) return setView(DEFAULT_VIEW);
    const width = bounds.w * CANVAS_STEP.x;
    const height = bounds.h * CANVAS_STEP.y + GROUP_TAB;
    const zoom = clampCanvasZoom(Math.min((rect.width - 64) / width, (rect.height - 64) / height, 1));
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
        const rect = el.getBoundingClientRect();
        setView((v) => zoomCanvasViewport(v, factor, { x: e.clientX - rect.left, y: e.clientY - rect.top }));
      } else setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Szczypanie dwoma palcami (ekran dotykowy): powiększenie i przesunięcie za środkiem palców.
  // Rozpoczęte przeciąganie pierwszego palca jest wtedy ignorowane (`pinching`).
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; mid: { x: number; y: number }; view: Viewport } | null>(null);
  // Jeszcze chwilę po szczypaniu puszczenie ostatniego palca nie kończy przeciągania.
  const pinchTail = useRef(false);
  const pinching = () => pinch.current !== null || pinchTail.current;
  const touchStart = (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size !== 2) return;
    const rect = box.current!.getBoundingClientRect();
    const [a, b] = [...touches.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
    pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top }, view: latest.current.view };
    setDrag(null);
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const start = pinch.current;
      if (!start || touches.current.size < 2 || !box.current) return;
      const rect = box.current.getBoundingClientRect();
      const [a, b] = [...touches.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
      setView(zoomCanvasViewport(start.view, Math.hypot(a.x - b.x, a.y - b.y) / start.distance, start.mid, mid));
    };
    const up = (e: PointerEvent) => {
      if (!touches.current.delete(e.pointerId)) return;
      if (pinch.current && touches.current.size < 2) {
        pinch.current = null;
        pinchTail.current = true;
        window.setTimeout(() => (pinchTail.current = false), 400);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  // ── Karty ──
  const startCardDrag = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setLinkMenu(null);
    setSelectedArrow(null);
    box.current?.focus({ preventScroll: true });
    if (spacePan) return startPan(e);
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
      (dx, dy) => {
        if (!pinching()) setDrag({ kind: "cards", ids, dx, dy, moved: far(dx, dy) });
      },
      (dx, dy, up) => {
        setDrag(null);
        if (!far(dx, dy) || pinching()) return;
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
      (dx, dy, move) => {
        if (!pinching()) setDrag({ kind: "tray", id, clientX: move.clientX, clientY: move.clientY, moved: far(dx, dy) });
      },
      (dx, dy, up) => {
        setDrag(null);
        if (!far(dx, dy) || pinching() || !overBoard(up) || overTray(up)) return;
        const { ops, undo } = canvasPlaceOps(latest.current.layout, id, cellAt(up.clientX, up.clientY));
        void apply(ops, "Położono karteczkę", undo);
      },
    );
  };

  // ── Tło: przesuwanie widoku, zaznaczanie ramką (Shift), dwuklik = nowa karteczka ──
  const startBackground = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    box.current?.focus({ preventScroll: true });
    setLinkMenu(null);
    if (e.button === 0) setSelectedArrow(null);
    if (e.shiftKey && e.button === 0 && !spacePan) {
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
    startPan(e, !spacePan);
  };

  /** Przesuwanie widoku: tło, środkowy przycisk albo przytrzymana spacja (także nad kartą lub grupą). */
  const startPan = (e: ReactPointerEvent, clearOnClick = false) => {
    e.preventDefault();
    const start = latest.current.view;
    track(
      e,
      (dx, dy) => {
        if (pinching()) return;
        setDrag({ kind: "pan" });
        setView((v) => ({ ...v, x: start.x + dx, y: start.y + dy }));
      },
      (dx, dy) => {
        setDrag(null);
        if (clearOnClick && !far(dx, dy) && !pinching()) selectOnly([]);
      },
    );
  };

  const startAdding = (target: CanvasCell) => {
    if (!editable) return;
    setAdding(nearestFreeCell(layout.occupied, target));
  };

  // ── Strzałki ──
  /** Przeciąganie z uchwytu karty: szkic za kursorem, upuszczenie na innej karcie → menu rodzaju. */
  const startLink = (e: ReactPointerEvent, fromId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (spacePan) return startPan(e);
    if (!editable) return;
    e.preventDefault();
    box.current?.focus({ preventScroll: true });
    setLinkMenu(null);
    setSelectedArrow(null);
    track(
      e,
      (_dx, _dy, move) => {
        if (pinching()) return setDrag(null);
        const w = toWorld(move.clientX, move.clientY);
        const over = cardIdAt(move);
        setDrag({ kind: "link", fromId, x: w.x, y: w.y, overId: over && over !== fromId ? over : null });
      },
      (_dx, _dy, up) => {
        setDrag(null);
        const toId = cardIdAt(up);
        if (!toId || toId === fromId || pinching()) return;
        const w = toWorld(up.clientX, up.clientY);
        setLinkMenu({ fromId, toId, x: w.x, y: w.y });
      },
    );
  };

  const createLink = (kind: CanvasLinkKind) => {
    const menu = linkMenu;
    setLinkMenu(null);
    box.current?.focus({ preventScroll: true });
    if (!menu || !editable) return;
    setLastKind(kind);
    const sentence = CANVAS_ARROW[kind].sentence(quoted(menu.fromId), quoted(menu.toId));
    if (kind === "blocks") {
      const result = addDependencyOps(data.tasks, deps, { predecessorId: menu.fromId, successorId: menu.toId });
      if ("error" in result) return notify(dependencyErrorText(result.error, quoted));
      return void apply(result.ops, `Zależność: ${sentence}`, result.undo);
    }
    const result = addDerivedLinkOps(data.tasks, { fromId: menu.fromId, toId: menu.toId });
    if ("error" in result) return notify(derivedLinkErrorText(result.error, quoted));
    void apply(result.ops, `Powiązanie: ${sentence}`, result.undo);
  };

  const removeArrow = (arrow: CanvasArrow) => {
    setSelectedArrow(null);
    // Linia rodzic → podzadanie nie jest połączeniem do usunięcia (podzadania przepina panel zadania).
    if (!editable || arrow.kind === "parent") return;
    const sentence = CANVAS_ARROW[arrow.kind].sentence(quoted(arrow.fromId), quoted(arrow.toId));
    if (arrow.dependencyId) {
      const { ops, undo } = removeDependencyOps(arrow.dependencyId);
      return void apply(ops, `Usunięto zależność: ${sentence}`, undo);
    }
    const task = data.tasks.find((t) => t.id === arrow.toId);
    if (!task) return;
    const { ops, undo } = removeDerivedLinkOps(task, arrow.fromId);
    void apply(ops, `Usunięto powiązanie: ${sentence}`, undo);
  };

  const arrowDown = (e: ReactPointerEvent, key: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (spacePan) return startPan(e);
    box.current?.focus({ preventScroll: true });
    setLinkMenu(null);
    setSelectedArrow(key);
    selectOnly([]);
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
    setGroupDraft({ text: "", commit: false });
  };

  const startGroupDrag = (e: ReactPointerEvent, group: CanvasGroup, kind: "group" | "resize") => {
    if (e.button !== 0) return;
    if (spacePan) {
      e.stopPropagation();
      return startPan(e);
    }
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    track(
      e,
      (dx, dy) => {
        if (!pinching()) setDrag(kind === "group" ? { kind, id: group.id, dx, dy, moved: far(dx, dy) } : { kind, id: group.id, dx, dy });
      },
      (dx, dy) => {
        setDrag(null);
        if (!far(dx, dy) || pinching()) return;
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
  // Stałe funkcje dla kart (`memo`): wołają najnowsze wersje obsługi.
  const cardHandlers = useRef({ down: startCardDrag, open, link: startLink, arrow: arrowDown });
  useLayoutEffect(() => {
    cardHandlers.current = { down: startCardDrag, open, link: startLink, arrow: arrowDown };
  });
  const onCardDown = useCallback((e: ReactPointerEvent, id: string) => cardHandlers.current.down(e, id), []);
  const onCardOpen = useCallback((id: string) => cardHandlers.current.open(id), []);
  const onHandleDown = useCallback((e: ReactPointerEvent, id: string) => cardHandlers.current.link(e, id), []);
  const onArrowDown = useCallback((e: ReactPointerEvent, key: string) => cardHandlers.current.arrow(e, key), []);

  const onKeyUp = (e: ReactKeyboardEvent) => {
    if (e.key === " ") setSpacePan(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editingGroup && groupDraft && !groups.some((g) => g.id === editingGroup)) {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plain && e.key.length === 1) setGroupDraft({ ...groupDraft, text: groupDraft.text + e.key });
      else if (e.key === "Backspace") setGroupDraft({ ...groupDraft, text: groupDraft.text.slice(0, -1) });
      else if (e.key === "Enter") setGroupDraft({ ...groupDraft, commit: true });
      else if (e.key === "Escape") {
        setGroupDraft(null);
        setEditingGroup(null);
      } else return;
      // Klawisz nie dochodzi do skrótów `shell.tsx` (nasłuch na `window`).
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Zaznaczona strzałka: Delete / Backspace usuwa ją (nie zadania), Esc odznacza. Klawisz nie dochodzi do `shell.tsx`.
    const arrow = arrowSel ? links.arrows.find((a) => a.key === arrowSel) : undefined;
    if (arrow && e.target === box.current && (e.key === "Delete" || e.key === "Backspace" || e.key === "Escape")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") setSelectedArrow(null);
      else removeArrow(arrow);
      return;
    }
    if (e.key === "Escape" && full && !adding && !editingGroup) {
      e.preventDefault();
      return exitFull();
    }
    // Pozostałe skróty tylko na samej tablicy (nie w polach nazwy grupy / nowej karteczki).
    if (e.target !== box.current) return;
    if (e.key === " " && !e.ctrlKey && !e.metaKey) {
      // Przytrzymana spacja: przeciąganie przesuwa tablicę (jak w programach graficznych).
      e.preventDefault();
      if (!e.repeat) setSpacePan(true);
      return;
    }
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

  // Odcinki strzałek: od wyświetlanej komórki karty, na żywo za przeciąganą kartą / blokiem / grupą.
  const groupOffset = groupDrag ? { x: groupDrag.dx / view.zoom, y: groupDrag.dy / view.zoom } : null;
  const rectOf = (id: string) => {
    const p = placedById.get(id);
    if (!p) return null;
    return canvasCardRect(p.cell, dragging?.has(id) ? cardDelta : groupOffset && groupMovesCard(p.cell) ? groupOffset : null);
  };
  const segments: { arrow: CanvasArrow; seg: CanvasSegment }[] = [];
  for (const arrow of links.arrows) {
    const a = rectOf(arrow.fromId);
    const b = rectOf(arrow.toId);
    const seg = a && b ? canvasArrowSegment(a, b, arrow.offset) : null;
    if (seg) segments.push({ arrow, seg });
  }
  const linkDraft = drag?.kind === "link" ? drag : null;
  const draftSeg = (() => {
    if (!linkDraft) return null;
    const from = rectOf(linkDraft.fromId);
    if (!from) return null;
    const target = linkDraft.overId ? rectOf(linkDraft.overId) : null;
    return target ? canvasArrowSegment(from, target) : canvasArrowSegment(from, { x: linkDraft.x, y: linkDraft.y, w: 0, h: 0 }, 0, 0);
  })();
  const selectedSeg = arrowSel ? segments.find((s) => s.arrow.key === arrowSel) : undefined;

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
    <div className={full ? "fixed inset-0 z-[25] flex flex-col gap-2 bg-[var(--background)] p-3" : "flex flex-col gap-2"} onKeyDown={onKeyDown} onKeyUp={onKeyUp} data-testid="canvas-view" data-full={full || undefined}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {full ? <span className="mr-1 text-sm font-semibold">{list.name}</span> : null}
        <Button className="py-1 text-xs" disabled={!editable} onClick={() => startAdding(centerCell())} title="Nowa karteczka (N, dwuklik w puste miejsce)">
          + Karteczka
        </Button>
        <Button className="py-1 text-xs" disabled={!editable} onClick={groupAround} title={selected.size ? "Ramka wokół zaznaczonych karteczek" : "Nowa ramka na środku widoku"}>
          ▢ Grupuj
        </Button>
        <div className="flex overflow-hidden rounded-md border border-[var(--line)]" role="radiogroup" aria-label="Zadania na karteczkach" data-testid="canvas-show">
          {(Object.keys(CANVAS_TASKS) as CanvasTasks[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={show === k}
              onClick={() => setShow(k)}
              className={`px-2 py-1 ${show === k ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--hover)]"}`}
              title={k === "top" ? "Karteczki tylko dla zadań głównych (podzadania jako licznik na karcie)" : "Każde podzadanie na własnej karteczce"}
            >
              {CANVAS_TASKS[k]}
            </button>
          ))}
        </div>
        <span className="flex-1 lg:hidden" />
        {/* Podstawa 0: podpowiedź wypełnia wolne miejsce i skraca się, zamiast zawijać pasek. */}
        <span
          className="hidden min-w-0 flex-[1_1_0] truncate text-right text-[var(--muted)] lg:block"
          title="Dwuklik — nowa karteczka · uchwyt ● na karcie przeciągnięty na inną kartę — strzałka „blokuje” albo „wynika z” (klik w strzałkę + Delete usuwa) · Shift+przeciąganie — zaznaczanie ramką · spacja+przeciąganie — przesuwanie tablicy · Ctrl+kółko albo dwa palce — powiększenie"
        >
          Dwuklik — nowa · ● — strzałka · Shift — zaznaczanie · Spacja — przesuwanie · Ctrl+kółko — powiększenie
        </span>
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
        <CanvasExportButton listName={list.name} today={ctx.today} placed={layout.placed} trayCount={layout.tray.length} groups={groups} tags={tagsById} people={people} subtasks={subtasks} titles={titles} selected={selected} />
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
          className={`relative min-w-0 flex-1 touch-none overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--background)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${drag?.kind === "pan" ? "cursor-grabbing" : drag?.kind === "link" ? "cursor-crosshair [&_*]:!cursor-crosshair" : spacePan ? "cursor-grab [&_*]:!cursor-grab" : ""}`}
          style={{
            backgroundImage: "radial-gradient(circle, var(--line) 1.2px, transparent 1.3px)",
            backgroundSize: `${CANVAS_STEP.x * view.zoom}px ${CANVAS_STEP.y * view.zoom}px`,
            backgroundPosition: `${view.x - (CANVAS_CARD.gap / 2) * view.zoom}px ${view.y - (CANVAS_CARD.gap / 2) * view.zoom}px`,
          }}
          onBlur={(e) => {
            if (e.target === box.current) setSpacePan(false);
          }}
          onPointerDownCapture={touchStart}
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
                draft={editingGroup === group.id ? groupDraft : null}
                coloring={coloringGroup === group.id}
                onStartDrag={(e, kind) => startGroupDrag(e, group, kind)}
                onEdit={(on) => {
                  setGroupDraft(null);
                  setEditingGroup(on ? group.id : null);
                }}
                onColoring={(on) => setColoringGroup(on ? group.id : null)}
                onRename={(name) => {
                  setGroupDraft(null);
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
            <ArrowLayer layer="base" segments={segments} selected={arrowSel} interactive={editable} onArrowDown={onArrowDown} />
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
                  people={people.get(p.task.id) ?? NO_PEOPLE}
                  subtasksDone={subtasks.get(p.task.id)?.done ?? 0}
                  subtasksTotal={subtasks.get(p.task.id)?.total ?? 0}
                  parentTitle={p.task.parentId ? (titles.get(p.task.parentId) ?? "") : null}
                  showText={showText}
                  offset={offset}
                  editable={editable}
                  offBoard={offBoard.get(p.task.id) ?? null}
                  linkTarget={linkDraft?.overId === p.task.id || linkDraft?.fromId === p.task.id}
                  onPointerDown={onCardDown}
                  onOpen={onCardOpen}
                  onHandleDown={onHandleDown}
                />
              );
            })}
            {/* Nad kartami: zaznaczona strzałka i szkic rysowanej (bez obsługi wskaźnika — klik trafia w kartę pod spodem). */}
            {selectedSeg || draftSeg ? (
              <ArrowLayer
                layer="top"
                segments={[
                  ...(selectedSeg ? [selectedSeg] : []),
                  ...(draftSeg ? [{ arrow: { key: "draft", kind: lastKind, fromId: "", toId: "", dependencyId: null, violated: false, offset: 0 }, seg: draftSeg }] : []),
                ]}
                selected={selectedSeg ? arrowSel : null}
                draft={Boolean(draftSeg)}
                interactive={false}
                onArrowDown={onArrowDown}
                className="z-[15]"
              />
            ) : null}
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
          {selectedSeg ? (
            <ArrowLabel
              arrow={selectedSeg.arrow}
              x={view.x + ((selectedSeg.seg.x1 + selectedSeg.seg.x2) / 2) * view.zoom}
              y={view.y + ((selectedSeg.seg.y1 + selectedSeg.seg.y2) / 2) * view.zoom}
              sentence={CANVAS_ARROW[selectedSeg.arrow.kind].sentence(quoted(selectedSeg.arrow.fromId), quoted(selectedSeg.arrow.toId))}
              editable={editable}
              onRemove={() => removeArrow(selectedSeg.arrow)}
            />
          ) : null}
          {linkMenu && editable ? (
            <LinkMenu
              x={view.x + linkMenu.x * view.zoom}
              y={view.y + linkMenu.y * view.zoom}
              from={quoted(linkMenu.fromId)}
              to={quoted(linkMenu.toId)}
              preferred={lastKind}
              onPick={createLink}
              onCancel={() => {
                setLinkMenu(null);
                box.current?.focus({ preventScroll: true });
              }}
            />
          ) : null}
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
        {plural(layout.placed.length, ["karteczka", "karteczki", "karteczek"])} na tablicy · kolor = pierwszy kolorowy tag zadania (kolejność tagów zmienisz w panelu zadania) · ramka = priorytet · strzałka ciągła = blokuje (zależność, czerwona — naruszona kolejność), przerywana = wynika z, kropkowana z kropką = rodzic → podzadanie (tryb „Z podzadaniami”)
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

const NO_PEOPLE: { assignee: Collaborator | null; participants: readonly Collaborator[] } = { assignee: null, participants: [] };
const MAX_PARTICIPANTS = 3;

const Card = memo(function Card({
  task,
  cell,
  displaced,
  selected,
  color,
  people,
  subtasksDone,
  subtasksTotal,
  parentTitle,
  showText,
  offset,
  editable,
  offBoard,
  linkTarget,
  onPointerDown,
  onOpen,
  onHandleDown,
}: {
  task: ViewTask;
  cell: CanvasCell;
  displaced: boolean;
  selected: boolean;
  color: string;
  people: { assignee: Collaborator | null; participants: readonly Collaborator[] };
  /** Postęp podzadań: ukończone / wszystkie (liczby, nie obiekt — `memo` porównuje płytko). */
  subtasksDone: number;
  subtasksTotal: number;
  /** Tytuł rodzica, gdy karta jest podzadaniem (tryb „Z podzadaniami”). */
  parentTitle: string | null;
  showText: boolean;
  offset: { x: number; y: number } | null;
  editable: boolean;
  /** Tytuły zadań po drugiej stronie połączeń, których nie widać na tablicy (po jednym w linii); `null` = brak. */
  offBoard: string | null;
  /** Początek albo cel rysowanej strzałki (podświetlenie). */
  linkTarget: boolean;
  onPointerDown: (e: ReactPointerEvent, id: string) => void;
  onOpen: (id: string) => void;
  onHandleDown: (e: ReactPointerEvent, id: string) => void;
}) {
  const fit = showText ? titleFit(task.title) : null;
  const closed = task.status === "done" || task.status === "cancelled";
  // Dwie warstwy: zewnętrzna (położenie, zaznaczenie, cień-filtr idący za kształtem) i przód przycięty
  // o róg, na który nachodzi zagięcie — `clip-path` na zewnętrznej ucięłoby obrys zaznaczenia i cień.
  return (
    <div
      data-canvas-card
      data-task-id={task.id}
      data-clipped={fit?.clipped || undefined}
      role="button"
      aria-label={`${task.title}${parentTitle !== null ? ` (podzadanie „${parentTitle}”)` : ""} — ${PRIORITY[task.priority].label.toLowerCase()} priorytet${people.assignee ? `, ${people.assignee.name}` : ""}`}
      aria-pressed={selected}
      title={`${task.title}${parentTitle !== null ? `\nPodzadanie: „${parentTitle}”` : ""}${displaced ? "\n(pokazana obok — ktoś położył kartę w tym samym miejscu)" : ""}`}
      className={`group/card absolute select-none ${editable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${selected ? "z-10 outline outline-2 outline-offset-2 outline-[var(--accent)]" : linkTarget ? "outline outline-2 outline-offset-4 outline-dashed outline-[var(--accent)]" : ""} ${offset ? "z-20 opacity-80" : ""} ${closed ? "opacity-50" : ""}`}
      style={{
        ["--card-color" as string]: color,
        left: cell.col * CANVAS_STEP.x,
        top: cell.row * CANVAS_STEP.y,
        width: CANVAS_CARD.width,
        height: CANVAS_CARD.height,
        transform: offset ? `translate(${offset.x}px, ${offset.y}px) rotate(1.5deg)` : undefined,
        filter: offset ? CARD_SHADOW.lifted : selected ? CARD_SHADOW.selected : CARD_SHADOW.rest,
      }}
      onPointerDown={(e) => onPointerDown(e, task.id)}
      onDoubleClick={() => onOpen(task.id)}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-[3px]"
        style={{
          padding: `${CARD_PAD}px ${CARD_PAD}px 0`,
          background: CARD_FACE,
          ...frameStyle(task),
          // Ramka wewnątrz stałego kształtu karty (grubsza ramka nie powiększa karty).
          boxSizing: "border-box",
          clipPath: CARD_CLIP,
        }}
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
          {/* Odstęp pod paskiem + z prawej: znaczki osób kończą się przed zagiętym rogiem (nie nachodzi na nie). */}
        <div className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--muted)]" style={{ height: CARD_FOOT, paddingBottom: CARD_FOOT - 20, paddingRight: CARD_FOLD - CARD_PAD + 4 }}>
          {parentTitle !== null && showText ? (
            <span className="min-w-0 truncate" title={`Podzadanie: „${parentTitle}”`} data-testid="canvas-parent">
              ↑ {parentTitle}
            </span>
          ) : null}
          {offBoard !== null && showText ? (
            <span className="shrink-0 tabular-nums" title={`Połączenia z karteczkami poza tablicą:\n${offBoard}`} data-testid="canvas-offboard">
              ⇢ {offBoard.split("\n").length}
            </span>
          ) : null}
          {subtasksTotal && showText ? (
            <span className="shrink-0 tabular-nums" title={`Podzadania: ukończone ${subtasksDone} z ${subtasksTotal}`} data-testid="canvas-subtasks">
              ↳ {subtasksDone}/{subtasksTotal}
            </span>
          ) : null}
          <span className="flex-1" />
          {showText
            ? people.participants.slice(0, MAX_PARTICIPANTS).map((person) => (
                <span
                  key={person.id}
                  title={`Uczestnik: ${person.name}`}
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-sky-600 bg-[var(--surface)]/70 px-1 text-[10px] font-semibold text-sky-700 dark:border-sky-400 dark:text-sky-300"
                  data-testid="canvas-participant"
                >
                  {collaboratorBadge(person)}
                </span>
              ))
            : null}
          {showText && people.participants.length > MAX_PARTICIPANTS ? (
            <span title={people.participants.slice(MAX_PARTICIPANTS).map((p) => p.name).join(", ")}>+{people.participants.length - MAX_PARTICIPANTS}</span>
          ) : null}
          {people.assignee ? (
            <span
              title={`Odpowiedzialny: ${people.assignee.name}`}
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-600 px-1 text-[10px] font-semibold text-white dark:bg-sky-500"
              data-testid="canvas-assignee"
            >
              {collaboratorBadge(people.assignee)}
            </span>
          ) : null}
        </div>
      </div>
      {editable ? (
        // Uchwyt strzałki: przeciągnięcie na inną kartę → „blokuje” / „wynika z”. Widoczny po najechaniu (CSS) i na zaznaczonej karcie.
        <span
          data-canvas-handle
          role="button"
          aria-label={`Strzałka od „${task.title}”`}
          title="Przeciągnij na inną karteczkę — strzałka „blokuje” albo „wynika z”"
          className={`absolute -right-2 top-1/2 z-10 h-4 w-4 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-[var(--accent)] bg-[var(--surface)] shadow transition-opacity ${selected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100"}`}
          onPointerDown={(e) => onHandleDown(e, task.id)}
        />
      ) : null}
      {/* Zagięty róg: odwrotna strona kartki (ciemniejsza przy zgięciu) rzucająca cień na przód. */}
      <span className="pointer-events-none absolute bottom-0 right-0" style={{ width: CARD_FOLD, height: CARD_FOLD, filter: "drop-shadow(-1px -1px 2px rgb(0 0 0 / 0.3))" }} aria-hidden>
        <span
          className="block h-full w-full rounded-tl-[2px]"
          style={{
            clipPath: "polygon(0 0, 100% 0, 0 100%)",
            background: "linear-gradient(135deg, color-mix(in srgb, var(--card-color) 22%, var(--surface)) 0%, color-mix(in srgb, var(--card-color) 30%, var(--surface)) 30%, color-mix(in srgb, color-mix(in srgb, var(--card-color) 50%, var(--surface)) 78%, black) 50%)",
          }}
        />
      </span>
    </div>
  );
});

// ── Strzałki ──────────────────────────────────────────────────────────────────────────────────

/** Margines warstwy SVG wokół odcinków (groty, szeroki obrys do klikania). */
const ARROW_PAD = 16;

/**
 * Warstwa strzałek (SVG w px tablicy). Rozmiar = prostokąt obejmujący odcinki, więc obsługa wskaźnika
 * działa też dla współrzędnych ujemnych; tło warstwy nie łapie kliknięć (tylko szeroki obrys strzałki).
 */
function ArrowLayer({
  layer,
  segments,
  selected,
  interactive,
  draft = false,
  className = "",
  onArrowDown,
}: {
  /** `base` — wszystkie strzałki pod kartami, `top` — zaznaczona i szkic nad kartami. */
  layer: "base" | "top";
  segments: readonly { arrow: CanvasArrow; seg: CanvasSegment }[];
  selected: string | null;
  interactive: boolean;
  draft?: boolean;
  className?: string;
  onArrowDown: (e: ReactPointerEvent, key: string) => void;
}) {
  if (!segments.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { seg } of segments) {
    minX = Math.min(minX, seg.x1, seg.x2);
    minY = Math.min(minY, seg.y1, seg.y2);
    maxX = Math.max(maxX, seg.x1, seg.x2);
    maxY = Math.max(maxY, seg.y1, seg.y2);
  }
  const x = Math.floor(minX - ARROW_PAD);
  const y = Math.floor(minY - ARROW_PAD);
  const w = Math.ceil(maxX + ARROW_PAD) - x;
  const h = Math.ceil(maxY + ARROW_PAD) - y;
  return (
    <svg
      className={`pointer-events-none absolute overflow-visible ${className}`}
      style={{ left: x, top: y, width: w, height: h }}
      viewBox={`${x} ${y} ${w} ${h}`}
      aria-hidden
      data-canvas-arrows={layer}
      data-draft={draft || undefined}
    >
      {segments.map(({ arrow, seg }) => (
        <Arrow
          key={arrow.key}
          id={arrow.key}
          kind={arrow.kind}
          fromId={arrow.fromId}
          toId={arrow.toId}
          violated={arrow.violated}
          selected={arrow.key === selected}
          draft={arrow.key === "draft"}
          interactive={interactive && arrow.kind !== "parent"}
          x1={seg.x1}
          y1={seg.y1}
          x2={seg.x2}
          y2={seg.y2}
          onDown={onArrowDown}
        />
      ))}
    </svg>
  );
}

/** Jedna strzałka: tylko liczby i teksty w propsach (`memo`) — przy przeciąganiu przerysowują się tylko ruszane. */
const Arrow = memo(function Arrow({
  id,
  kind,
  fromId,
  toId,
  violated,
  selected,
  draft,
  interactive,
  x1,
  y1,
  x2,
  y2,
  onDown,
}: {
  id: string;
  kind: CanvasArrowKind;
  fromId: string;
  toId: string;
  violated: boolean;
  selected: boolean;
  draft: boolean;
  interactive: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  onDown: (e: ReactPointerEvent, key: string) => void;
}) {
  const color = selected || draft ? "var(--accent)" : violated ? "var(--danger)" : "var(--muted)";
  if (kind === "parent") {
    // Rodzic → podzadanie: cienka kropkowana linia bez grotu, kropka przy rodzicu (tylko do oglądania).
    return (
      <g data-canvas-arrow={id} data-kind={kind} data-from={fromId} data-to={toId} opacity={0.7}>
        <title>{`Podzadanie (rodzic → podzadanie)`}</title>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.25} strokeDasharray="1 4" strokeLinecap="round" />
        <circle cx={x1} cy={y1} r={3} fill={color} />
      </g>
    );
  }
  const width = (kind === "blocks" ? 2 : 1.5) + (selected ? 1 : 0);
  const seg = { x1, y1, x2, y2 };
  const head = canvasArrowHead(seg, kind === "blocks" ? 10 : 9, kind === "blocks" ? 8 : 9)
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
  // Linia „blokuje” kończy się u podstawy grotu (pełny grot zakrywa resztę, a koniec linii nie wystaje zza czubka).
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const back = kind === "blocks" ? 8 : 0;
  const ex = x2 - ((x2 - x1) / len) * back;
  const ey = y2 - ((y2 - y1) / len) * back;
  return (
    <g data-canvas-arrow={draft ? undefined : id} data-kind={kind} data-from={fromId || undefined} data-to={toId || undefined} data-violated={violated || undefined} data-selected={selected || undefined}>
      {interactive ? (
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} strokeLinecap="round" style={{ pointerEvents: "stroke", cursor: "pointer" }} onPointerDown={(e) => onDown(e, id)}>
          <title>{`${CANVAS_ARROW[kind].label}${violated ? " — naruszona kolejność" : ""} (kliknij, aby zaznaczyć)`}</title>
        </line>
      ) : null}
      <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={color} strokeWidth={width} strokeDasharray={kind === "derived" ? "6 4" : undefined} strokeLinecap="round" />
      {kind === "blocks" ? (
        <polygon points={head} fill={color} />
      ) : (
        <polyline points={head} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </g>
  );
});

/** Etykieta zaznaczonej strzałki (px obszaru, nie skaluje się z powiększeniem): rodzaj, zdanie, ✕. */
function ArrowLabel({ arrow, x, y, sentence, editable, onRemove }: { arrow: CanvasArrow; x: number; y: number; sentence: string; editable: boolean; onRemove: () => void }) {
  return (
    <div
      className="absolute z-30 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--accent)] bg-[var(--surface)] px-2 py-0.5 text-[11px] shadow"
      style={{ left: x, top: y }}
      title={sentence}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="canvas-arrow-label"
    >
      {arrow.violated ? <span className="text-[var(--danger)]">⚠</span> : null}
      <span className="font-medium">{CANVAS_ARROW[arrow.kind].label}</span>
      {arrow.kind === "blocks" && arrow.violated ? <span className="text-[var(--muted)]">kolejność naruszona</span> : null}
      {editable ? (
        <button type="button" className="opacity-60 hover:opacity-100" aria-label={`Usuń strzałkę: ${sentence}`} title="Usuń strzałkę (Delete)" onClick={onRemove}>
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** Menu po upuszczeniu strzałki na karcie: rodzaj połączenia (B / W, Enter = ostatni rodzaj, Esc = nic). */
function LinkMenu({
  x,
  y,
  from,
  to,
  preferred,
  onPick,
  onCancel,
}: {
  x: number;
  y: number;
  from: string;
  to: string;
  preferred: CanvasLinkKind;
  onPick: (kind: CanvasLinkKind) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const items: { kind: CanvasLinkKind; key: string; hint: string }[] = [
    { kind: "blocks", key: "B", hint: "zależność — jak na osi czasu" },
    { kind: "derived", key: "W", hint: "samo powiązanie, bez terminów" },
  ];
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="menu"
      aria-label="Rodzaj strzałki"
      className="absolute z-40 flex w-72 flex-col rounded-md border border-[var(--line)] bg-[var(--surface)] p-1 text-xs shadow-lg outline-none"
      style={{ left: x + 8, top: y + 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const key = e.key.toLowerCase();
        const pick = key === "b" ? "blocks" : key === "w" ? "derived" : e.key === "Enter" ? preferred : null;
        if (pick) onPick(pick);
        else if (e.key === "Escape") onCancel();
        else return;
        // Klawisz nie dochodzi do skrótów tablicy ani `shell.tsx`.
        e.preventDefault();
        e.stopPropagation();
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCancel();
      }}
      data-testid="canvas-link-menu"
    >
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          role="menuitem"
          className={`flex items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--hover)] ${item.kind === preferred ? "bg-[var(--hover)]" : ""}`}
          onClick={() => onPick(item.kind)}
        >
          <kbd className="mt-0.5 rounded border border-[var(--line)] px-1 text-[10px] text-[var(--muted)]">{item.key}</kbd>
          <span className="min-w-0">
            <span className="block truncate font-medium">{CANVAS_ARROW[item.kind].sentence(from, to)}</span>
            <span className="text-[var(--muted)]">{item.hint}</span>
          </span>
        </button>
      ))}
      <button type="button" role="menuitem" className="rounded px-2 py-1 text-left text-[var(--muted)] hover:bg-[var(--hover)]" onClick={onCancel}>
        Anuluj (Esc)
      </button>
    </div>
  );
}

// ── Grupa ─────────────────────────────────────────────────────────────────────────────────────

function GroupFrame({
  group,
  offset,
  resize,
  editable,
  editing,
  draft,
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
  /** Nazwa wpisana przed pojawieniem się grupy; `commit` = Enter już naciśnięty. */
  draft: { text: string; commit: boolean } | null;
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
  const input = useRef<HTMLInputElement>(null);
  const commit = editing && Boolean(draft?.commit);
  useEffect(() => {
    if (commit) input.current?.blur();
  }, [commit]);
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
        className={`absolute left-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium ${editable ? "cursor-move" : ""}`}
        // Środek nagłówka na środku 2-px krawędzi ramki (dzieci liczą się od wnętrza ramki).
        style={{ top: -GROUP_TAB / 2 - 1, height: GROUP_TAB, borderColor: `color-mix(in srgb, ${color} 75%, transparent)`, background: `color-mix(in srgb, ${color} 25%, var(--surface))` }}
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
            ref={input}
            autoFocus
            defaultValue={draft?.text || group.name}
            maxLength={60}
            aria-label="Nazwa grupy"
            className="w-32 bg-transparent text-[11px] outline-none"
            onFocus={(e) => (draft?.text ? e.target.setSelectionRange(draft.text.length, draft.text.length) : e.target.select())}
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
