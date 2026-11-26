/**
 * Centrum powiadomień (v1.x, N1–N3): właściciel komentuje zadanie, za które odpowiada druga osoba — u niej dzwonek
 * pokazuje jedno powiadomienie (dwa komentarze z rzędu = „2 nowe komentarze”), klik otwiera zadanie i zaznacza
 * przeczytane na serwerze; autor nie dostaje nic o własnych zmianach (tylko wiersz drugiej osoby na serwerze). N3: zmiana
 * terminu przez właściciela → widok `#/notifications` z filtrem grupy. Dane: wspólna przestrzeń z `global-setup.ts`.
 */
import { addDays, localDateAt, uuidv7 } from '@taskplanner/core';
import type { Page } from '@playwright/test';

import { E2E_EMAIL_2, TIME_ZONE } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';
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

test('zmiana terminu przez właściciela → widok „Powiadomienia” z filtrami u osoby odpowiedzialnej', async ({ page, browser, server }) => {
  const { workspace } = sharedIds(server.userId);
  const db = server.client;
  const must = async (query: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await query;
    if (error) throw new Error(error.message);
  };
  const use = test.info().project.use;
  const today = localDateAt(new Date(), TIME_ZONE);
  const [list, task, person] = [uuidv7(), uuidv7(), uuidv7()];
  const title = unique('Termin');
  await must(db.from('lists').insert({ id: list, scope_id: workspace, kind: 'list', name: unique('Terminy'), sort_key: 'z' }));
  await must(db.from('collaborators').insert({ id: person, scope_id: server.userId, name: 'Druga E2E', email: E2E_EMAIL_2 }));
  await must(db.from('tasks').insert({ id: task, list_id: list, title, assignee_id: person, due_date: addDays(today, 5), sort_key: 'a', created_by: server.userId }));

  const other = await browser.newContext({ baseURL: use.baseURL, locale: use.locale, timezoneId: use.timezoneId, viewport: use.viewport, storageState: AUTH_FILE_2 });
  const second = await other.newPage();
  const notes = async () => (await db.from('notifications').select('data').eq('task_id', task).eq('kind', 'due_changed')).data ?? [];
  try {
    await Promise.all([openApp(page, `#/list/${list}`), openApp(second, '#/notifications')]);
    await taskRow(page, title).getByText(title).click({ modifiers: ['Control'] });
    await page.getByTestId('bulk-bar').getByTitle('Na jutro (M)').click();
    await expect.poll(async () => (await notes()).map((n) => (n.data as { due?: string }).due)).toEqual([addDays(today, 1)]);

    const screen = second.getByTestId('notifications-screen');
    const item = screen.getByTestId('notification').filter({ hasText: title });
    await expect(item).toContainText(`Nowy termin zadania „${title}”`, { timeout: 15_000 });
    await expect(item).toContainText('Było:');
    await screen.getByTestId('notifications-group-system').click();
    await expect(item).toHaveCount(0);
    await screen.getByTestId('notifications-group-tasks').click();
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: new RegExp(title) }).click();
    await expect(second.getByRole('complementary', { name: 'Zadanie', exact: true })).toContainText(title);
    await expect(item).not.toHaveAttribute('data-unread');
  } finally {
    await other.close();
    const deleted_at = new Date().toISOString();
    await db.from('lists').update({ deleted_at }).eq('id', list);
    await db.from('tasks').update({ deleted_at }).eq('id', task);
    await db.from('collaborators').update({ deleted_at }).eq('id', person);
  }
});

test('wybite przypomnienie → w dzwonku „Przypomnienie: …”, klik otwiera zadanie i oznacza przeczytane', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Przypomnienie w dzwonku');
  const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
  // Przypomnienie 1 min przed 0:01 dzisiaj — już wybite (test nie działa w pierwszych minutach doby).
  await input.fill(`${title} dziś o 0:01 ^1m`);
  await input.press('Enter');
  await server.waitForTask(title);
  await page.getByTestId('notifications-bell').click();
  const panel = page.getByTestId('notifications-panel');
  const item = panel.getByTestId('notification').filter({ hasText: title });
  await expect(item).toContainText(`Przypomnienie: „${title}”`);
  await expect(item).toHaveAttribute('data-unread');
  await item.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('complementary', { name: 'Zadanie', exact: true })).toContainText(title);
  await page.getByTestId('notifications-bell').click();
  await panel.getByRole('button', { name: 'Wszystkie', exact: true }).click();
  await expect(item).not.toHaveAttribute('data-unread');
  // Ukończone zadanie znika z dzwonka.
  await page.keyboard.press('Escape');
  await taskRow(page, title).getByRole('checkbox').first().click();
  await server.waitForTask(title, (t) => t.status === 'done');
  await page.getByTestId('notifications-bell').click();
  await expect(item).toHaveCount(0);
});
