/**
 * Zrzuty ekranu do `docs/instrukcja/INSTRUKCJA.md`. Każdy test = rozdział; dane w `demo-data.ts`.
 * Odpowiedź asystenta AI i przełącznik Google na ekranie logowania są podstawione (bez sieci i kluczy).
 */
import { existsSync, readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import { expect, openApp, test as base } from '../src/fixtures.ts';
import { adminClient } from '../src/supabase.ts';
import { demoIds } from './demo-data.ts';
import { AUTH, type DocsInfo } from './setup.ts';
import { shot } from './shot.ts';

const info = (existsSync(AUTH.info) ? JSON.parse(readFileSync(AUTH.info, 'utf8')) : { anna: '', timeZone: 'UTC', today: '', club: '' }) as DocsInfo;
const test = base.extend<{ ids: ReturnType<typeof demoIds> }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright wymaga destrukturyzacji fixture'ów
  ids: async ({}, use) => use(demoIds(info.anna)),
});
test.use({ actionTimeout: 8000 });
// Opis zadania w podglądzie (tryb zapamiętuje przeglądarka).
test.beforeEach(({ page }) => page.addInitScript(() => localStorage.setItem('tp-description-mode', 'preview')));

const go = async (page: Page, hash: string) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForTimeout(600);
};
const row = (page: Page, title: string) => page.locator('main [data-task-id]').filter({ hasText: title }).first();
const panel = (page: Page) => page.locator('aside[aria-label="Zadanie"]');
const section = (page: Page, title: string) => panel(page).locator('section').filter({ has: page.locator(`:text-is("${title}")`) }).first();
const openTask = async (page: Page, title: string) => {
  await row(page, title).getByText(title, { exact: true }).first().click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(500);
};
const closeToast = async (page: Page) => {
  const close = page.locator('[role=status] button[aria-label="Zamknij"]');
  if (await close.count()) await close.first().click();
};
const nav = (page: Page) => page.locator('#sidebar');
/** Panel boczny zwinięty do ikon — więcej miejsca na szerokie widoki. */
const wide = async (page: Page) => {
  const collapse = nav(page).getByRole('button', { name: 'Zwiń panel boczny' });
  if (await collapse.isVisible()) await collapse.click();
  await page.waitForTimeout(400);
};
const main = (page: Page) => page.locator('main').first();
/** Strefa demonstracyjna (`Etc/GMT…`) jest tylko techniczna — na zrzutach zwykła. */
const showWarsaw = (page: Page) =>
  page.evaluate(() => {
    for (const s of document.querySelectorAll('select')) if (/Etc\/GMT/.test(s.value) && s.selectedOptions[0]) s.selectedOptions[0].textContent = 'Europe/Warsaw';
    for (const s of document.querySelectorAll('input')) if (/Etc\/GMT/.test(s.value)) s.value = 'Europe/Warsaw';
  });

test.describe('logowanie i start', () => {
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 760, height: 620 } });
  test('logowanie', async ({ page }) => {
    await page.route('**/auth/v1/settings', (r) => r.fulfill({ json: { external: { google: true, email: true }, disable_signup: false } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Zaloguj przez Google' })).toBeEnabled();
    await shot(page, '01-logowanie', { of: page.locator('main'), pad: 0 });
  });
});

test.describe('pierwsze uruchomienie', () => {
  test.use({ storageState: AUTH.fresh });
  test('onboarding', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Witaj w Task Plannerze' })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await showWarsaw(page);
    await shot(page, '02-onboarding');
  });
});

