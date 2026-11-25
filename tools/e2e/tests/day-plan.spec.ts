/** „Plan dnia” obok „Dziś”: przełącznik „Dziś | Jutro”, „Ułóż dzień” na jutro i przeciąganie na osi. */
import type { Locator } from '@playwright/test';

import { center, drag } from '../src/drag.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';

test('„Jutro” w planie dnia: szkic przetrwa przełączenie, „Zastosuj” zapisuje jutrzejszą godzinę', async ({ page, server }) => {
  await openApp(page);
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return { date: new Intl.DateTimeFormat('sv-SE').format(d), weekend: d.getDay() === 0 || d.getDay() === 6 };
  });
  test.skip(tomorrow.weekend, 'Jutro jest dzień wolny od pracy — nie ma okien do układania.');

  const title = unique('Raport na rano');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(`${title} jutro`);
  await page.keyboard.press('Enter');
  const added = await server.waitForTask(title);
  expect(added.due_date).toBe(tomorrow.date);
  expect(added.due_time).toBeNull();

  const plan = page.getByTestId('day-plan');
  const days = plan.getByRole('group', { name: 'Plan na' });
  const draft = plan.getByTestId('plan-draft').filter({ hasText: title });
  await expect(days.getByRole('button', { name: 'Dziś' })).toHaveAttribute('aria-pressed', 'true');

  await days.getByRole('button', { name: 'Jutro' }).click();
  await expect(plan.getByLabel('Teraz')).toHaveCount(0);
  await plan.getByRole('button', { name: 'Ułóż dzień', exact: true }).click();
  await expect(draft).toBeVisible();

  await days.getByRole('button', { name: 'Dziś' }).click();
  await expect(draft).toHaveCount(0);
  await days.getByRole('button', { name: 'Jutro' }).click();
  await expect(draft).toBeVisible();

  await plan.getByRole('button', { name: /^Zastosuj/ }).click();
  await expect.poll(async () => (await server.task(title))?.due_time ?? null).not.toBeNull();
  expect((await server.task(title))?.due_date).toBe(tomorrow.date);
  await expect(plan.getByRole('button', { name: new RegExp(title) })).toBeVisible();
});

test('przeciąganie na osi: „cały dzień” na godzinę, blok na inną godzinę, „Cofnij”, Esc', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Przesuwane');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(`${title} jutro`);
  await page.keyboard.press('Enter');
  const added = await server.waitForTask(title);

  // Jutro — plan bez linii „Teraz” i bloków innych testów.
  const plan = page.getByTestId('day-plan');
  await plan.getByRole('group', { name: 'Plan na' }).getByRole('button', { name: 'Jutro' }).click();
  const axis = plan.getByTestId('plan-axis');
  const ghost = plan.getByTestId('plan-drag');
  /** Punkt na osi tuż pod linią godziny (linia = wiersz z podpisem). */
  const at = async (hour: string) => {
    const line = axis.locator('div').filter({ hasText: new RegExp(`^${hour}$`) });
    const [box, area] = [(await line.boundingBox())!, (await axis.boundingBox())!];
    return { x: area.x + area.width / 2, y: box.y + 2 };
  };
  const grip = async (el: Locator) => {
    const box = (await el.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + 3 };
  };

  const chip = plan.getByLabel('Cały dzień').getByRole('button', { name: title });
  await chip.scrollIntoViewIfNeeded();
  await drag(page, await center(chip), await at('10:00'));
  await server.waitForTask(title, (t) => t.due_time === '10:00' && t.due_date === added.due_date && t.duration_min === 30);
  await expect(chip).toHaveCount(0);

  const block = axis.getByRole('button', { name: new RegExp(title) });
  await expect(block).toContainText('10:00');
  await drag(page, await grip(block), await at('13:00'));
  await server.waitForTask(title, (t) => t.due_time === '13:00');
  await expect(block).toContainText('13:00');
  // Koniec przeciągania to nie kliknięcie — panel zadania się nie otwiera.
  await expect(page.getByRole('complementary', { name: 'Zadanie', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Cofnij' }).click();
  await server.waitForTask(title, (t) => t.due_time === '10:00');
  await expect(block).toContainText('10:00');

  // Esc w trakcie i puszczenie poza planem — bez zmian.
  const from = await grip(block);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 60, { steps: 5 });
  await expect(ghost).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ghost).toHaveCount(0);
  await page.mouse.up();
  const again = await grip(block);
  await drag(page, again, { x: again.x - 500, y: again.y });
  await expect(block).toContainText('10:00');
  expect((await server.task(title))?.due_time).toBe('10:00');
});
