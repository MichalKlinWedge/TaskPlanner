/** Ustawienia: podpanel z menu sekcji, jedna aktywna, ostatnia pamiętana, przełączenie nie gubi wpisanych pól. */
import { expect, openApp, test } from '../src/fixtures.ts';

// „Zaproszenia” widzi tylko administrator.
const SECTIONS = {
  Ogólne: 'Ogólne',
  Przypomnienia: 'Przypomnienia',
  'Połączone kalendarze': 'Połączone kalendarze',
  Integracje: 'Integracje',
  'Asystent AI': 'Asystent AI',
  'Kopia zapasowa': 'Kopia zapasowa',
  'Dodawanie z innych miejsc': 'Dodawanie z innych miejsc',
  'Aplikacja na pulpicie': 'Aplikacja na pulpicie',
  'Błędy aplikacji': 'Błędy aplikacji',
  'Praca bez sieci': 'Praca bez sieci w tej przeglądarce',
  'Wersja aplikacji': 'Wersja aplikacji',
  'Usuń konto': 'Usuń konto',
};

test('menu sekcji ustawień', async ({ page }) => {
  await openApp(page, '#/today');
  const openSettings = () => page.getByRole('link', { name: 'Ustawienia', exact: true }).click();
  const menu = page.getByRole('navigation', { name: 'Sekcje ustawień' });
  const item = (label: string) => menu.getByRole('link', { name: label, exact: true });
  const panel = page.getByRole('main').getByRole('heading', { level: 2 });
  const current = menu.locator('[aria-current=page]');

  // Pierwsze wejście: „Ogólne”; nieotwarte sekcje nie są zamontowane.
  await openSettings();
  await expect(menu.getByRole('link')).toHaveText(Object.keys(SECTIONS).map((label) => new RegExp(label)));
  await expect(current).toHaveText(/Ogólne/);
  await expect(page.locator('[data-settings-section]')).toHaveCount(1);

  // Niezapisane pole przetrwa przełączanie sekcji; zawsze jedna aktywna.
  const name = page.getByLabel('Jak się do Ciebie zwracać');
  await name.fill('Niezapisane');
  for (const [label, title] of Object.entries(SECTIONS)) {
    await item(label).click();
    await expect(panel).toHaveText([title]);
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(new RegExp(label));
  }
  await expect(name).toBeHidden();
  await item('Dodawanie z innych miejsc').click();
  await expect(page.getByTestId('bookmarklet')).toHaveAttribute('href', /^javascript:/);
  await item('Ogólne').click();
  await expect(name).toHaveValue('Niezapisane');

  // Ostatnia sekcja: po wyjściu, po przeładowaniu strony i pod adresem bez sekcji.
  await item('Praca bez sieci').click();
  await expect(page).toHaveURL(/#\/settings\/offline$/);
  await page.getByRole('link', { name: 'Inbox' }).first().click();
  await openSettings();
  await expect(panel).toHaveText(['Praca bez sieci w tej przeglądarce']);
  await page.getByRole('link', { name: 'Inbox' }).first().click();
  await page.reload();
  await openSettings();
  await expect(page.getByTestId('offline-exceptions')).toBeVisible();

  // „Wstecz” wraca do poprzedniej sekcji, nieznana sekcja w adresie = „Ogólne”.
  await item('Kopia zapasowa').click();
  await expect(panel).toHaveText(['Kopia zapasowa']);
  await item('Integracje').click();
  await expect(panel).toHaveText(['Integracje']);
  await page.goBack();
  await expect(panel).toHaveText(['Kopia zapasowa']);
  await page.evaluate(() => (window.location.hash = '#/settings/invites'));
  await expect(panel).toHaveText(['Ogólne']);

  // Powrót ze zgody Google otwiera kalendarze.
  await page.goto('/?calendars=1#/today');
  await expect(panel).toHaveText(['Połączone kalendarze']);
});

test('menu ustawień na wąskim ekranie jest paskiem nad sekcją', async ({ page }) => {
  await openApp(page, '#/settings/account');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  const menu = page.getByRole('navigation', { name: 'Sekcje ustawień' });
  await expect(menu.locator('[aria-current=page]')).toBeInViewport();
  const title = page.getByRole('heading', { level: 2, name: 'Usuń konto' });
  await expect(title).toBeVisible();
  expect((await menu.boundingBox())!.y).toBeLessThan((await title.boundingBox())!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
