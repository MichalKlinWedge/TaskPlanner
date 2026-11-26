/** Opis zadania: pole `[ ]` odhaczone w podglądzie zapisuje się w źródle Markdown (pola w bloku kodu się nie liczą). */
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

const description = (t: unknown) => (t as { description_md: string | null }).description_md ?? '';

test('odhaczenie pola listy zadań w podglądzie opisu', async ({ page, server }) => {
  await openApp(page, '#/inbox');
  const title = unique('Lista zakupów');
  await page.keyboard.press('q');
  const input = page.getByRole('dialog', { name: 'Szybkie dodawanie' }).getByRole('textbox');
  await input.fill(title);
  await input.press('Enter');
  await page.keyboard.press('Escape');
  await server.waitForTask(title);

  const panel = page.getByRole('complementary', { name: 'Zadanie', exact: true });
  await taskRow(page, title).getByText(title).click();
  await panel.getByRole('button', { name: 'Markdown', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Opis zadania (Markdown)' }).fill(['- [ ] mleko', '```', '- [ ] w kodzie', '```', '- [ ] chleb'].join('\n'));
  await panel.getByRole('button', { name: 'Podgląd', exact: true }).click();
  await server.waitForTask(title, (t) => description(t).includes('- [ ] chleb'));

  const preview = panel.getByTestId('description-preview');
  const boxes = preview.getByRole('checkbox');
  await expect(boxes).toHaveCount(2);
  await boxes.nth(1).click();
  await expect(boxes.nth(1)).toBeChecked();
  await server.waitForTask(title, (t) => description(t) === ['- [ ] mleko', '```', '- [ ] w kodzie', '```', '- [x] chleb'].join('\n'));

  // Drugi klik odznacza; pole w bloku kodu zostaje bez zmian.
  await boxes.nth(1).click();
  await expect(boxes.nth(1)).not.toBeChecked();
  await server.waitForTask(title, (t) => description(t).endsWith('- [ ] chleb') && description(t).includes('- [ ] w kodzie'));
});
