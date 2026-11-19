/** Przeciąganie myszą krokami — dnd-kit, FullCalendar i SVAR reagują na ruch wskaźnika, nie na `dragTo`. */
import type { Locator, Page } from '@playwright/test';

export async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Brak elementu do przeciągnięcia: ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 20) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Krótki ruch na start — próg aktywacji (dnd-kit: 4 px).
  await page.mouse.move(from.x + 8, from.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.move(to.x + 1, to.y);
  await page.mouse.up();
}
