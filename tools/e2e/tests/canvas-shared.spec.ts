/**
 * Kryterium odbioru „Karteczek”: dwie osoby w tej samej udostępnionej przestrzeni układają naraz
 * 30 karteczek z paska „Do ułożenia” w to samo miejsce tablicy — karty nigdy nie nachodzą na siebie
 * (także gdy obie położą kartę w tej samej komórce, zanim dojdzie synchronizacja), obie osoby widzą
 * ten sam układ, a ruch jednej osoby widać u drugiej w < 5 s. Dane z `global-setup.ts` (`sharedIds`).
 */
import type { Page } from '@playwright/test';

import { E2E_SHARED_CARDS } from '../src/constants.ts';
import { center, drag } from '../src/drag.ts';
import { expect, openApp, test } from '../src/fixtures.ts';
import { AUTH_FILE_2, sharedIds } from '../src/global-setup.ts';

/** Układ kart w stronie: id → położenie w siatce (styl `left` / `top`) i prostokąty na ekranie. */
const cardsIn = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid=canvas-board] [data-canvas-card]')].map((card) => {
      const r = card.getBoundingClientRect();
      return { id: card.dataset.taskId!, at: `${card.style.left},${card.style.top}`, x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );

/** Para kart, które na siebie nachodzą (prostokąty o wspólnym polu), albo `null`. */
function overlap(cards: Awaited<ReturnType<typeof cardsIn>>) {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const [a, b] = [cards[i]!, cards[j]!];
      if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) return [a.id, b.id];
    }
  }
  return null;
}

/** Przeciąga kolejne karty z paska w środek tablicy, aż pasek będzie pusty (`from` = z którego końca paska). */
async function placeAll(page: Page, from: 'first' | 'last') {
  const tray = page.getByTestId('canvas-tray').locator('[data-task-id]');
  const board = page.getByTestId('canvas-board');
  // Obie osoby mogą brać tę samą kartę, zanim dojdzie synchronizacja — do skutku, najwyżej 2 × 30 prób.
  for (let i = 0; i < 2 * E2E_SHARED_CARDS; i++) {
    if (!(await tray.count())) return;
    try {
      // Krótki limit: karta mogła właśnie zniknąć z paska (bez niego `boundingBox` czeka do końca testu).
      const item = (await tray[from]().boundingBox({ timeout: 1_000 }))!;
      await drag(page, { x: item.x + item.width / 2, y: item.y + item.height / 2 }, await center(board), 8);
    } catch {
      // Karta zniknęła z paska w trakcie (położyła ją druga osoba) — następna.
    }
  }
}

test('dwie osoby układają 30 karteczek naraz bez nachodzenia', async ({ page, browser, server }) => {
  test.setTimeout(120_000);
  const { list } = sharedIds(server.userId);
  const use = test.info().project.use;
  const other = await browser.newContext({ baseURL: use.baseURL, locale: use.locale, timezoneId: use.timezoneId, viewport: use.viewport, storageState: AUTH_FILE_2 });
  const second = await other.newPage();
  try {
    await Promise.all([openApp(page, `#/list/${list}`), openApp(second, `#/list/${list}`)]);
    for (const p of [page, second]) await expect(p.getByTestId('canvas-tray').locator('[data-task-id]')).toHaveCount(E2E_SHARED_CARDS);

    // Obie osoby jednocześnie: jedna bierze karty z góry paska, druga z dołu — wszystkie w to samo miejsce.
    await Promise.all([placeAll(page, 'first'), placeAll(second, 'last')]);

    // Po synchronizacji: u obu 30 kart na tablicy, pusty pasek, ten sam układ i żadna para nie nachodzi.
    for (const p of [page, second]) {
      await expect(p.getByTestId('canvas-tray').locator('[data-task-id]')).toHaveCount(0, { timeout: 15_000 });
      await expect(p.getByTestId('canvas-board').locator('[data-canvas-card]')).toHaveCount(E2E_SHARED_CARDS);
    }
    await expect
      .poll(async () => {
        const [a, b] = await Promise.all([cardsIn(page), cardsIn(second)]);
        const layout = (cards: typeof a) => Object.fromEntries(cards.map((c) => [c.id, c.at]));
        return JSON.stringify(layout(a)) === JSON.stringify(layout(b));
      }, { timeout: 15_000, message: 'ten sam układ u obu osób' })
      .toBe(true);
    for (const p of [page, second]) expect(overlap(await cardsIn(p))).toBeNull();

    // Ruch jednej osoby u drugiej: najwyżej położona karta (cała tablica w widoku) strzałką w górę —
    // nad nią zawsze jest wolna komórka — i zmiana położenia u drugiej osoby.
    await page.getByTestId('canvas-view').getByRole('button', { name: 'Dopasuj' }).click();
    const card = (await cardsIn(page)).sort((a, b) => a.y - b.y)[0];
    const before = (await cardsIn(second)).find((c) => c.id === card!.id)!.at;
    await page.locator(`[data-canvas-card][data-task-id="${card!.id}"]`).click();
    const started = Date.now();
    await page.keyboard.press('ArrowUp');
    await expect
      .poll(async () => (await cardsIn(second)).find((c) => c.id === card!.id)?.at, { timeout: 5_000, intervals: [100], message: 'ruch widoczny u drugiej osoby w < 5 s' })
      .not.toBe(before);
    const seen = Date.now() - started;
    console.log(`Ruch karteczki widoczny u drugiej osoby po ${seen} ms`);
    expect(seen).toBeLessThan(5_000);
    expect(overlap(await cardsIn(second))).toBeNull();
  } finally {
    await other.close();
  }
});
