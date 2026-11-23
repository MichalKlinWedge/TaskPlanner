/**
 * Pomiar widoku „Karteczki” na 500 karteczkach jednej listy: otwarcie (pierwsza synchronizacja
 * i przełączenie widoku), płynność przeciągania karteczki, przesuwania tablicy i powiększania
 * (Ctrl+kółko), „Dopasuj”, upuszczenie → karteczka w nowej komórce, rysowanie strzałki z uchwytu
 * (na tablicy ok. 480 strzałek z `canvas-perf-setup.ts`). Czas liczony w stronie.
 * Wynik: tabela w konsoli i `tools/e2e/out/perf-canvas.json`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANVAS_CARD, CANVAS_STEP } from '@taskplanner/core';
import { expect, test } from '@playwright/test';

import { CANVAS_PERF_CARDS } from '../src/constants.ts';
import { CANVAS_PERF_LIST_FILE } from '../src/canvas-perf-setup.ts';
import { dragSlowly, frames, max, median, timed } from './measure.ts';

interface Row {
  name: string;
  samples: number[];
  note?: string;
}

const results: Row[] = [];
const record = (name: string, samples: number[], note?: string) => {
  results.push({ name, samples, note });
  console.log(`${name}: mediana ${Math.round(median(samples))} ms, max ${Math.round(max(samples))} ms${note ? ` (${note})` : ''}`);
};
const smooth = (name: string, f: Awaited<ReturnType<typeof frames>>) =>
  record(name, [f.fps], `p95 ${f.p95.toFixed(1)} ms, najgorsza ${f.worst.toFixed(0)} ms, zgubione ${f.dropped}/${f.frames}`);

test(`${CANVAS_PERF_CARDS} karteczek`, async ({ page }) => {
  const { id } = JSON.parse(readFileSync(CANVAS_PERF_LIST_FILE, 'utf8')) as { id: string };
  const hash = `#/list/${id}`;
  const allCards = `document.querySelectorAll('[data-testid=canvas-board] [data-canvas-card]').length === ${CANVAS_PERF_CARDS}`;
  const inboxRows = `document.querySelector('main h1')?.textContent === 'Inbox'`;

  // 1. Pierwsza synchronizacja: pusta lokalna baza → komplet karteczek na tablicy.
  const started = Date.now();
  await page.goto(`/${hash}`);
  await page.waitForFunction(new Function(`return ${allCards};`) as () => boolean, undefined, { timeout: 120_000, polling: 100 });
  record('Pierwsze otwarcie (pusta baza → 500 karteczek)', [Date.now() - started]);
  await expect(page.getByTestId('sync-status')).toHaveText('Zsynchronizowano', { timeout: 60_000 });

  // 2. Przełączenie widoku: Inbox → lista z karteczkami (dane w pamięci, dopasowanie tytułów z pamięci podręcznej).
  const opens: number[] = [];
  for (let i = 0; i < 5; i++) {
    await timed(page, `location.hash = '#/inbox';`, inboxRows);
    opens.push(await timed(page, `location.hash = ${JSON.stringify(hash)};`, allCards));
  }
  record('Widok: Inbox → „Karteczki” (500)', opens);

  // Domyślny widok: siatka od (40, 48) przy 100 %.
  const board = page.getByTestId('canvas-board');
  const box = (await board.boundingBox())!;
  const at = (col: number, row: number) => ({ x: box.x + 40 + col * CANVAS_STEP.x + CANVAS_CARD.width / 2, y: box.y + 48 + row * CANVAS_STEP.y + 30 });

  // 3. Przeciąganie karteczki tam i z powrotem (bez zmiany danych) — podgląd komórek docelowych w każdej klatce.
  smooth('Przeciąganie karteczki (kl./s)', await frames(page, () => dragSlowly(page, at(0, 0), at(4, 2))));

  // 3a. Rysowanie strzałki: uchwyt (prawa krawędź karty (0, 0)) → karta (2, 3) (w obszarze tablicy), szkic w każdej klatce; menu zamyka Esc.
  const arrows = await page.locator('[data-canvas-arrows="base"] [data-canvas-arrow]').count();
  const handle = { x: box.x + 40 + CANVAS_CARD.width, y: box.y + 48 + CANVAS_CARD.height / 2 };
  smooth(`Rysowanie strzałki, ${arrows} strzałek na tablicy (kl./s)`, await frames(page, () => dragSlowly(page, handle, at(2, 3), false)));
  await expect(page.getByTestId('canvas-link-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // 4. Przesuwanie tablicy: chwyt w odstępie między kolumnami 0 i 1.
  const gap = { x: box.x + 40 + CANVAS_CARD.width + CANVAS_CARD.gap / 2, y: box.y + 48 + CANVAS_CARD.height / 2 };
  smooth('Przesuwanie tablicy (kl./s)', await frames(page, () => dragSlowly(page, gap, { x: gap.x - 300, y: gap.y - 200 }, false)));

  // 5. Powiększanie Ctrl+kółko: 15 kroków w dół i 15 w górę.
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(middle.x, middle.y);
  smooth(
    'Powiększanie Ctrl+kółko (kl./s)',
    await frames(page, async () => {
      await page.keyboard.down('Control');
      for (const dy of [...Array<number>(15).fill(120), ...Array<number>(15).fill(-120)]) {
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(16);
      }
      await page.keyboard.up('Control');
    }),
  );

  // 6. „Dopasuj”: cała tablica w obszarze (ok. 30 % — tytuły jeszcze widoczne albo same kolory).
  const fits: number[] = [];
  const zoomLabel = `document.querySelector('[data-testid=canvas-zoom]').textContent`;
  for (let i = 0; i < 5; i++) {
    await page.getByTestId('canvas-zoom').click();
    await expect(page.getByTestId('canvas-zoom')).toHaveText('100 %');
    fits.push(await timed(page, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dopasuj').click();`, `${zoomLabel} !== '100 %'`));
  }
  record('„Dopasuj” (100 % → cała tablica)', fits, `zoom ${await page.getByTestId('canvas-zoom').textContent()}`);

  // 7. Upuszczenie → karteczka narysowana w nowej komórce (zapis lokalny, odczyt, przeliczenie układu).
  // Wolne komórki są nad pierwszym wierszem; za każdym razem inna karteczka z wiersza 0 idzie o wiersz wyżej.
  await page.getByTestId('canvas-zoom').click();
  await expect(page.getByTestId('canvas-zoom')).toHaveText('100 %');
  await page.evaluate(() => localStorage.removeItem('tp-canvas-view'));
  await page.reload();
  await page.waitForFunction(new Function(`return ${allCards};`) as () => boolean, undefined, { timeout: 60_000 });
  const after = (await board.boundingBox())!;
  const cell = (col: number, row: number) => ({ x: after.x + 40 + col * CANVAS_STEP.x + CANVAS_CARD.width / 2, y: after.y + 48 + row * CANVAS_STEP.y + 30 });
  const drops: number[] = [];
  // Kolumny 0–3 mieszczą się w obszarze przy 1400 px.
  for (let col = 0; col < 4; col++) {
    const from = cell(col, 1);
    const to = { x: from.x, y: from.y - CANVAS_STEP.y };
    const id = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-canvas-card]')?.getAttribute('data-task-id') ?? '', [from.x, from.y]);
    expect(id).not.toBe('');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - 8, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    // Komórka zajęta (wiersz 0) → najbliższa wolna nad nią; czas od puszczenia do zmiany `top` karteczki.
    await page.evaluate((taskId) => {
      const w = window as unknown as { __drop: Promise<number> };
      const before = document.querySelector<HTMLElement>(`[data-canvas-card][data-task-id="${taskId}"]`)!.style.top;
      w.__drop = new Promise<number>((resolve) => {
        let t0 = 0;
        window.addEventListener('pointerup', () => (t0 = performance.now()), { capture: true, once: true });
        const check = () => {
          const now = document.querySelector<HTMLElement>(`[data-canvas-card][data-task-id="${taskId}"]`);
          if (t0 && now && now.style.top !== before && !now.style.transform) return requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
          requestAnimationFrame(check);
        };
        check();
      });
    }, id);
    await page.mouse.up();
    drops.push(await page.evaluate(() => (window as unknown as { __drop: Promise<number> }).__drop));
  }
  record('Upuszczenie karteczki → nowa komórka', drops);

  console.table(results.map((r) => ({ pomiar: r.name, mediana: Math.round(median(r.samples)), max: Math.round(max(r.samples)), uwagi: r.note ?? '' })));
  const out = fileURLToPath(new URL('../out/', import.meta.url));
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}perf-canvas.json`, JSON.stringify({ at: new Date().toISOString(), cards: CANVAS_PERF_CARDS, results }, null, 2));
});
