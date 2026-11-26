/**
 * Centrum powiadomień (v1.x, N1): właściciel komentuje zadanie, za które odpowiada druga osoba — u niej dzwonek
 * pokazuje jedno powiadomienie (dwa komentarze z rzędu = „2 nowe komentarze”), klik otwiera zadanie i zaznacza
 * przeczytane na serwerze; autor nie dostaje nic o własnych zmianach (tylko wiersz drugiej osoby na serwerze). Dane: wspólna przestrzeń z `global-setup.ts`.
 */
import { uuidv7 } from '@taskplanner/core';
import type { Page } from '@playwright/test';

import { E2E_EMAIL_2 } from '../src/constants.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';
import { AUTH_FILE_2, sharedIds } from '../src/global-setup.ts';

test('komentarz → dzwonek u osoby odpowiedzialnej, klik otwiera zadanie', async ({ page, browser, server }) => {
  const { workspace } = sharedIds(server.userId);
  const db = server.client;
  const must = async (query: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await query;
    if (error) throw new Error(error.message);
  };
  // Zapis kluczem serwera nie ma autora — nie daje powiadomień; daje je dopiero komentarz z aplikacji.
  const [list, task, person] = [uuidv7(), uuidv7(), uuidv7()];
  const title = unique('Powiadomienie');
  await must(db.from('lists').insert({ id: list, scope_id: workspace, kind: 'list', name: unique('Powiadomienia'), sort_key: 'z' }));
  await must(db.from('collaborators').insert({ id: person, scope_id: server.userId, name: 'Druga E2E', email: E2E_EMAIL_2 }));
  await must(db.from('tasks').insert({ id: task, list_id: list, title, assignee_id: person, sort_key: 'a', created_by: server.userId }));

  const use = test.info().project.use;
  const other = await browser.newContext({ baseURL: use.baseURL, locale: use.locale, timezoneId: use.timezoneId, viewport: use.viewport, storageState: AUTH_FILE_2 });
  const second = await other.newPage();
  const notes = async () => (await db.from('notifications').select('user_id, kind, read_at, data').eq('task_id', task).eq('kind', 'comment')).data ?? [];
  const comment = async (p: Page, body: string) => {
    const field = p.getByRole('complementary', { name: 'Zadanie', exact: true }).getByLabel('Nowy komentarz');
    await field.fill(body);
    await field.press('Control+Enter');
    await expect(field).toHaveValue('');
  };
  try {
    await Promise.all([openApp(page, `#/list/${list}`), openApp(second, '#/today')]);
    await page.locator('main').getByText(title).first().click();
    await comment(page, 'Pierwszy komentarz');
    await comment(page, 'Czy już gotowe?');
    await expect.poll(async () => (await notes()).map((n) => [n.user_id === server.userId ? 'autor' : 'druga', (n.data as { count?: number }).count ?? 1])).toEqual([['druga', 2]]);

    // Druga osoba: licznik bez przeładowania (synchronizacja po sygnale Realtime), lista z tekstem z core.
    const bell = second.getByTestId('notifications-bell');
    // Inne testy mogą zostawić drugiej osobie własne powiadomienia — liczy się to jedno, z tytułem zadania.
    await expect(second.getByTestId('notifications-count')).toBeVisible({ timeout: 15_000 });
    await bell.click();
    const item = second.getByTestId('notifications-panel').getByTestId('notification').filter({ hasText: title });
    await expect(item).toContainText(`2 nowe komentarze w „${title}”`);
    await expect(item).toContainText('Ostatni — E2E');
    await item.getByRole('button', { name: new RegExp(title) }).click();
    await expect(second.getByRole('complementary', { name: 'Zadanie', exact: true })).toContainText(title);
    await expect.poll(async () => (await notes())[0]?.read_at ?? null).not.toBeNull();
    await bell.click();
    await second.getByTestId('notifications-panel').getByRole('button', { name: 'Wszystkie', exact: true }).click();
    await expect(item).toBeVisible();
    await expect(item).not.toHaveAttribute('data-unread');
  } finally {
    await other.close();
    const deleted_at = new Date().toISOString();
    await db.from('lists').update({ deleted_at }).eq('id', list);
    await db.from('tasks').update({ deleted_at }).eq('id', task);
    await db.from('collaborators').update({ deleted_at }).eq('id', person);
  }
});
