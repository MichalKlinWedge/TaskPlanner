/** Szybkie dodawanie (M13): okno `Q`, chipy rozpoznanych fragmentów, zapis na serwerze. */
import { addDays, localDateAt } from '@taskplanner/core';

import { TIME_ZONE } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('okno Q: data, godzina, priorytet i czas trafiają do zadania', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Zapłacić rachunek');
  await page.keyboard.press('q');
  const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
  const input = dialog.getByRole('textbox', { name: 'Dodaj zadanie' });
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

test('okno Q: opis, termin i godzina z pól — pole wygrywa z datą we wpisie', async ({ page, server }) => {
  await openApp(page);
  const today = localDateAt(new Date(), TIME_ZONE);
  const day = addDays(today, 3);
  const title = unique('Spotkanie');
  await page.keyboard.press('q');
  const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
  // „Dziś” wypełnia termin, godzina pusta.
  const date = dialog.getByLabel('Termin', { exact: true });
  const time = dialog.getByLabel('Godzina', { exact: true });
  await expect(date).toHaveValue(today);
  await expect(time).toHaveValue('');
  const input = dialog.getByRole('textbox', { name: 'Dodaj zadanie' });
  await input.fill(`${title} jutro o 8 !wysoki`);
  await date.fill(day);
  await time.fill('16:30');
  await expect(dialog.getByRole('button', { name: /Termin: jutro — wygrywa pole/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Godzina: o 8 — wygrywa pole/ })).toBeVisible();
  const description = dialog.getByRole('textbox', { name: 'Opis' });
  await description.fill('Agenda:\n- punkt **pierwszy**');
  // Ctrl+Enter w opisie dodaje zadanie i zamyka okno.
  await description.press('Control+Enter');
  await expect(dialog).toBeHidden();

  const task = await server.waitForTask(title);
  expect(task).toMatchObject({ due_date: day, due_time: '16:30', priority: 2 });
  expect((task as unknown as { description_md: string | null }).description_md).toBe('Agenda:\n- punkt **pierwszy**');
});

test('okno Q: termin wyczyszczony — decyduje wpis; Ctrl+Enter czyści tylko opis', async ({ page, server }) => {
  await openApp(page);
  const first = unique('Pierwsze');
  const second = unique('Drugie');
  await page.keyboard.press('q');
  const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
  await dialog.getByRole('button', { name: /Wyczyść termin/ }).click();
  await expect(dialog.getByLabel('Termin', { exact: true })).toHaveValue('');
  const input = dialog.getByRole('textbox', { name: 'Dodaj zadanie' });
  const description = dialog.getByRole('textbox', { name: 'Opis' });
  await description.fill('Tylko pierwsze');
  await input.fill(first);
  await input.press('Control+Enter');
  await expect(description).toHaveValue('');
  await input.fill(`${second} pojutrze`);
  await input.press('Enter');
  await expect(dialog).toBeHidden();

  const one = await server.waitForTask(first);
  const two = await server.waitForTask(second);
  expect(one).toMatchObject({ due_date: null, due_time: null });
  expect((one as unknown as { description_md: string | null }).description_md).toBe('Tylko pierwsze');
  expect(two).toMatchObject({ due_date: addDays(localDateAt(new Date(), TIME_ZONE), 2) });
  expect((two as unknown as { description_md: string | null }).description_md).toBeNull();
});