test('okno aplikacji i widoki dnia', async ({ page }) => {
  await openApp(page);
  await expect(row(page, 'Zapłacić rachunek za prąd')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '03-okno', {
    marks: [
      { at: page.getByTestId('sync-status'), pos: 'r' },
      { at: page.locator('header').getByRole('link', { name: 'Ustawienia' }).or(page.locator('header').getByLabel('Ustawienia')), pos: 'b' },
      { at: nav(page).getByLabel('Przestrzeń'), pos: 'edge' },
      { at: nav(page).getByRole('button', { name: /Dodaj zadanie/ }).last(), pos: 'edge' },
      { at: nav(page).locator('nav').first(), pos: 'edge' },
      { at: nav(page).getByText('Nowa strona www').first(), pos: 'edge' },
      { at: page.locator('main h1').first(), pos: 'l' },
      { at: page.getByTestId('day-plan').getByText('Plan dnia').first(), pos: 'l' },
    ],
  });
  await shot(page, '04-dzis', { of: main(page), pad: 0 });
  await go(page, '#/inbox');
  await shot(page, '05-inbox', { of: main(page), pad: 0, maxHeight: 420 });
  await go(page, '#/upcoming');
  await shot(page, '06-nadchodzace', { of: main(page), pad: 0 });

  await go(page, '#/today');
  await page.keyboard.press('q');
  const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
  await dialog.getByRole('textbox').first().fill('Zapłacić za gaz jutro o 10 #dom !wysoki @telefon ~15m ^30m');
  await shot(page, '07-szybkie-dodawanie', { of: dialog, pad: 20 });
  await dialog.getByRole('textbox').first().press('Escape');
  if (await dialog.count()) await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Ułożenie dnia bez AI.
  const plan = page.getByTestId('day-plan');
  await plan.getByRole('button', { name: 'Ułóż dzień' }).click();
  await page.setViewportSize({ width: 1360, height: 1080 });
  await page.waitForTimeout(500);
  await shot(page, '08-uloz-dzien', { of: plan, pad: 8 });
  await plan.getByRole('button', { name: 'Zamknij układanie dnia' }).click();
  await page.setViewportSize({ width: 1360, height: 860 });

  // Zaznaczanie wielu zadań, paleta, skróty.
  await go(page, '#/inbox');
  await page.keyboard.press('j');
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('>przen');
  await shot(page, '09-paleta-zaznaczone');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('targi');
  await shot(page, '10-paleta', { of: page.getByRole('dialog', { name: 'Paleta poleceń' }), pad: 0, maxHeight: 620 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.setViewportSize({ width: 1360, height: 1080 });
  await page.keyboard.press('?');
  await shot(page, '11-skroty', { of: page.getByRole('dialog', { name: 'Skróty klawiszowe' }), pad: 16 });
});

test('listy, filtry, tagi', async ({ page, ids }) => {
  await openApp(page, `#/list/${ids.www}`);
  await expect(row(page, 'Projekt graficzny')).toBeVisible();
  const columns = page.getByTestId('list-columns');
  await columns.locator('summary').click();
  for (const label of ['Odpowiedzialny', 'Koniec', 'Tagi']) await columns.getByLabel(label, { exact: true }).first().click();
  await page.waitForTimeout(600);
  await shot(page, '12-kolumny', { of: main(page), pad: 0, maxHeight: 520 });
  await columns.locator('summary').click();
  await page.mouse.move(0, 0);
  await shot(page, '13-lista', {
    of: main(page),
    pad: 0,
    maxHeight: 620,
    marks: [
      { at: page.getByTestId('save-template'), pos: 'tl' },
      { at: page.getByRole('radiogroup', { name: 'Widok' }), pos: 'tl' },
      { at: page.getByLabel('Sortowanie'), pos: 'tl' },
      { at: columns, pos: 'tr' },
      { at: page.getByRole('group', { name: 'Filtry' }).first(), pos: 'l' },
    ],
  });
  await page.getByLabel('Grupowanie').selectOption('status');
  await shot(page, '14-grupowanie', { of: main(page), pad: 0, maxHeight: 660 });
  await page.getByLabel('Grupowanie').selectOption('none');

  await go(page, '#/today');
  await page.getByRole('group', { name: 'Filtry' }).getByText(/\+ ?Filtr/).first().click();
  await page.waitForTimeout(300);
  await shot(page, '15-filtr', { of: main(page), pad: 0, maxHeight: 560 });
  await page.keyboard.press('Escape');
  await go(page, `#/filter/${ids.filter}`);
  await shot(page, '16-zapisany-filtr', { of: main(page), pad: 0, maxHeight: 480 });
  await go(page, `#/tag/${ids.tag('pilne')}`);
  await shot(page, '17-tag', { of: main(page), pad: 0, maxHeight: 360 });
  await go(page, `#/list/${ids.books}`);
  await openTask(page, 'Stara lista życzeń');
  await panel(page).getByRole('button', { name: 'Przenieś do kosza' }).click();
  await page.waitForTimeout(400);
  await closeToast(page);
  await go(page, '#/trash');
  await shot(page, '18-kosz', { of: main(page), pad: 0, maxHeight: 220 });
});

test('panel zadania', async ({ page, ids }) => {
  await openApp(page, `#/list/${ids.www}`);
  await openTask(page, 'Projekt graficzny');
  await page.waitForTimeout(600);
  await shot(page, '19-panel');
  await panel(page).getByRole('button', { name: /Pełny widok/ }).click();
  await page.waitForTimeout(900);
  await shot(page, '20-panel-pelny');
  const describe = section(page, 'Opis');
  await describe.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.waitForTimeout(300);
  await shot(page, '21-opis', { of: describe, pad: 8 });
  await describe.getByRole('button', { name: 'Podgląd', exact: true }).click();
  await panel(page).getByRole('button', { name: /Zwykły panel/ }).click();
  for (const [name, title] of [
    ['22-osoby', 'Osoby'],
    ['23-komentarze', 'Komentarze'],
    ['24-podzadania', 'Podzadania'],
    ['25-zaleznosci', 'Zależności'],
    ['26-zalaczniki', 'Załączniki'],
    ['27-przypomnienia', 'Przypomnienia'],
    ['28-historia', 'Historia zmian'],
  ] as const) {
    const s = section(page, title);
    if (title === 'Historia zmian') {
      await s.getByRole('button').first().click();
      await page.waitForTimeout(1500);
    }
    await s.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, name, { of: s, pad: 8, maxHeight: 520 });
  }
  // Rozbij na kroki (odpowiedź podstawiona).
  await page.route('**/functions/v1/ai/breakdown', (r) =>
    r.fulfill({
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
      json: {
        model: 'gemini-flash-lite-latest',
        steps: [
          { title: 'Przygotować szablon strony głównej', durationMin: 120, offsetDays: 0, priority: null, afterPrevious: false },
          { title: 'Przygotować szablon oferty', durationMin: 90, offsetDays: 2, priority: null, afterPrevious: true },
          { title: 'Podłączyć formularz kontaktowy', durationMin: 60, offsetDays: 4, priority: 2, afterPrevious: true },
          { title: 'Przenieść teksty i zdjęcia', durationMin: 120, offsetDays: 5, priority: null, afterPrevious: true },
        ],
      },
    }),
  );
  await panel(page).getByRole('button', { name: /Zamknij panel/ }).click();
  await openTask(page, 'Wdrożenie szablonów');
  const sub = section(page, 'Podzadania');
  await sub.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await sub.getByRole('button', { name: /Rozbij na kroki/ }).click();
  await sub.getByRole('button', { name: 'Zaproponuj kroki' }).click();
  await page.waitForTimeout(1000);
  await sub.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, '29-rozbij-na-kroki', { of: sub, pad: 8 });
  await panel(page).getByRole('button', { name: /Zamknij panel/ }).click();

  // Powtarzanie.
  await go(page, '#/today');
  await openTask(page, 'Stand-up zespołu');
  const rec = section(page, 'Powtarzanie');
  await rec.getByRole('button', { name: 'Zmień', exact: true }).click();
  const more = rec.getByRole('button', { name: 'Więcej opcji…' });
  if (await more.count()) await more.click();
  await rec.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '30-powtarzanie', { of: rec, pad: 8 });
});

