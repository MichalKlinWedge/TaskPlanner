/** Zrzut do instrukcji: numerowane znaczniki na elementach, kadr i zapis jako lekki PNG (paleta). */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Locator, Page } from '@playwright/test';
import sharp from 'sharp';

export const IMG_DIR = fileURLToPath(new URL('../../../docs/instrukcja/img/', import.meta.url));

/** Róg / krawędź: `l`, `r` — obok elementu, `b` — pod środkiem, `edge` — na prawej krawędzi panelu bocznego. */
type MarkPos = 'tl' | 'tr' | 'l' | 'r' | 'b' | 'edge';
/** Znacznik: element i miejsce numeru względem niego. */
export interface Mark {
  at: Locator;
  pos?: MarkPos;
}

export interface ShotOptions {
  /** Kadr: element (z marginesem) zamiast całego okna. */
  of?: Locator;
  pad?: number;
  marks?: readonly Mark[];
  /** Najwyżej tyle pikseli CSS wysokości kadru. */
  maxHeight?: number;
}

const R = 13;

async function addMarks(page: Page, marks: readonly Mark[]) {
  const points: { x: number; y: number; n: number }[] = [];
  const side = await page.locator('#sidebar').boundingBox();
  const edge = side ? side.x + side.width + 2 : 0;
  for (const [i, { at, pos = 'tl' }] of marks.entries()) {
    const box = await at.first().boundingBox({ timeout: 3000 });
    if (!box) throw new Error(`Znacznik ${i + 1}: element niewidoczny.`);
    points.push({
      n: i + 1,
      x: pos === 'edge' ? edge : pos === 'b' ? box.x + box.width / 2 : pos === 'r' ? box.x + box.width + R + 4 : pos === 'l' ? box.x - R - 4 : pos === 'tr' ? box.x + box.width : box.x,
      y: pos === 'b' ? box.y + box.height + R : pos === 'l' || pos === 'r' || pos === 'edge' ? box.y + box.height / 2 : box.y,
    });
  }
  await page.evaluate(
    ({ points, r }) => {
      const layer = document.createElement('div');
      layer.id = 'docs-marks';
      for (const p of points) {
        const el = document.createElement('div');
        el.textContent = String(p.n);
        const x = Math.max(r + 2, Math.min(innerWidth - r - 2, p.x));
        const y = Math.max(r + 2, Math.min(innerHeight - r - 2, p.y));
        el.style.cssText = `position:fixed;left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;background:#c2185b;color:#fff;font:700 14px/${2 * r}px system-ui;text-align:center;box-shadow:0 0 0 2px #fff,0 1px 5px rgba(0,0,0,.45);z-index:9999;pointer-events:none`;
        layer.append(el);
      }
      document.body.append(layer);
    },
    { points, r: R },
  );
}

export async function shot(page: Page, name: string, { of, pad = 12, marks = [], maxHeight }: ShotOptions = {}) {
  mkdirSync(IMG_DIR, { recursive: true });
  await page.waitForTimeout(350);
  if (marks.length) await addMarks(page, marks);
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  if (of) {
    const box = await of.first().boundingBox({ timeout: 5000 });
    const view = page.viewportSize()!;
    if (!box) throw new Error(`${name}: kadr niewidoczny.`);
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const height = Math.min(view.height, box.y + box.height + pad) - y;
    clip = { x, y, width: Math.min(view.width, box.x + box.width + pad) - x, height: Math.min(height, maxHeight ?? height) };
  }
  const png = await page.screenshot({ ...(clip && { clip }), animations: 'disabled', caret: 'hide' });
  if (marks.length) await page.evaluate(() => document.getElementById('docs-marks')?.remove());
  await sharp(png).png({ palette: true, quality: 88, effort: 9, compressionLevel: 9 }).toFile(`${IMG_DIR}${name}.png`);
}
