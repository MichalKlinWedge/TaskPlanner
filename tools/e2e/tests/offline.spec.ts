/**
 * Offline (M20, MVP-1): start bez sieci z pamięci Service Workera i lokalnej bazy (OPFS), zmiany
 * w kolejce, wysłanie po powrocie sieci. Tylko build produkcyjny (SW) — jak cały zestaw E2E.
 */
import type { Page } from '@playwright/test';

import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

/** SW kontroluje stronę i ma w pamięci stronę główną oraz SQLite WASM. */
async function offlineReady(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!navigator.serviceWorker.controller) return false;
          const needed = ['/', '/sqlite-wasm/index.mjs', '/sqlite-wasm/sqlite3.wasm'];
          return (await Promise.all(needed.map((path) => caches.match(path)))).every(Boolean);
        }),
      { timeout: 20_000, message: 'Service Worker gotowy do startu bez sieci' },
    )
    .toBe(true);
}

test('start bez sieci, zmiany offline, wysyłka po powrocie sieci', async ({ page, context, server }) => {
  await openApp(page);
  const existing = unique('Przed offline');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(existing);
  await page.keyboard.press('Enter');
  await server.waitForTask(existing);
  await offlineReady(page);

  await context.setOffline(true);
  await page.reload();
  // Powłoka i dane z lokalnej bazy, bez sieci.
  await expect(page.getByRole('complementary', { name: 'Nawigacja' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('sync-status')).toHaveText('Offline');
  await expect(taskRow(page, existing)).toBeVisible();

  const added = unique('Dodane offline');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(added);
  await page.keyboard.press('Enter');
  await expect(taskRow(page, added)).toBeVisible();
  await taskRow(page, existing).getByRole('checkbox', { name: `Ukończ „${existing}”` }).click();
  await expect(page.getByTestId('sync-status')).toHaveText(/^Offline — \d+ zmian czeka$/);
  // Serwer jeszcze nic nie wie.
  expect(await server.task(added)).toBeNull();
  expect((await server.task(existing))?.status).toBe('todo');

  await context.setOffline(false);
  await server.waitForTask(added);
  await server.waitForTask(existing, (t) => t.status === 'done');
  await expect(page.getByTestId('sync-status')).toHaveText('Zsynchronizowano', { timeout: 15_000 });
});