test('tablica', async ({ page, ids }) => {
  await openApp(page, '#/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await nav(page).getByLabel('Przestrzeń').selectOption({ label: 'Praca' });
  await page.waitForTimeout(400);
  await wide(page);
  await shot(page, '31-tablica');
  await go(page, `#/list/${ids.clients}`);
  await shot(page, '32-wlasne-kolumny');
});

test('kalendarz', async ({ page }) => {
  await openApp(page, '#/calendar');
  await wide(page);
  await page.waitForTimeout(1500);
  await shot(page, '33-kalendarz-tydzien');
  await page.locator('main').getByRole('button', { name: /^(Miesiąc|miesiąc)$/ }).click();
  await page.waitForTimeout(800);
  await shot(page, '34-kalendarz-miesiac');
});

test('oś czasu', async ({ page }) => {
  await openApp(page, '#/timeline');
  await wide(page);
  await page.waitForTimeout(3000);
  await shot(page, '35-os-czasu');
  await page.getByLabel('Ścieżka krytyczna').first().check();
  await page.waitForTimeout(1500);
  await shot(page, '36-sciezka-krytyczna');
});

test('karteczki', async ({ page, ids }) => {
  await openApp(page, `#/list/${ids.canvas}`);
  await expect(page.getByTestId('canvas-board')).toBeVisible();
  await wide(page);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Dopasuj' }).click();
  await page.waitForTimeout(300);
  await shot(page, '37-karteczki');
  await page.getByTestId('canvas-arrange').click();
  await page.getByTestId('canvas-arrange-color').hover();
  await page.waitForTimeout(500);
  await shot(page, '38-karteczki-uloz');
  await page.getByTestId('canvas-arrange').click();
  await page.getByTestId('canvas-export').click();
  await page.waitForTimeout(300);
  await shot(page, '39-karteczki-eksport', { of: page.getByTestId('canvas-export-dialog'), pad: 0 });
  await page.getByTestId('canvas-export').click();
  await page.getByTestId('canvas-help-button').click();
  await page.waitForTimeout(300);
  await shot(page, '40-karteczki-pomoc', { of: page.locator('#canvas-help'), pad: 0 });
});

test('cykliczne', async ({ page, ids }) => {
  await openApp(page, '#/habits');
  await page.waitForTimeout(800);
  await shot(page, '41-cykliczne', { of: main(page), pad: 0, maxHeight: 480 });
  await go(page, `#/habit/${ids.reading}`);
  await page.waitForTimeout(800);
  await shot(page, '42-cykliczne-szczegoly');
  await go(page, '#/habits');
  await page.locator('main').getByRole('button', { name: /^\+|Nowe|Dodaj/ }).first().click();
  await page.waitForTimeout(400);
  await page.getByPlaceholder('np. Woda').fill('Spacer 30 min');
  await shot(page, '43-cykliczne-formularz', { of: main(page), pad: 0, maxHeight: 520 });
});

test('skupienie', async ({ page, ids }) => {
  await openApp(page, '#/today');
  await go(page, `#/focus/${ids.design}`);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Pomodoro/ }).first().click();
  await page.waitForTimeout(2200);
  await shot(page, '44-skupienie');
  await page.getByRole('button', { name: /■ Stop/ }).first().click();
  await page.waitForTimeout(1500);
});

