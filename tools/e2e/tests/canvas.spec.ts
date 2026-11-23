/**
 * Widok „Karteczki” (v1.x): karteczka nie wchodzi na zajętą komórkę, karta z paska „Do ułożenia”
 * na tablicę, dwuklik dodaje karteczkę w komórce, kolejność tagów zmienia kolor, pełny ekran,
 * blokada edycji bez sieci. Dane listy z `global-setup.ts` (`canvasIds`).
 */
import type { Locator } from '@playwright/test';

import { E2E_CANVAS } from '../src/constants.ts';
import { center, drag } from '../src/drag.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';
import { canvasIds } from '../src/global-setup.ts';

/** Kolor w stylu karteczki (`color-mix(…)`), niezależnie od zapisu przeglądarki (hex / rgb). */
const hasColor = (card: Locator, hex: string, rgb: string) =>
  expect.poll(async () => {
    const style = ((await card.getAttribute('style')) ?? '').toLowerCase();
    return style.includes(hex.toLowerCase()) || style.includes(rgb);
  });

test('karteczki: przesuwanie bez nachodzenia, pasek, dodawanie, kolor z tagu, pełny ekran, offline', async ({ page, context, server }) => {
  const ids = canvasIds(server.userId);
  await openApp(page, `#/list/${ids.list}`);
  const view = page.getByTestId('canvas-view');
  const board = page.getByTestId('canvas-board');
  const tray = page.getByTestId('canvas-tray');
  const card = (id: string) => board.locator(`[data-canvas-card][data-task-id="${id}"]`);
  await expect(view).toBeVisible();
  await expect(board.locator('[data-canvas-card]')).toHaveCount(2);
  await expect(tray.getByText(E2E_CANVAS.tray)).toBeVisible();

  await test.step('ikona odpowiedzialnego i kolor pierwszego kolorowego tagu', async () => {
    await expect(card(ids.first).getByTestId('canvas-assignee')).toHaveText('ON');
    await hasColor(card(ids.first), '#3b82f6', 'rgb(59, 130, 246)').toBe(true);
  });

  await test.step('karteczka upuszczona na zajętą komórkę ląduje w najbliższej wolnej', async () => {
    await drag(page, await center(card(ids.first)), await center(card(ids.second)));
    // Komórka (1, 0) zajęta → najbliższa wolna przy remisie: wyższy wiersz → (1, −1).
    const moved = await server.waitForTask(E2E_CANVAS.first, (t) => t.canvas_pos?.row === -1);
    expect(moved.canvas_pos).toEqual({ col: 1, row: -1 });
    expect((await server.task(E2E_CANVAS.second))?.canvas_pos).toEqual({ col: 1, row: 0 });
  });

  await test.step('karta z paska „Do ułożenia” na tablicę', async () => {
    const target = await center(card(ids.second));
    await drag(page, await center(tray.getByText(E2E_CANVAS.tray)), { x: target.x + 2 * 204, y: target.y + 144 });
    await expect(card(ids.tray)).toBeVisible();
    await expect(tray.locator('[data-task-id]')).toHaveCount(0);
    await server.waitForTask(E2E_CANVAS.tray, (t) => t.canvas_pos !== null);
  });

  await test.step('dwuklik w puste miejsce dodaje karteczkę w tej komórce', async () => {
    const box = (await board.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width - 120, box.y + box.height - 100);
    const title = unique('Karteczka');
    await page.getByPlaceholder('Nowa karteczka — Enter dodaje, Esc zamyka').fill(title);
    await page.keyboard.press('Enter');
    const added = await server.waitForTask(title, (t) => t.canvas_pos !== null);
    await expect(card(added.id)).toBeVisible();
  });

  await test.step('kolejność tagów w panelu zadania zmienia kolor karteczki', async () => {
    // Karteczka w wierszu −1 wystaje nad obszar — najpierw cała tablica w widoku.
    await view.getByRole('button', { name: 'Dopasuj' }).click();
    await card(ids.first).dblclick();
    const chips = page.getByTestId('task-tag-chip');
    await expect(chips).toHaveCount(2);
    await chips.filter({ hasText: 'czerwony' }).dragTo(chips.filter({ hasText: 'niebieski' }));
    await expect(chips.first()).toContainText('czerwony');
    await hasColor(card(ids.first), '#ef4444', 'rgb(239, 68, 68)').toBe(true);
    await page.getByRole('button', { name: 'Zamknij panel (Esc)' }).click();
  });

  await test.step('pełny ekran i wyjście klawiszem Esc', async () => {
    await page.getByTestId('canvas-full').click();
    await expect(view).toHaveAttribute('data-full', 'true');
    await board.click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Escape');
    await expect(view).not.toHaveAttribute('data-full');
  });

  await test.step('bez sieci edycja zablokowana', async () => {
    await context.setOffline(true);
    await expect(page.getByTestId('canvas-note')).toBeVisible();
    await expect(view.getByRole('button', { name: '+ Karteczka' })).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByTestId('canvas-note')).toBeHidden();
  });
});
