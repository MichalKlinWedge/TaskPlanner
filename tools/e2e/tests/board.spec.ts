/** Kanban (M10): przeciągnięcie karty do innej kolumny zmienia status (także na serwerze). */
import { center, drag } from '../src/drag.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';
import { AUTH_FILE_2, sharedIds } from '../src/global-setup.ts';

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

test('karty listy „tylko podgląd” nie dają się chwycić', async ({ browser, server }) => {
  const { workspace } = sharedIds(server.userId);
  const title = 'Wspólny pomysł 1';
  const viewer = await server.client.from('scope_members').update({ role: 'viewer' }).eq('scope_id', workspace).neq('user_id', server.userId);
  expect(viewer.error).toBeNull();
  const use = test.info().project.use;
  const context = await browser.newContext({ baseURL: use.baseURL, locale: use.locale, timezoneId: use.timezoneId, viewport: use.viewport, storageState: AUTH_FILE_2 });
  const page = await context.newPage();
  try {
    await openApp(page, '#/board');
    const todo = page.getByRole('region', { name: 'Kolumna Do zrobienia' });
    const doing = page.getByRole('region', { name: 'Kolumna W trakcie' });
    const card = todo.locator('[data-card]').filter({ has: page.getByText(title, { exact: true }) });
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS('cursor', 'pointer');

    const before = await card.boundingBox();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    const target = await center(doing.locator('header'));
    await page.mouse.move(target.x, target.y, { steps: 20 });
    // W trakcie ruchu karta stoi w miejscu.
    expect(await card.boundingBox()).toEqual(before);
    await page.mouse.up();
    await expect(doing.locator('[data-card]').filter({ hasText: title })).toHaveCount(0);

    // Kliknięcie nadal otwiera zadanie.
    await card.click();
    await expect(page.getByRole('complementary').filter({ hasText: title })).toBeVisible();

    // Własna karta obok nadal się przenosi.
    const own = unique('Własna');
    await page.getByRole('textbox', { name: 'Dodaj kartę' }).first().fill(own);
    await page.keyboard.press('Enter');
    const ownCard = page.locator('[data-card]').filter({ hasText: own });
    await expect(ownCard).toBeVisible();
    await drag(page, await center(ownCard), await center(doing.locator('header')));
    await expect(doing.locator('[data-card]').filter({ hasText: own })).toBeVisible();
  } finally {
    await context.close();
    await server.resetSharedRoles(workspace);
  }
});
