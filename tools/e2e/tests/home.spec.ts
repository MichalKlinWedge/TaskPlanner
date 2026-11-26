/** Strona startowa (v1.x): domyślna pod pustym `#`, pole dodaje do Inboxu, „Task Planner” w nagłówku do niej wraca. */
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('start: pulpit, dodanie do Inboxu i powrót z nagłówka', async ({ page, server }) => {
  await openApp(page, '');
  const home = page.getByTestId('home');
  await expect(home).toBeVisible();
  await expect(home.getByTestId('home-history')).toBeVisible();
  await expect(home.getByTestId('home-upcoming')).toBeVisible();

  const title = unique('Ze strony startowej');
  const input = home.getByRole('textbox', { name: /Dodaj do Inboxu/ });
  await input.fill(title);
  await input.press('Enter');
  const task = await server.waitForTask(title);
  expect(task).toMatchObject({ due_date: null, status: 'todo' });

  await page.getByRole('complementary', { name: 'Nawigacja' }).getByText('Inbox', { exact: true }).first().click();
  await expect(taskRow(page, title)).toBeVisible();

  await page.getByTestId('home-link').click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(home).toBeVisible();
});
