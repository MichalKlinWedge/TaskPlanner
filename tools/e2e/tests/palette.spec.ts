/** Paleta poleceń (M17): wyszukiwanie bez znaków diakrytycznych, otwarcie zadania, polecenie widoku. */
import { expect, openApp, test, unique } from '../src/fixtures.ts';

test('Ctrl+K: „zolwia” znajduje „żółwia”, Enter otwiera zadanie', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Nakarmić żółwia');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(title);
  await page.keyboard.press('Enter');
  await server.waitForTask(title);
  await page.locator('body').click({ position: { x: 5, y: 300 } });

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Paleta poleceń' });
  await palette.getByRole('textbox').fill(`nakarmic zolwia ${title.split(' ').at(-1)}`);
  const first = palette.getByRole('option').first();
  await expect(first).toContainText(title);
  await expect(first).toContainText('Inbox');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Zadanie' }).getByRole('textbox', { name: 'Tytuł' })).toHaveValue(title);
});

test('„>kalendarz” — polecenie przechodzi do widoku', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Paleta poleceń' });
  await palette.getByRole('textbox').fill('>kalendarz');
  await expect(palette.getByRole('option').first()).toContainText('Kalendarz');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/calendar$/);
  await expect(page.getByTestId('calendar')).toBeVisible();
});
