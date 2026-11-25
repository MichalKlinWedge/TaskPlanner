/** Dowolny kolor obok domyślnej palety: tag (szersza paleta, hex, zły zapis, Esc), grupa karteczek i nowa lista (Enter w polu hex nie wysyła formularza). */
import { E2E_PROJECT } from '../src/constants.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';
import { canvasIds } from '../src/global-setup.ts';

test('dowolny kolor tagu, grupy karteczek i listy', async ({ page, server }) => {
  const tag = unique('kolor').replace(' ', '-');
  const title = unique('Kolorowe');
  const tagColor = async () => (await server.client.from('tags').select('color').eq('created_by', server.userId).eq('name', tag).maybeSingle()).data?.color ?? null;
  await openApp(page);

  await test.step('tag: szersza paleta i hex', async () => {
    await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(`${title} @${tag}`);
    await page.keyboard.press('Enter');
    await server.waitForTask(title);
    await page.locator('#sidebar').getByRole('link', { name: `@${tag}` }).click();
    const picker = page.getByRole('radiogroup', { name: 'Kolor tagu' });
    const panel = picker.getByRole('group', { name: 'Wybór innego koloru' });
    await picker.getByRole('button', { name: 'Inny kolor', exact: true }).click();
    await page.screenshot({ path: 'out/custom-color-tag.png' });
    await panel.getByRole('button', { name: /^#/ }).nth(30).click();
    await expect(panel).toBeHidden();
    await expect.poll(tagColor).toMatch(/^#[0-9A-F]{6}$/);

    await picker.getByRole('button', { name: 'Inny kolor', exact: true }).click();
    const hex = panel.getByRole('textbox', { name: 'Kolor w zapisie #RRGGBB' });
    await hex.fill('#12');
    await expect(panel.getByRole('button', { name: 'Ustaw' })).toBeDisabled();
    await hex.press('Escape');
    await expect(panel).toBeHidden();

    await picker.getByRole('button', { name: 'Inny kolor', exact: true }).click();
    await panel.getByLabel('Próbnik kolorów').fill('#0abcde');
    await expect(hex).toHaveValue('#0ABCDE');
    await hex.fill('fd0');
    await panel.getByRole('button', { name: 'Ustaw' }).click();
    await expect.poll(tagColor).toBe('#FFDD00');
    await expect(picker.getByRole('button', { name: 'Inny kolor', exact: true })).toHaveAttribute('title', 'Inny kolor (#FFDD00)');
  });

  await test.step('panel zadania: kolor tagu', async () => {
    await page.locator('main [data-task-id]').filter({ hasText: title }).getByText(title).click();
    await page.getByRole('button', { name: `Kolor tagu ${tag}` }).click();
    const picker = page.getByRole('radiogroup', { name: `Kolor tagu ${tag}` });
    await picker.getByRole('button', { name: 'Inny kolor', exact: true }).click();
    await page.screenshot({ path: 'out/custom-color-panel.png' });
    await picker.getByRole('textbox', { name: 'Kolor w zapisie #RRGGBB' }).fill('#123ABC');
    await picker.getByRole('textbox', { name: 'Kolor w zapisie #RRGGBB' }).press('Enter');
    await expect.poll(tagColor).toBe('#123ABC');
  });

  await test.step('grupa karteczek', async () => {
    const list = canvasIds(server.userId).list;
    const groups = async () => ((await server.client.from('lists').select('canvas_groups').eq('id', list).single()).data!.canvas_groups ?? []) as { name: string; color: string | null }[];
    await openApp(page, `#/list/${list}`);
    const view = page.getByTestId('canvas-view');
    await view.getByRole('button', { name: 'Grupuj' }).click();
    await page.keyboard.type('Kolorowa');
    await page.keyboard.press('Enter');
    await view.getByRole('button', { name: 'Kolor grupy Kolorowa' }).click();
    const picker = view.getByRole('radiogroup', { name: 'Kolor grupy Kolorowa' });
    await picker.getByRole('button', { name: 'Inny kolor', exact: true }).click();
    await page.screenshot({ path: 'out/custom-color-group.png' });
    await picker.getByRole('textbox', { name: 'Kolor w zapisie #RRGGBB' }).fill('#00CCAA');
    await picker.getByRole('button', { name: 'Ustaw' }).click();
    await expect.poll(async () => (await groups()).find((g) => g.name === 'Kolorowa')?.color).toBe('#00CCAA');
    await view.getByRole('button', { name: 'Usuń grupę Kolorowa' }).click();
    await expect.poll(async () => (await groups()).some((g) => g.name === 'Kolorowa')).toBe(false);
  });

  await test.step('nowa lista: Enter w polu hex wybiera kolor, nie dodaje listy', async () => {
    await openApp(page, '#/manage');
    const name = unique('Lista kolor');
    const form = page.locator('li[data-list]').filter({ hasText: E2E_PROJECT }).locator('xpath=ancestor::ul[1]/following-sibling::form');
    await form.getByRole('textbox', { name: 'Nazwa nowej listy' }).fill(name);
    await form.getByRole('button', { name: 'Kolor nowej listy' }).click();
    await form.getByRole('button', { name: 'Inny kolor', exact: true }).click();
    await page.screenshot({ path: 'out/custom-color-list.png' });
    await form.getByRole('textbox', { name: 'Kolor w zapisie #RRGGBB' }).fill('#A1B2C3');
    await form.getByRole('textbox', { name: 'Kolor w zapisie #RRGGBB' }).press('Enter');
    await expect(form.getByRole('textbox', { name: 'Nazwa nowej listy' })).toHaveValue(name);
    await form.getByRole('button', { name: 'Dodaj', exact: true }).click();
    await expect.poll(async () => (await server.client.from('lists').select('color').eq('name', name).maybeSingle()).data?.color ?? null).toBe('#A1B2C3');
  });
});
