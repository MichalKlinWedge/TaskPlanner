/**
 * Centrum powiadomień (v1.x, N1–N3): właściciel komentuje zadanie, za które odpowiada druga osoba — u niej dzwonek
 * pokazuje jedno powiadomienie (dwa komentarze z rzędu = „2 nowe komentarze”), klik otwiera zadanie i zaznacza
 * przeczytane na serwerze; autor nie dostaje nic o własnych zmianach (tylko wiersz drugiej osoby na serwerze). N3: zmiana
 * terminu przez właściciela → widok `#/notifications` z filtrem grupy. Dane: wspólna przestrzeń z `global-setup.ts`.
 */
import { addDays, localDateAt, localDateTimeAt, uuidv7 } from '@taskplanner/core';
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

test('wybite przypomnienie → w dzwonku „Przypomnienie: …”, klik otwiera zadanie, „Przypomnij za 15 min”, ukończone znika', async ({ page, server }) => {
  await openApp(page);
  const [title, closed] = [unique('Przypomnienie w dzwonku'), unique('Przypomnienie ukończone')];
  const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
  // Przypomnienie 1 min przed 0:01 dzisiaj — już wybite (test nie działa w pierwszych minutach doby).
  for (const t of [title, closed]) {
    await input.fill(`${t} dziś o 0:01 ^1m`);
    await input.press('Enter');
    await expect(input).toHaveValue('');
  }
  const task = await server.waitForTask(title);
  await server.waitForTask(closed);
  const bell = page.getByTestId('notifications-bell');
  const panel = page.getByTestId('notifications-panel');
  const item = panel.getByTestId('notification').filter({ hasText: title });
  await bell.click();
  await expect(item).toContainText(`Przypomnienie: „${title}”`);
  await expect(item).toHaveAttribute('data-unread');
  await item.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('complementary', { name: 'Zadanie', exact: true })).toContainText(title);
  await bell.click();
  await panel.getByRole('button', { name: 'Wszystkie', exact: true }).click();
  await expect(item).not.toHaveAttribute('data-unread');

  // „Przypomnij za 15 min” = jednorazowe przypomnienie na serwerze, wpis znika z dzwonka.
  await item.getByRole('group', { name: 'Przypomnij ponownie' }).getByRole('button', { name: '15 min' }).click();
  await expect(panel.getByTestId('notification-snoozed')).toContainText(`„${title}” — przypomnę o`);
  await expect(item).toHaveCount(0);
  await expect
    .poll(async () => ((await server.client.from('reminders').select('kind').eq('task_id', task.id).is('deleted_at', null)).data ?? []).map((r) => r.kind).sort())
    .toEqual(['absolute', 'relative']);

  // Ukończone zadanie znika z dzwonka.
  await page.keyboard.press('Escape');
  await taskRow(page, closed).getByRole('checkbox').first().click();
  await server.waitForTask(closed, (t) => t.status === 'done');
  await bell.click();
  await panel.getByRole('button', { name: 'Wszystkie', exact: true }).click();
  await expect(panel.getByTestId('notification').filter({ hasText: closed })).toHaveCount(0);
});

