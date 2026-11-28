/**
 * Web jak telefon (docs/BACKLOG_WEB_APK.md, P2 web): status, rodzaj, kolor i usunięcie listy, szukanie
 * w opisach, chipy filtra w kolejnych widokach, tagi w wierszu, karta tablicy, akcje powiadomienia
 * o zadaniu, wylogowanie tylko tej przeglądarki, filtr zmieniony na innym urządzeniu.
 */
import type { Page } from '@playwright/test';

import { canvasIds } from '../src/global-setup.ts';
import { E2E_CANVAS, E2E_PROJECT } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique, type Server } from '../src/fixtures.ts';

const work = async (server: Server) => String((await server.client.from('lists').select('scope_id').eq('id', canvasIds(server.userId).list).single()).data!.scope_id);

async function listRow(server: Server, name: string) {
  const { data } = await server.client.from('lists').select('id, kind, color, project_status, start_date, end_date, deleted_at').eq('scope_id', await work(server)).eq('name', name).maybeSingle();
  return data;
}

async function addToday(page: Page, server: Server, title: string, rest = '') {
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(title + rest);
  await page.keyboard.press('Enter');
  return server.waitForTask(title);
}

/** Chip „+ Filtr” → pole → pozycja; zamyka okienko. */
async function addFilter(page: Page, within: ReturnType<Page['locator']>, field: string, option: string) {
  const bar = within.getByRole('group', { name: 'Filtry' });
  await bar.getByRole('button', { name: '+ Filtr' }).click();
  await bar.getByRole('button', { name: field, exact: true }).click();
  await bar.getByText(option, { exact: true }).click();
  await page.keyboard.press('Escape');
}

test('W-01, W-02: status projektu, kolor przy tworzeniu, rodzaj i usunięcie pustej listy', async ({ page, server }) => {
  await openApp(page, '#/manage');
  const name = unique('Lista');
  // Formularz nowej listy w przestrzeni projektu E2E.
  const form = page.locator('li[data-list]').filter({ hasText: E2E_PROJECT }).locator('xpath=ancestor::ul[1]/following-sibling::form');
  await form.getByRole('button', { name: 'Kolor nowej listy' }).click();
  await form.getByRole('option').nth(2).click();
  await form.getByRole('textbox', { name: 'Nazwa nowej listy' }).fill(name);
  await form.getByRole('button', { name: 'Dodaj', exact: true }).click();
  await expect.poll(async () => (await listRow(server, name))?.color).toMatch(/^#/);

  const row = page.locator('li[data-list]').filter({ hasText: name });
  await row.getByRole('combobox', { name: `Rodzaj: ${name}` }).selectOption('project');
  await row.getByRole('combobox', { name: `Status projektu: ${name}` }).selectOption('on_hold');
  await expect.poll(async () => (await listRow(server, name))?.project_status).toBe('on_hold');
  await row.getByRole('combobox', { name: `Rodzaj: ${name}` }).selectOption('list');
  await expect.poll(async () => (await listRow(server, name))?.project_status).toBeNull();

  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await listRow(server, name))?.deleted_at).not.toBeNull();
  // Lista z zadaniami — bez „Usuń”.
  await expect(page.locator('li[data-list]').filter({ hasText: E2E_PROJECT }).getByRole('button', { name: 'Usuń', exact: true })).toHaveCount(0);

  // Nagłówek projektu, z „Cofnij”.
  await page.locator('#sidebar').getByRole('link', { name: E2E_PROJECT }).click();
  const status = page.getByRole('combobox', { name: `Status projektu: ${E2E_PROJECT}` });
  await status.selectOption('done');
  await expect.poll(async () => (await listRow(server, E2E_PROJECT))?.project_status).toBe('done');
  await page.getByRole('status').getByRole('button', { name: 'Cofnij' }).click();
  await expect(status).toHaveValue('active');
});