test('przeglądy', async ({ page }) => {
  await openApp(page, '#/review/daily');
  await page.waitForTimeout(800);
  await shot(page, '45-przeglad-dnia', { of: main(page), pad: 0, maxHeight: 520 });
  // Dwie decyzje (jutro, dziś), reszta pominięta — podsumowanie ma co pokazać.
  for (const key of ['3', '2']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
  }
  for (let i = 0; i < 20 && !(await page.getByTestId('review-summary').count()); i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(600);
  await closeToast(page);
  await shot(page, '46-przeglad-dnia-koniec', { of: main(page), pad: 0 });
  await go(page, '#/review/weekly');
  await page.waitForTimeout(800);
  await shot(page, '47-przeglad-tygodnia', { of: main(page), pad: 0, maxHeight: 560 });
  await page.getByRole('button', { name: /Podsumowanie/ }).first().click();
  await page.waitForTimeout(600);
  await closeToast(page);
  await shot(page, '48-podsumowanie-tygodnia', { of: main(page), pad: 0 });
});

test('przestrzenie, osoby, szablony', async ({ page, ids }) => {
  await openApp(page, '#/manage');
  await page.waitForTimeout(600);
  await shot(page, '49-przestrzenie', { of: main(page), pad: 0 });
  await main(page).getByRole('button', { name: 'Udostępnij', exact: true }).last().click();
  await page.waitForTimeout(1500);
  const sharing = page.getByTestId('sharing-panel');
  await sharing.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '50-udostepnianie', { of: sharing, pad: 12 });
  await go(page, '#/people');
  await page.waitForTimeout(1500);
  await shot(page, '51-wspolpracownicy', { of: main(page), pad: 0, maxHeight: 520 });

  await go(page, `#/list/${ids.www}`);
  await page.getByTestId('save-template').click();
  await page.waitForTimeout(300);
  await shot(page, '52-zapisz-szablon', { of: main(page), pad: 0, maxHeight: 200 });
  await page.getByTestId('save-template-form').getByRole('button', { name: 'Zapisz' }).click();
  await page.waitForTimeout(800);
  await closeToast(page);
  await go(page, '#/manage');
  await page.waitForTimeout(400);
  const form = main(page).locator('form').filter({ has: page.getByLabel('Nazwa nowej listy') }).first();
  await form.getByLabel('Rodzaj').selectOption({ label: 'Projekt' });
  await form.getByLabel('Nazwa nowej listy').fill('Strona dla Piekarni Kłos');
  await main(page).getByLabel('Szablon projektu').first().selectOption({ index: 1 });
  await page.waitForTimeout(400);
  await form.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '53-nowy-z-szablonu', { of: form, pad: 16 });

  // Zaproszenie do cudzej przestrzeni (pasek u góry).
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const piotr = users.users.find((u) => u.email === 'piotr.zielinski@example.com')!;
  const { error } = await admin.from('scope_invites').insert({ scope_id: info.club, email: 'anna.nowicka@example.com', role: 'editor', invited_by: piotr.id });
  if (error) throw new Error(error.message);
  await page.reload();
  await expect(page.getByTestId('scope-invites')).toBeVisible({ timeout: 20_000 });
  await shot(page, '54-zaproszenie', { of: page.getByTestId('scope-invites'), pad: 0 });
  await admin.from('scope_invites').delete().eq('scope_id', info.club);
});

