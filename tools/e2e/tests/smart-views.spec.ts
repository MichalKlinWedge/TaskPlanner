/** Widoki zbiorcze mają opcje widoku listy: „Lista | Tablica” i kolumny (zapis w profilu), tablica z tych samych zadań. */
import { addDays, localDateAt } from '@taskplanner/core';

import { TIME_ZONE } from '../src/constants.ts';
import { center, drag } from '../src/drag.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

const VIEWS = ['inbox', 'today', 'overdue', 'upcoming'] as const;

test('Inbox, Dziś, Zaległe i Nadchodzące: kolumny, tablica i XLSX', async ({ page, server }) => {
  await openApp(page);
  const today = localDateAt(new Date(), TIME_ZONE);
  const [now, old] = ['Raport', 'Faktura'].map(unique) as [string, string];
  const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
  for (const text of [now, `${old} ${addDays(today, -20).split('-').reverse().join('.')}`]) {
    await input.fill(text);
    await input.press('Enter');
    await expect(input).toHaveValue('');
  }
  await server.waitForTask(now);
  await server.waitForTask(old);

  for (const view of VIEWS) {
    await page.goto(`/#/${view}`);
    await expect(page.getByTestId('view-export')).toBeVisible();
    await page.getByTestId('list-columns').locator('summary').click();
    await page.getByRole('checkbox', { name: 'Koniec', exact: true }).click();
    await expect(page.getByTestId('list-columns-header').locator('[data-header="due"]')).toBeVisible();
  }
  // Kolumna stoi równo z nagłówkiem, także przy przyciskach „→ Dziś” / „→ Jutro”.
  await page.goto('/#/overdue');
  const cell = await taskRow(page, old).locator('[data-column="due"]').boundingBox();
  const head = await page.locator('[data-header="due"]').boundingBox();
  expect(Math.abs(cell!.x - head!.x)).toBeLessThan(2);

  // Zaległe na tablicy: dzień sprzed tygodnia w „Wcześniej”, bez dodawania.
  await page.getByRole('radio', { name: 'Tablica' }).click();
  const early = page.getByRole('region', { name: 'Kolumna Wcześniej' });
  await page.getByRole('combobox', { name: 'Kryterium kolumn' }).selectOption('weekday');
  await expect(early.locator('[data-card]').filter({ hasText: old })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Dodaj kartę' })).toHaveCount(0);

  // Dziś: nowa karta dostaje dzisiejszy termin, przeciągnięcie zmienia status; wybór zostaje po powrocie.
  await page.goto('/#/today');
  await expect(taskRow(page, now)).toBeVisible();
  await page.getByRole('radio', { name: 'Tablica' }).click();
  const todo = page.getByRole('region', { name: 'Kolumna Do zrobienia' });
  const doing = page.getByRole('region', { name: 'Kolumna W trakcie' });
  const added = unique('Karta');
  await doing.getByRole('textbox').fill(added);
  await doing.getByRole('textbox').press('Enter');
  expect(await server.waitForTask(added)).toMatchObject({ due_date: today, status: 'in_progress' });
  const card = todo.locator('[data-card]').filter({ hasText: now });
  await drag(page, await center(card), await center(doing.locator('header')));
  await server.waitForTask(now, (t) => t.status === 'in_progress');

  await page.goto('/#/upcoming');
  await page.getByRole('radio', { name: 'Tablica' }).click();
  await expect(page.getByTestId('board').locator('[data-column]').first()).toBeVisible();
  await expect(page.locator(`[data-column="${today}"] [data-card]`).filter({ hasText: now })).toBeVisible();
  await page.goto('/#/inbox');
  await page.getByRole('radio', { name: 'Tablica' }).click();
  await expect(todo).toBeVisible();

  await page.reload();
  await page.goto('/#/today');
  await expect(doing.locator('[data-card]').filter({ hasText: now })).toBeVisible();

  // Z powrotem na listę, bez kolumn — inne testy zakładają widok domyślny.
  for (const view of VIEWS) {
    await page.goto(`/#/${view}`);
    await page.getByRole('radio', { name: 'Lista' }).click();
    await page.getByTestId('list-columns').locator('summary').click();
    await page.getByRole('checkbox', { name: 'Koniec', exact: true }).click();
    await expect(page.getByTestId('list-columns-header')).toHaveCount(0);
  }

  // Zadania na dziś nie mogą zostać: kalendarz innych testów schowałby swoje pod „+więcej”.
  const { error } = await server.client.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('created_by', server.userId).in('title', [now, old, added]);
  expect(error).toBeNull();
});
