"use client";

/**
 * Pomiary PoC-5: przeciąganie syntetycznymi zdarzeniami (po jednym ruchu na klatkę) i odstępy
 * między klatkami. 60 kl./s = odstęp ~16,7 ms; klatka > 25 ms liczy się jako zgubiona.
 */
export interface DragMeasure {
  frames: number;
  avgMs: number;
  p95Ms: number;
  worstMs: number;
  dropped: number;
  fps: number;
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

export async function syntheticDrag(
  source: Element,
  to: { x: number; y: number },
  { steps = 90, kind = "pointer" }: { steps?: number; kind?: "pointer" | "mouse" } = {},
): Promise<DragMeasure> {
  const box = source.getBoundingClientRect();
  const from = { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 12) };
  const fire = (type: string, x: number, y: number, target: EventTarget = source) => {
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith("up") ? 0 : 1, view: window };
    if (kind === "pointer") target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    else target.dispatchEvent(new MouseEvent(type, init));
  };
  fire(kind === "pointer" ? "pointerdown" : "mousedown", from.x, from.y);
  const deltas: number[] = [];
  let last = await nextFrame();
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    fire(kind === "pointer" ? "pointermove" : "mousemove", x, y, document);
    const now = await nextFrame();
    deltas.push(now - last);
    last = now;
  }
  fire(kind === "pointer" ? "pointerup" : "mouseup", to.x, to.y, document);
  const sorted = [...deltas].sort((a, b) => a - b);
  const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  return {
    frames: deltas.length,
    avgMs: avg,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? avg,
    worstMs: sorted.at(-1) ?? avg,
    dropped: deltas.filter((d) => d > 25).length,
    fps: 1000 / avg,
  };
}

export const formatDrag = (m: DragMeasure) =>
  `${m.fps.toFixed(0)} kl./s (śr. ${m.avgMs.toFixed(1)} ms, p95 ${m.p95Ms.toFixed(1)} ms, najgorsza ${m.worstMs.toFixed(0)} ms, zgubione ${m.dropped}/${m.frames})`;

/** Wywołaj po narysowaniu klatki z gotowymi danymi (pomiar przełączenia widoku). */
export const afterPaint = (callback: () => void) => requestAnimationFrame(() => setTimeout(callback, 0));