test('ustawienia', async ({ page }) => {
  await openApp(page, '#/settings');
  await page.waitForTimeout(1500);
  await showWarsaw(page);
  await shot(page, '55-ustawienia', { of: main(page), pad: 0 });
  const headings = await main(page).locator('h2').allTextContents();
  console.log('karty ustawień:', headings.join(' | '));
  const cards: [string, RegExp][] = [
    ['56-powiadomienia', /^(Przypomnienia|Powiadomienia|Urządzenia)/],
    ['57-kalendarze', /^Połączone kalendarze/],
    ['58-integracje', /^Integracje/],
    ['59-asystent', /^Asystent AI/],
    ['60-kopia', /^Kopia zapasowa/],
    ['61-przechwytywanie', /dodawanie|Dodawanie|przechwyt/i],
    ['62-instalacja', /instal|Aplikacja na/i],
    ['63-offline', /^Praca bez sieci/],
    ['64-konto', /^Usuń konto/],
  ];
  const history = main(page).getByRole('button', { name: 'Historia wysyłek' });
  if (await history.count()) await history.click();
  await page.waitForTimeout(1200);
  for (const [name, title] of cards) {
    const heading = main(page).locator('h2').filter({ hasText: title }).first();
    if (!(await heading.count())) {
      console.log(`brak karty: ${name}`);
      continue;
    }
    const card = heading.locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await shot(page, name, { of: card, pad: 6 });
  }
  // Edytor reguły zdarzeniowej.
  await main(page).getByRole('button', { name: 'Edytuj' }).last().click();
  const editor = main(page).getByLabel('Reguła', { exact: true });
  await editor.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, '69-regula', { of: editor, pad: 6 });
});

test('offline i motyw', async ({ page, context }) => {
  await openApp(page);
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await row(page, 'Odebrać paczkę').locator('[aria-label^="Ukończ"]').first().click();
  await page.waitForTimeout(2000);
  await shot(page, '65-offline', { of: page.getByTestId('sync-status'), pad: 6 });
  await page.getByRole('button', { name: 'Cofnij' }).first().click();
  await context.setOffline(false);
  await page.waitForTimeout(2000);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.waitForTimeout(500);
  await shot(page, '66-motyw-ciemny');
});

test.describe('wąski ekran', () => {
  test.use({ viewport: { width: 400, height: 800 } });
  test('menu na telefonie', async ({ page }) => {
    await page.goto('/#/today');
    await expect(page.getByTestId('sync-status')).toHaveText('Zsynchronizowano', { timeout: 30_000 });
    await page.waitForTimeout(1000);
    await shot(page, '67-waski-ekran');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.waitForTimeout(400);
    await shot(page, '68-waskie-menu');
  });
});
