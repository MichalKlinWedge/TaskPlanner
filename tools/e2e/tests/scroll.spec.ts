/**
 * Przewija się tylko treść (`main`), nigdy cały dokument: tekst `sr-only` w znaczkach osób jest pozycjonowany
 * absolutnie i bez pozycjonowanego przodka wystawał poza okno (drugi pionowy suwak na tablicy).
 */
import { E2E_CANVAS } from '../src/constants.ts';
import { expect, openApp, test } from '../src/fixtures.ts';

test('tablica z osobami na kartach: jeden pionowy suwak', async ({ page }) => {
  // Niskie okno — karta z osobami leży poniżej krawędzi bez dziesiątek kart.
  await page.setViewportSize({ width: 1400, height: 260 });
  await openApp(page, '#/board');
  const card = page.getByTestId('board').getByText(E2E_CANVAS.first, { exact: true });
  await expect(card).toBeAttached();
  await expect(page.getByTestId('task-people').first()).toBeAttached();
  const size = () => page.evaluate(() => ({ document: document.documentElement.scrollHeight - window.innerHeight, main: document.querySelector('main')!.scrollHeight - document.querySelector('main')!.clientHeight }));
  expect((await size()).main).toBeGreaterThan(0);
  expect((await size()).document).toBe(0);
});