test('W-03, W-05: paleta szuka w opisach, filtr zawęża do zadań', async ({ page, server }) => {
  await openApp(page);
  const a = unique('Pierwsze');
  const b = unique('Drugie');
  const word = `kryptonim${Date.now().toString(36)}`;
  const first = await addToday(page, server, a, ' !1');
  const second = await addToday(page, server, b);
  for (const id of [first.id, second.id]) {
    const { error } = await server.client.from('tasks').update({ description_md: `Opis: ${word}` }).eq('id', id);
    if (error) throw new Error(error.message);
  }
  await page.reload();
  await openApp(page);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Paleta poleceń' });
  await palette.getByRole('textbox').fill(word);
  await expect(palette.getByRole('option')).toHaveCount(2);
  await addFilter(page, palette, 'Priorytet', 'Krytyczny');
  // Esc zamknął okienko filtra, nie paletę.
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette.getByRole('option')).toContainText(a);
  await palette.getByRole('button', { name: 'Wyczyść' }).click();
  await expect(palette.getByRole('option')).toHaveCount(2);
  await expect(palette.getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('W-05: chipy w koszu, kalendarzu, cyklicznych i przeglądzie tygodnia', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Kosz');
  const tag = `tag${Date.now().toString(36)}`;
  await addToday(page, server, `${title}`);
  const tagged = unique('Otagowane');
  await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(`${tagged} @${tag}`);
  await page.keyboard.press('Enter');
  const task = await server.waitForTask(tagged);
  const main = page.locator('main');

  // W-06: tag w wierszu widoku „Dziś”.
  await expect(taskRow(page, tagged).locator('[data-tag]')).toHaveText(tag);

  await page.goto('/#/calendar');
  const block = page.getByTestId('calendar').locator('.fc-event').filter({ hasText: title });
  await expect(block.first()).toBeVisible();
  await addFilter(page, main, 'Tagi', tag);
  await expect(block).toHaveCount(0);
  await expect(page.getByTestId('calendar').locator('.fc-event').filter({ hasText: tagged }).first()).toBeVisible();

  await page.goto('/#/habits');
  await expect(main.getByRole('group', { name: 'Filtry' })).toBeVisible();

  await page.goto('/#/review/weekly');
  await page.getByRole('button', { name: /Inbox do zera/ }).click();
  const inbox = page.getByTestId('review-step-inbox');
  await expect(inbox.getByText(title)).toBeVisible();
  await addFilter(page, inbox, 'Tagi', tag);
  // Esc zamknął okienko filtra, nie przegląd.
  await expect(inbox.getByText(tagged)).toBeVisible();
  await expect(inbox.getByText(title)).toHaveCount(0);
  await page.getByRole('button', { name: /Projekty bez/ }).click();
  await expect(page.getByTestId('review-step-projects').getByRole('group', { name: 'Filtry' })).toHaveCount(0);

  const other = await server.waitForTask(title);
  const now = new Date().toISOString();
  await server.client.from('tasks').update({ deleted_at: now }).in('id', [task.id, other.id]);
  await page.goto('/#/trash');
  await page.reload();
  await expect(main.getByText(tagged, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText(title, { exact: true })).toBeVisible();
  await addFilter(page, main, 'Tagi', tag);
  await expect(main.getByText(title, { exact: true })).toHaveCount(0);
  await expect(main.getByText(tagged, { exact: true })).toBeVisible();
});

test('W-08: karta tablicy — osoby, status i kółko', async ({ page, server }) => {
  await openApp(page, '#/board');
  const card = page.locator('[data-card]').filter({ hasText: E2E_CANVAS.first });
  await expect(card.getByTestId('task-people')).toContainText('ON');
  await openApp(page);
  const title = unique('Karta z kółkiem');
  const task = await addToday(page, server, title);
  await server.client.from('tasks').update({ status: 'waiting' }).eq('id', task.id);
  await page.goto('/#/board');
  await page.reload();
  const mine = page.locator('[data-card]').filter({ hasText: title });
  await expect(mine).toBeVisible({ timeout: 30_000 });
  await page.getByRole('combobox', { name: 'Kryterium kolumn' }).selectOption('priority');
  await expect(mine.getByText('oczekuje')).toBeVisible();
  // Klik w kółko kończy, nie otwiera panelu; klawiatura nie podnosi karty.
  await mine.getByRole('checkbox', { name: `Ukończ „${title}”` }).click();
  await server.waitForTask(title, (t) => t.status === 'done');
  await expect(page.getByRole('complementary', { name: 'Zadanie' })).toHaveCount(0);
});

/** Akcja powiadomienia przez prawdziwe handlery Service Workera (`push` → `notificationclick`). */
async function notificationAction(page: Page, taskId: string, key: string, action: string): Promise<string[]> {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const worker = page.context().serviceWorkers()[0] ?? (await page.context().waitForEvent('serviceworker'));
  return worker.evaluate(
    async ([id, fireKey, act]) => {
      /* eslint-disable @typescript-eslint/no-explicit-any -- typy Service Workera poza zakresem testu */
      const sw = self as any;
      const fire = (event: any) => {
        try {
          sw.dispatchEvent(event);
        } catch {
          // `waitUntil` na zdarzeniu z testu rzuca, ale handler już działa.
        }
      };
      // Chromium bez okna nie pokazuje powiadomień — przechwycone opcje zastępują systemowe okienko.
      const shown = new Promise<any>((resolve) => {
        sw.registration.showNotification = (_title: string, options: any) => Promise.resolve(resolve(options));
      });
      fire(new sw.PushEvent('push', { data: JSON.stringify({ key: fireKey, title: 'Przypomnienie', body: '', taskId: id, url: `/?task=${id}` }) }));
      const options = await shown;
      fire(Object.assign(new sw.ExtendableEvent('notificationclick'), { notification: { data: options.data, close: () => undefined }, action: act }));
      return options.actions.map((a: { title: string }) => a.title);
    },
    [taskId, key, action] as const,
  );
}

test('W-07: „Odłóż 10 min” i „Ukończ” z powiadomienia (otwarta karta)', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Przypomniane');
  const task = await addToday(page, server, title);
  const key = `00000000-0000-4000-8000-000000000001:${task.due_date}`;
  const reminders = async () => (await server.client.from('reminders').select('kind, at_date, at_time, deleted_at').eq('task_id', task.id)).data ?? [];

  expect(await notificationAction(page, task.id, key, 'snooze')).toEqual(['Ukończ', 'Odłóż 10 min']);
  await expect(page.getByText(/przypomnienie o \d\d:\d\d/)).toBeVisible();
  await expect.poll(async () => (await reminders()).filter((r) => r.kind === 'absolute' && !r.deleted_at).length).toBe(1);

  await notificationAction(page, task.id, key, 'done');
  await server.waitForTask(title, (t) => t.status === 'done');
  // Odłożone przypomnienie znika razem z ukończeniem.
  await expect.poll(async () => (await reminders()).filter((r) => !r.deleted_at).length).toBe(0);
  // Powtórzona akcja nic nie zmienia.
  await notificationAction(page, task.id, key, 'done');
  await expect(page.getByText(/powiadomienie jest nieaktualne/)).toBeVisible();
});

test('W-07: „Ukończ” przy zamkniętej karcie (nowa karta z parametrami)', async ({ page, server }) => {
  await openApp(page);
  const title = unique('Z zamkniętej karty');
  const task = await addToday(page, server, title);
  await page.goto('about:blank');
  await page.goto(`/?reminderAction=done&reminderTask=${task.id}&reminderKey=${encodeURIComponent(`x:${task.due_date}`)}#/today`);
  await server.waitForTask(title, (t) => t.status === 'done', 30_000);
  await expect(page).toHaveURL(/\/#\/today$/);
});

test('R-02: zapisany filtr zmieniony na innym urządzeniu zastępuje szkic', async ({ page, server }) => {
  await openApp(page);
  const name = unique('Filtr');
  const main = page.locator('main');
  await addFilter(page, main, 'Priorytet', 'Wysoki');
  await main.getByRole('button', { name: 'Zapisz jako filtr' }).click();
  await main.getByRole('textbox', { name: /nazwa/i }).fill(name);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/filter\//);
  const id = page.url().split('/').at(-1)!;
  await expect.poll(async () => (await server.client.from('saved_filters').select('id').eq('id', id).maybeSingle()).data?.id).toBe(id);

  await main.getByRole('button', { name: 'Usuń filtr: ' }).first().click().catch(() => undefined);
  await addFilter(page, main, 'Godzina', 'Z godziną');
  await expect(main.getByRole('button', { name: 'Zapisz zmiany' })).toBeVisible();
  const { error } = await server.client.from('saved_filters').update({ query: { priorities: [4] } }).eq('id', id);
  if (error) throw new Error(error.message);
  await expect(main.getByRole('button', { name: 'Zapisz zmiany' })).toHaveCount(0, { timeout: 30_000 });
  await expect(main.getByRole('button', { name: 'Usuń filtr: Godzina' })).toHaveCount(0);
});

test('R-01: wylogowanie kończy tylko sesję tej przeglądarki', async ({ page }) => {
  await openApp(page);
  let scope: string | null = null;
  // Odpowiedź z testu — sesja konta E2E na serwerze zostaje dla kolejnych testów.
  await page.route('**/auth/v1/logout*', async (route) => {
    scope = new URL(route.request().url()).searchParams.get('scope');
    await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
  });
  // Wylogowanie pyta o potwierdzenie (chybiony klik obok ⚙️).
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
  await expect.poll(() => scope).toBe('local');
});
