/** „Zaległe” (M9): dzisiejsze po godzinie i z wcześniejszych dni; bez godziny i przed godziną — nie. */
import { addDays, localDateAt } from '@taskplanner/core';

import { TIME_ZONE } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('„Zaległe” pokazuje zadania po terminie, także z dzisiaj po godzinie', async ({ page, server }) => {
  await openApp(page);
  const today = localDateAt(new Date(), TIME_ZONE);
  const [late, later, whole, old] = ['Po godzinie', 'Przed godziną', 'Bez godziny', 'Z dawna'].map(unique) as [string, string, string, string];
  const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
  for (const text of [`${late} dziś o 0:01`, `${later} dziś o 23:59`, whole, `${old} ${addDays(today, -3).split('-').reverse().join('.')}`]) {
    await input.fill(text);
    await input.press('Enter');
    await expect(input).toHaveValue('');
  }
  expect(await server.waitForTask(late)).toMatchObject({ due_date: today, due_time: '00:01' });
  expect(await server.waitForTask(old)).toMatchObject({ due_date: addDays(today, -3) });

  const nav = page.getByRole('complementary', { name: 'Nawigacja' }).getByRole('link', { name: /Zaległe/ });
  const counter = async () => Number((await nav.textContent())!.match(/\d+/)?.[0] ?? 0);
  const before = await counter();
  await nav.click();
  await expect(page.getByRole('heading', { name: 'Zaległe', level: 1 })).toBeVisible();
  await expect(taskRow(page, late).getByTestId('task-late')).toBeVisible();
  await expect(taskRow(page, old)).toBeVisible();
  await expect(taskRow(page, later)).toHaveCount(0);
  await expect(taskRow(page, whole)).toHaveCount(0);

  // Ukończone znika z widoku i z licznika.
  await taskRow(page, late).getByRole('checkbox').first().click();
  await expect(taskRow(page, late)).toHaveCount(0);
  await expect.poll(counter).toBe(before - 1);

  // „→ Dziś”: zaległe z dawna przechodzi na dziś, czyli znika stąd; „Cofnij” je przywraca.
  await taskRow(page, old).getByTestId('task-today').click();
  await expect(taskRow(page, old)).toHaveCount(0);
  await server.waitForTask(old, (t) => t.due_date === today);
  await page.getByRole('button', { name: 'Cofnij' }).last().click();
  await expect(taskRow(page, old)).toBeVisible();

  // Skrót G Z.
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page.getByRole('heading', { name: 'Dziś', level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('z');
  await expect(page.getByRole('heading', { name: 'Zaległe', level: 1 })).toBeVisible();
});

test('zadanie po godzinie zostaje czerwone, gdy jest zaznaczone (otwarte w panelu)', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Po czasie zaznaczone');
  const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
  await input.fill(`${title} dziś o 0:01`);
  await input.press('Enter');
  await server.waitForTask(title);
  const row = taskRow(page, title);
  // Kolor tła jako RGB (color-mix daje w stylu inny zapis niż `rgb()`): przez płótno.
  const background = () =>
    row.evaluate((el) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(',');
    });
  const late = await background();
  await row.getByText(title).click();
  await expect(page.getByRole('complementary', { name: 'Zadanie', exact: true })).toContainText(title);
  // Zaznaczenie zmienia pasek po lewej, ale tło dalej jest czerwonawe (nie zwykłe tło zaznaczenia).
  await expect.poll(background).not.toBe(late);
  const [r, g, b] = (await background()).split(',').map(Number) as [number, number, number];
  expect(r).toBeGreaterThan(g);
  expect(r).toBeGreaterThan(b);
});