test('okno przypomnienia na środku ekranu: „Ukończ” i „Przypomnij za 30 min”', async ({ page, server }) => {
  await openApp(page, '#/settings/notifications');
  const mode = page.getByTestId('notifications-reminders');
  await mode.selectOption('popup');
  try {
    await page.evaluate(() => (location.hash = '#/today'));
    const [finish, later] = [unique('Okno ukończ'), unique('Okno później')];
    // Jednorazowe przypomnienie minutę temu — okno pokazuje przypomnienia z ostatnich 15 min.
    const at = localDateTimeAt(new Date(Date.now() - 60_000), TIME_ZONE).slice(11, 16);
    const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
    for (const t of [finish, later]) {
      await input.fill(`${t} dziś ^${at}`);
      await input.press('Enter');
      await expect(input).toHaveValue('');
    }
    const [a, b] = [await server.waitForTask(finish), await server.waitForTask(later)];
    const popup = page.getByTestId('reminder-popup');
    const handled = new Set<string>();
    // Inne testy mogą zostawić świeże przypomnienia — te zamykamy.
    for (let i = 0; i < 12 && handled.size < 2; i++) {
      await expect(popup).toBeVisible({ timeout: 45_000 });
      const title = (await popup.getByRole('heading').textContent()) ?? '';
      if (title === finish) {
        await popup.getByRole('button', { name: '✓ Ukończ' }).click();
        handled.add(finish);
      } else if (title === later) {
        await popup.getByRole('group', { name: 'Przypomnij ponownie' }).getByRole('button', { name: '30 min' }).click();
        handled.add(later);
      } else await popup.getByRole('button', { name: 'Zamknij (Esc)' }).click();
      await expect(popup.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    }
    expect([...handled].sort()).toEqual([finish, later].sort());
    await server.waitForTask(finish, (t) => t.status === 'done');
    await expect
      .poll(async () => ((await server.client.from('reminders').select('kind').eq('task_id', b.id).is('deleted_at', null)).data ?? []).length)
      .toBe(2);
    expect((await server.waitForTask(later)).status).toBe('todo');
    expect(a.id).not.toBe(b.id);
  } finally {
    await page.evaluate(() => (location.hash = '#/settings/notifications'));
    await mode.selectOption('app');
    await expect(mode).toHaveValue('app');
    await expect
      .poll(async () => ((await server.client.from('profiles').select('settings').eq('id', server.userId).single()).data?.settings as { notifications?: { reminders?: string } } | null)?.notifications?.reminders)
      .toBe('app');
  }
});

test('ustawienia: automatyczne przypomnienie o każdym zadaniu z godziną i wyciszony rodzaj', async ({ page, server }) => {
  const settings = async () =>
    ((await server.client.from('profiles').select('settings').eq('id', server.userId).single()).data?.settings as { notifications?: Record<string, unknown> } | null)?.notifications ?? {};
  await openApp(page, '#/settings/notifications');
  const auto = page.getByTestId('notifications-auto');
  try {
    // Zadanie z godziną minutę temu, bez przypomnienia, w przestrzeni jednej osoby: domyślnie („wspólne”) nic w dzwonku.
    await page.evaluate(() => (location.hash = '#/today'));
    const title = unique('Auto na czas');
    const at = localDateTimeAt(new Date(Date.now() - 60_000), TIME_ZONE).slice(11, 16);
    const input = page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' });
    await input.fill(`${title} dziś o ${at}`);
    await input.press('Enter');
    await server.waitForTask(title);
    const bell = page.getByTestId('notifications-bell');
    const panel = page.getByTestId('notifications-panel');
    const item = panel.getByTestId('notification').filter({ hasText: title });
    await bell.click();
    await panel.getByRole('button', { name: 'Wszystkie', exact: true }).click();
    await expect(item).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.evaluate(() => (location.hash = '#/settings/notifications'));
    await auto.selectOption('all');
    await expect.poll(async () => (await settings()).autoReminder).toBe('all');
    await bell.click();
    await panel.getByRole('button', { name: 'Wszystkie', exact: true }).click();
    await expect(item).toContainText(`Przypomnienie: „${title}”`, { timeout: 45_000 });
    await page.keyboard.press('Escape');

    // „Rodzaje”: odznaczone „Ukończenie…” trafia do `muted`.
    const kinds = page.getByTestId('notifications-kinds-tasks');
    await kinds.locator('summary').click();
    // Pola są sterowane z bazy (zapis przez `mutate`) — klik i czekanie na stan zamiast `uncheck()`.
    const completed = kinds.getByLabel('Ukończenie zadania przez kogoś innego');
    await completed.click();
    await expect(completed).not.toBeChecked();
    await expect(kinds.locator('summary')).toHaveText('Rodzaje: 4 z 5');
    await expect.poll(async () => (await settings()).muted).toEqual(['completed']);
    await page.getByTestId('notifications-follow-created').click();
    await expect(page.getByTestId('notifications-follow-created')).toBeChecked();
    await expect.poll(async () => (await settings()).follow).toEqual({ created: true, participating: false });
  } finally {
    await page.evaluate(() => (location.hash = '#/settings/notifications'));
    await auto.selectOption('shared');
    const kinds = page.getByTestId('notifications-kinds-tasks');
    if ((await kinds.getAttribute('open')) === null) await kinds.locator('summary').click();
    const completed = kinds.getByLabel('Ukończenie zadania przez kogoś innego');
    if (!(await completed.isChecked())) await completed.click();
    await expect(completed).toBeChecked();
    const follow = page.getByTestId('notifications-follow-created');
    if (await follow.isChecked()) await follow.click();
    await expect(follow).not.toBeChecked();
    await expect
      .poll(async () => {
        const n = await settings();
        return [n.autoReminder, n.muted, (n.follow as { created?: boolean } | undefined)?.created];
      })
      .toEqual(['shared', [], false]);
  }
});
