/** Podgląd zadania: ikona w wierszu listy, tylko wypełnione dane, przejście podgląd ↔ edycja, podzadanie. */
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('podgląd zadania z listy i przejście do edycji i z powrotem', async ({ page, server }) => {
  await openApp(page, '#/inbox');
  const title = unique('Do podglądu');
  const step = unique('Krok podglądu');
  const bare = unique('Bez danych');

  for (const text of [`${title} jutro 14:30 !wysoki @podglad-tag`, bare]) {
    await page.keyboard.press('q');
    const input = page.getByRole('dialog', { name: 'Szybkie dodawanie' }).getByRole('textbox', { name: 'Dodaj zadanie' });
    await input.fill(text);
    await input.press('Enter');
    await page.keyboard.press('Escape');
  }
  await server.waitForTask(title);
  await server.waitForTask(bare);

  // Zwykły klik nadal otwiera formularz — tu dopisujemy opis, komentarz i podzadanie.
  const panel = page.getByRole('complementary', { name: 'Zadanie', exact: true });
  const preview = panel.getByTestId('task-preview');
  await taskRow(page, title).getByText(title).click();
  await expect(preview).toHaveCount(0);
  await panel.getByRole('button', { name: 'Markdown', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Nowy komentarz' }).fill('Komentarz do podglądu');
  await panel.getByRole('button', { name: 'Dodaj komentarz' }).click();
  await panel.getByPlaceholder('Dodaj podzadanie').fill(step);
  await panel.getByPlaceholder('Dodaj podzadanie').press('Enter');
  await server.waitForTask(step);
  // Niezapisany jeszcze opis (pole w edycji) zapisuje się przy przejściu do podglądu.
  await panel.getByRole('textbox', { name: 'Opis zadania (Markdown)' }).fill('Opis **ważny**');
  await panel.getByRole('button', { name: /^Podgląd zadania/ }).first().click();

  await expect(preview).toContainText(title);
  await expect(preview.getByText('ważny')).toBeVisible();
  await expect(preview).toContainText('14:30');
  await expect(preview).toContainText('Wysoki');
  await expect(preview).toContainText('podglad-tag');
  await expect(preview).toContainText('Komentarz do podglądu');
  await expect(preview.locator('[data-preview-section="Podzadania"]')).toContainText('0/1');
  await expect(preview.locator('input, textarea, select')).toHaveCount(0);

  // Podzadanie i powrót do rodzica zostają w podglądzie.
  await preview.getByRole('button', { name: step, exact: true }).click();
  await expect(preview.getByRole('heading', { name: step })).toBeVisible();
  await preview.getByRole('button', { name: `↑ ${title}` }).click();
  await expect(preview.getByRole('heading', { name: title })).toBeVisible();

  // Podgląd → edycja tego samego zadania.
  await panel.getByRole('button', { name: 'Edytuj zadanie' }).click();
  await expect(panel.getByRole('textbox', { name: 'Tytuł' })).toHaveValue(title);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Ikona w wierszu: zadanie bez danych pokazuje tylko to, co ma.
  await taskRow(page, bare).getByTestId('task-preview-open').click();
  await expect(preview.getByRole('heading', { name: bare })).toBeVisible();
  await expect(preview.locator('[data-preview-section]')).toHaveCount(0);
  await expect(preview.getByText('Termin', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});
