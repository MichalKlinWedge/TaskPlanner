/** Kalendarz (Etap 5, M11): zadanie z panelu na godzinę, potem przesunięcie bloku. */
import { defaultWorkspaceId } from '@taskplanner/core';

import { center, drag } from '../src/drag.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';

// Zadania z dzisiejszym terminem do kosza — nie wypychają pozycji z panelu i nie zapychają kalendarza kolejnym testom.
test.afterEach(async ({ server }) => {
  const prefixes = ['Blok', 'Trzymany', 'W trakcie', 'Klik'];
  const { error } = await server.client.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('scope_id', defaultWorkspaceId(server.userId, 'personal')).or(prefixes.map((t) => `title.like.${t} *`).join(','));
  expect(error).toBeNull();
});

test('zadanie z panelu na 10:00, blok przeciągnięty na 14:00', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Blok');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(title);
  await page.keyboard.press('Enter');
  await server.waitForTask(title);

  await page.goto('/#/calendar');
  const calendar = page.getByTestId('calendar');
  await calendar.getByRole('button', { name: 'Dzień', exact: true }).click();
  const lane = (time: string) => calendar.locator(`td.fc-timegrid-slot-lane[data-time="${time}"]`);
  await expect(lane('10:00:00')).toBeVisible();

  // Panel „Zadania bez godziny” → 10:00 (domyślny czas bloku 30 min).
  const item = page.getByTestId('calendar-panel').locator('[data-task]').filter({ hasText: title });
  const slot10 = await center(lane('10:00:00'));
  await drag(page, await center(item), { x: slot10.x, y: slot10.y - 5 });
  const block = calendar.locator('.fc-timegrid-event').filter({ hasText: title });
  await expect(block).toBeVisible();
  await server.waitForTask(title, (t) => t.due_time === '10:00');
  await expect(page.getByTestId('calendar-panel').locator('[data-task]').filter({ hasText: title })).toHaveCount(0);

  // Blok na 14:00: chwyt przy górnej krawędzi (środek bloku to granica komórek przyciągania co
  // 15 min), puszczenie tyle samo pod linią 14:00. Pozycja linii czytana jeszcze raz przed
  // puszczeniem — siatka potrafi się przewinąć w trakcie przeciągania.
  await expect(block).toContainText('10:00');
  const box = (await block.boundingBox())!;
  const x = box.x + box.width / 2;
  const top14 = async () => (await lane('14:00:00').boundingBox())!.y + 4;
  await page.mouse.move(x, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(x + 8, box.y + 4, { steps: 3 });
  await page.mouse.move(x, await top14(), { steps: 20 });
  await page.mouse.move(x, await top14(), { steps: 2 });
  await page.mouse.up();
  await server.waitForTask(title, (t) => t.due_time === '14:00');
  await expect(block).toContainText('14:00');
});

