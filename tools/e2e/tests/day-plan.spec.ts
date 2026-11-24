/** „Plan dnia” obok „Dziś”: przełącznik „Dziś | Jutro” i „Ułóż dzień” na jutro. */
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
