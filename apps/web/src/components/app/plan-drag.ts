"use client";

/**
 * Przeciąganie myszą na osi „Planu dnia”: blok zadania na inną godzinę albo pozycja „cały dzień” na oś
 * (co 15 min, `snapMinutes`). Zdarzenia na `window`, nie na elemencie — odświeżenie danych w trakcie nie
 * gubi upuszczenia. Puszczenie poza osią i Esc = bez zmian. Dotyk zostaje przewijaniu.
 */
import { snapMinutes } from "@taskplanner/core";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** Ruch (px), od którego wciśnięcie jest przeciąganiem, a nie kliknięciem. */
const THRESHOLD = 5;
/** Pas (px) przy krawędzi przewijanego obszaru, w którym przeciąganie przewija; także tolerancja nad i pod osią. */
const EDGE = 28;
const STEP = 15;

export interface PlanDrag {
  id: string;
  /** Godzina pod wskaźnikiem (minuty od północy); `null` — wskaźnik poza osią. */
  startMin: number | null;
}

interface Axis {
  from: number;
  to: number;
  px: number;
}

/** Najbliższy przewijany w pionie przodek (panel na szerokim ekranie, treść na wąskim). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

export function usePlanDrag(axisRef: RefObject<HTMLDivElement | null>, axis: Axis, onDrop: (id: string, startMin: number) => void) {
  const [drag, setDrag] = useState<PlanDrag | null>(null);
  const latest = useRef({ axis, onDrop });
  useEffect(() => {
    latest.current = { axis, onDrop };
  });
  const stop = useRef<(() => void) | null>(null);
  // Po przeciągnięciu przeglądarka wysyła jeszcze kliknięcie — nie ma otwierać zadania.
  const moved = useRef(false);
  useEffect(() => () => stop.current?.(), []);

  /** `startMin` — początek przeciąganego bloku; `null` dla pozycji bez godziny. */
  const start = useCallback(
    (e: ReactPointerEvent, id: string, startMin: number | null) => {
      moved.current = false;
      if (e.button !== 0 || e.pointerType === "touch" || e.ctrlKey || e.metaKey) return;
      const { pointerId, clientX: x0, clientY: y0 } = e;
      const point = { x: x0, y: y0 };
      const minuteAt = (clientY: number) => {
        const box = axisRef.current?.getBoundingClientRect();
        const { from, px } = latest.current.axis;
        return box ? from + (clientY - box.top) / px : 0;
      };
      const grab = startMin === null ? 0 : minuteAt(y0) - startMin;
      let active = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const target = (): number | null => {
        const box = axisRef.current?.getBoundingClientRect();
        const panel = axisRef.current?.parentElement?.getBoundingClientRect();
        if (!box || !panel || point.x < panel.left || point.x > panel.right || point.y < box.top - EDGE || point.y > box.bottom + EDGE) return null;
        // Bloki „cały dzień” leżą tuż nad osią: bez tolerancji od góry sam początek ruchu dawałby godzinę.
        if (startMin === null && point.y < box.top) return null;
        const { from, to } = latest.current.axis;
        return Math.min(Math.max(snapMinutes(minuteAt(point.y) - grab, STEP), from), to - STEP);
      };
      const update = () => {
        const next = target();
        setDrag((d) => (d?.id === id && d.startMin === next ? d : { id, startMin: next }));
      };
      const scroll = () => {
        const area = axisRef.current && scrollParent(axisRef.current);
        if (!area) return;
        const box = area.getBoundingClientRect();
        if (point.x < box.left || point.x > box.right) return;
        const top = Math.max(box.top, 0);
        const bottom = Math.min(box.bottom, window.innerHeight);
        const by = point.y < top + EDGE ? -6 : point.y > bottom - EDGE ? 6 : 0;
        if (!by) return;
        area.scrollTop += by;
        update();
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("blur", end);
        window.removeEventListener("keydown", onKey, true);
        clearInterval(timer);
        if (active) document.body.style.cursor = "";
        stop.current = null;
        setDrag(null);
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        point.x = ev.clientX;
        point.y = ev.clientY;
        if (!active) {
          if (Math.hypot(point.x - x0, point.y - y0) < THRESHOLD) return;
          active = true;
          moved.current = true;
          document.body.style.cursor = "grabbing";
          timer = setInterval(scroll, 16);
        }
        update();
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        point.x = ev.clientX;
        point.y = ev.clientY;
        const at = active ? target() : null;
        end();
        if (at !== null && at !== startMin) latest.current.onDrop(id, at);
      };
      // Esc przerywa samo przeciąganie — nie zamyka przy tym panelu zadania.
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !active) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        end();
      };

      stop.current?.();
      stop.current = end;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      window.addEventListener("blur", end);
      window.addEventListener("keydown", onKey, true);
    },
    [axisRef],
  );

  /** Czy to kliknięcie kończy przeciąganie (do pominięcia); `detail` = 0 — Enter / Spacja na przycisku. */
  const wasDragged = useCallback((detail: number) => {
    const was = moved.current && detail > 0;
    moved.current = false;
    return was;
  }, []);

  return { drag, start, wasDragged };
}