test('zmiana danych w trakcie przeciągania nie gubi upuszczenia', async ({ page, context, server }) => {
  await openApp(page);
  const title = unique('Trzymany');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(`${title} dziś 9:00`);
  await page.keyboard.press('Enter');
  await server.waitForTask(title, (t) => t.due_time === '09:00');
  const other = await context.newPage();
  await openApp(other);

  await page.goto('/#/calendar');
  const calendar = page.getByTestId('calendar');
  await calendar.getByRole('button', { name: 'Dzień', exact: true }).click();
  const block = calendar.locator('.fc-timegrid-event').filter({ hasText: title });
  await expect(block).toBeVisible();
  const box = (await block.boundingBox())!;
  const x = box.x + box.width / 2;
  const top12 = async () => (await calendar.locator('td.fc-timegrid-slot-lane[data-time="12:00:00"]').boundingBox())!.y + 4;
  await page.mouse.move(x, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(x + 8, box.y + 4, { steps: 3 });
  await page.mouse.move(x, await top12(), { steps: 20 });
  await page.mouse.move(x, await top12(), { steps: 2 });

  // Przycisk wciśnięty nad 12:00, a w drugiej karcie dochodzi zadanie — ekran kalendarza renderuje się od nowa.
  const added = unique('W trakcie');
  await other.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(added);
  await other.keyboard.press('Enter');
  await expect(page.getByTestId('calendar-panel').locator('[data-task]').filter({ hasText: added })).toBeVisible();
  await page.mouse.up();
  await server.waitForTask(title, (t) => t.due_time === '12:00');
  await expect(block).toContainText('12:00');
  await other.close();
});

test('klik w puste miejsce dodaje zadanie z datą i godziną', async ({ page, server }) => {
  await openApp(page);
  await page.goto('/#/calendar');
  const calendar = page.getByTestId('calendar');
  const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
  const field = dialog.getByRole('textbox', { name: 'Dodaj zadanie' });
  await calendar.getByRole('button', { name: 'Dzień', exact: true }).click();
  const today = (await calendar.locator('.fc-timegrid-col[data-date]').first().getAttribute('data-date'))!;

  // Dolna połowa komórki 16:30 — nadal 16:30 (pół godziny pod kursorem).
  const lane = calendar.locator('td.fc-timegrid-slot-lane[data-time="16:30:00"]');
  await lane.scrollIntoViewIfNeeded();
  const box = (await lane.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.75);
  await expect(dialog.getByRole('heading')).toContainText('16:30');
  const timed = unique('Klik');
  await field.fill(timed);
  await field.press('Enter');
  await expect(dialog).toBeHidden();
  await server.waitForTask(timed, (t) => t.due_date === today && t.due_time === '16:30');
  await expect(calendar.locator('.fc-timegrid-event').filter({ hasText: timed })).toBeVisible();

  // Klik w blok otwiera zadanie, nie dodawanie.
  await calendar.locator('.fc-timegrid-event').filter({ hasText: timed }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-task-panel]')).toBeVisible();
  await page.keyboard.press('Escape');

  // Wysokość wiersza: 15 min → klik daje kwadrans, 1 h → pełną godzinę; wybór przeżywa przeładowanie.
  const slots = calendar.getByRole('group', { name: 'Wysokość wiersza' });
  await expect(slots.getByRole('button', { name: '30 min' })).toHaveAttribute('aria-pressed', 'true');
  for (const [name, time, expected] of [['15 min', '17:15:00', '17:15'], ['1 h', '18:00:00', '18:00']] as const) {
    await slots.getByRole('button', { name, exact: true }).click();
    const row = calendar.locator(`td.fc-timegrid-slot-lane[data-time="${time}"]`);
    await row.scrollIntoViewIfNeeded();
    const rowBox = (await row.boundingBox())!;
    await page.mouse.click(rowBox.x + rowBox.width * 0.9, rowBox.y + rowBox.height * 0.75);
    await expect(dialog.getByRole('heading')).toContainText(expected);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
  await page.reload();
  await expect(slots.getByRole('button', { name: '1 h', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(calendar.locator('td.fc-timegrid-slot-lane')).toHaveCount(24);
  // Powrót z całej doby na ekranie → początek godzin pracy, nie północ.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await slots.getByRole('button', { name: '15 min', exact: true }).click();
  await expect(calendar.locator('td.fc-timegrid-slot-lane[data-time="09:00:00"]')).toBeInViewport();
  // Etykiety: przy 15 min „09:00” / „09:30”, przy 30 min „09”.
  const label = (time: string) => calendar.locator(`td.fc-timegrid-slot-label[data-time="${time}"]`);
  await expect(label('09:00:00')).toHaveText('09:00');
  await expect(label('09:30:00')).toHaveText('09:30');
  await slots.getByRole('button', { name: '30 min' }).click();
  await expect(label('09:00:00')).toHaveText('09');

  // Miesiąc: sam dzień; godzina z wpisu zostaje w klikniętym dniu.
  await calendar.getByRole('button', { name: 'Miesiąc', exact: true }).click();
  const cell = calendar.locator(`.fc-daygrid-day:not(.fc-day-today)`).last();
  const day = (await cell.getAttribute('data-date'))!;
  const cellBox = (await cell.boundingBox())!;
  await page.mouse.click(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height - 6);
  const dated = unique('Klik');
  await field.fill(`${dated} o 14`);
  await field.press('Enter');
  await server.waitForTask(dated, (t) => t.due_date === day && t.due_time === '14:00');
});
