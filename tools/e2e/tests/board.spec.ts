/** Kanban (M10): przeciągnięcie karty do innej kolumny zmienia status (także na serwerze). */
import { center, drag } from '../src/drag.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';

test('karta z „Do zrobienia” do „W trakcie”', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Karta');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(title);
  await page.keyboard.press('Enter');
  await server.waitForTask(title);

  await page.goto('/#/board');
  const todo = page.getByRole('region', { name: 'Kolumna Do zrobienia' });
  const doing = page.getByRole('region', { name: 'Kolumna W trakcie' });
  const card = todo.locator('[data-card]').filter({ hasText: title });
  await expect(card).toBeVisible();

  await drag(page, await center(card), await center(doing.locator('header')));
  await expect(doing.locator('[data-card]').filter({ hasText: title })).toBeVisible();
  await expect(todo.locator('[data-card]').filter({ hasText: title })).toHaveCount(0);
  await server.waitForTask(title, (t) => t.status === 'in_progress');
  // Komunikat z cofnięciem (przeniesienie między kolumnami).
  await expect(page.getByText(`„${title}” → W trakcie`)).toBeVisible();
});
