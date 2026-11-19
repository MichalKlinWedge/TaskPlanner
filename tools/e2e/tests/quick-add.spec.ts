/** Szybkie dodawanie (M13): okno `Q`, chipy rozpoznanych fragmentów, zapis na serwerze. */
import { addDays, localDateAt } from '@taskplanner/core';

import { TIME_ZONE } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('okno Q: data, godzina, priorytet i czas trafiają do zadania', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Zapłacić rachunek');
  await page.keyboard.press('q');
  const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
  const input = dialog.getByRole('textbox');
  await input.fill(`${title} jutro o 10 !wysoki ~45m`);
  // Podgląd: tytuł bez rozpoznanych fragmentów i chipy z cofaniem.
  await expect(dialog.locator('#quick-add-preview strong')).toHaveText(title);
  await expect(dialog.getByRole('button', { name: /cofnij rozpoznanie/ })).toHaveCount(4);
  await input.press('Enter');
  await expect(dialog).toBeHidden();

  const tomorrow = addDays(localDateAt(new Date(), TIME_ZONE), 1);
  const task = await server.waitForTask(title);
  expect(task).toMatchObject({ due_date: tomorrow, due_time: '10:00', priority: 2, duration_min: 45, status: 'todo' });

  await page.getByRole('complementary', { name: 'Nawigacja' }).getByText('Nadchodzące').click();
  await expect(taskRow(page, title)).toBeVisible();
});

test('pole w „Dziś”: cofnięcie rozpoznania zostawia słowo w tytule', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Kupić');
  const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
  await input.fill(`${title} mleko jutro`);
  await page.getByRole('button', { name: /cofnij rozpoznanie/ }).click();
  await expect(page.locator('#quick-add-preview strong')).toHaveText(`${title} mleko jutro`);
  await input.press('Enter');

  const task = await server.waitForTask(`${title} mleko jutro`);
  // Pole w „Dziś” daje dzisiejszy termin, gdy wpis go nie podaje.
  expect(task.due_date).toBe(localDateAt(new Date(), TIME_ZONE));
  await expect(taskRow(page, `${title} mleko jutro`)).toBeVisible();
});
