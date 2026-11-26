/** Przegląd dnia i tygodnia: edycja zadania w prawym panelu, jak na listach. */
import { expect, openApp, test, unique } from '../src/fixtures.ts';

test('przegląd: panel zadania z kolejki dnia i z kroków tygodnia', async ({ page, server }) => {
  await openApp(page, '#/inbox');
  const first = unique('Przegląd A');
  const second = unique('Przegląd B');
  const later = unique('Przegląd C');
  for (const text of [`${first} dziś !krytyczny`, `${second} dziś !krytyczny`, `${later} jutro`]) {
    await page.keyboard.press('q');
    const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
    await dialog.getByRole('textbox', { name: 'Dodaj zadanie' }).fill(text);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
  }
  const ids = [await server.waitForTask(first), await server.waitForTask(second), await server.waitForTask(later)].map((t) => t.id);
  const panel = page.getByRole('complementary', { name: 'Zadanie', exact: true });
  const title = panel.getByRole('textbox', { name: 'Tytuł' });

  // ── Dzień ──
  await page.goto('/#/review/daily');
  const daily = page.getByTestId('review-daily');
  const card = page.getByTestId('review-task');
  await expect(card).toBeVisible();
  while (!(await card.textContent())?.includes('Przegląd ')) await page.keyboard.press('ArrowRight');
  const current = (await card.getByRole('button').first().textContent())!;
  const other = current === first ? second : first;

  // Enter otwiera edycję, Esc zamyka tylko panel.
  await page.keyboard.press('Enter');
  await expect(title).toHaveValue(current);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(daily).toBeVisible();

  // Podgląd z ikony, edycja z tytułu; zmiana tytułu widać na karcie.
  await card.getByTestId('review-preview').click();
  await expect(panel.getByTestId('task-preview')).toContainText(current);
  await card.getByRole('button', { name: current, exact: true }).click();
  await title.fill(`${current} zm`);
  await title.press('Tab');
  await expect(card).toContainText(`${current} zm`);
  // Cyfra wciśnięta w panelu nie jest decyzją.
  await panel.getByRole('button', { name: /^Podgląd zadania/ }).first().focus();
  await page.keyboard.press('1');
  await expect(card).toContainText(`${current} zm`);

  // Decyzja nie zamyka panelu — idzie on do następnego zadania.
  await daily.getByRole('button', { name: /Jutro/ }).click();
  await expect(title).toHaveValue(other);
  await expect(card).toContainText(other);
  await server.waitForTask(`${current} zm`);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Podsumowanie: zadanie z planu otwiera panel.
  await daily.getByRole('button', { name: 'Zakończ' }).click();
  await daily.getByRole('group', { name: 'Plan na', exact: true }).getByRole('button', { name: 'Jutro' }).click();
  await daily.locator(`[data-task-id="${ids[2]}"]`).getByRole('button', { name: later, exact: true }).click();
  await expect(title).toHaveValue(later);
  await page.keyboard.press('Escape');
  await expect(daily).toBeVisible();

  // ── Tydzień ──
  await page.goto('/#/review/weekly');
  const weekly = page.getByTestId('review-weekly');
  await weekly.getByRole('button', { name: /Inbox do zera/ }).click();
  const row = page.getByTestId('review-step-inbox').locator(`[data-task-id="${ids[2]}"]`);
  await row.getByRole('button', { name: later, exact: true }).click();
  await expect(title).toHaveValue(later);
  // Klawisz decyduje o zadaniu z panelu, a nie o pierwszym na liście; panel zostaje.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('1');
  await server.waitForTask(later, (t) => t.status === 'done');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(weekly).toBeVisible();

  await weekly.getByRole('button', { name: /Nadchodzący tydzień/ }).click();
  const tomorrow = ids[current === first ? 0 : 1];
  await page.getByTestId('review-step-upcoming').locator(`[data-task-id="${tomorrow}"]`).first().getByRole('button', { name: `${current} zm`, exact: true }).click();
  await expect(title).toHaveValue(`${current} zm`);
  // Esc przy panelu zamyka panel, dopiero drugi wychodzi z przeglądu.
  await page.keyboard.press('Escape');
  await expect(weekly).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(weekly).toHaveCount(0);

  await server.client.from('tasks').update({ deleted_at: new Date().toISOString() }).in('id', ids);
});
