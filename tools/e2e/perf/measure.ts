/** Wspólne narzędzia pomiarów (`perf.spec.ts`, `canvas.spec.ts`): czas akcji do klatki, płynność klatek. */
import type { Page } from '@playwright/test';

export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
export const max = (xs: number[]) => Math.max(...xs);

/**
 * W stronie: `action` (kod JS), potem czekanie, aż `ready` (wyrażenie JS) będzie prawdą, i na
 * narysowanie następnej klatki. Zwraca ms od akcji.
 */
export async function timed(page: Page, action: string, ready: string, timeout = 20_000): Promise<number> {
  return page.evaluate(
    ({ action, ready, timeout }) =>
      new Promise<number>((resolve, reject) => {
        const isReady = new Function(`return (${ready});`) as () => boolean;
        const start = performance.now();
        new Function(action)();
        const painted = () => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
        const check = () => {
          if (isReady()) return painted();
          if (performance.now() - start > timeout) return reject(new Error(`Nie doczekano: ${ready}`));
          requestAnimationFrame(check);
        };
        check();
      }),
    { action, ready, timeout },
  );
}


/** Odstępy między klatkami w trakcie `work` (rAF w stronie). */
export async function frames(page: Page, work: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__frames = [];
    w.__recording = true;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames.push(now - last);
      last = now;
      if (w.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await work();
  const deltas = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__recording = false;
    return w.__frames.slice(1);
  });
  const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  return { fps: 1000 / avg, p95: [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * 0.95)]!, worst: max(deltas), dropped: deltas.filter((d) => d > 25).length, frames: deltas.length };
}

export async function dragSlowly(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, back = true) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 60 });
  // Z powrotem na miejsce — upuszczenie bez zmiany danych.
  if (back) await page.mouse.move(from.x, from.y, { steps: 60 });
  await page.mouse.up();
}
