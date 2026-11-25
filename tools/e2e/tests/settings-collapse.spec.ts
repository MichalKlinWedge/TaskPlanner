/** Ustawienia: każda sekcja zwijana, stan pamiętany w przeglądarce, zwinięcie nie gubi wpisanych pól. */
import { expect, openApp, test } from '../src/fixtures.ts';

// „Zaproszenia” widzi tylko administrator.
const SECTIONS = ['Przypomnienia', 'Połączone kalendarze', 'Integracje', 'Asystent AI', 'Kopia zapasowa', 'Dodawanie z innych miejsc', 'Aplikacja na pulpicie', 'Błędy aplikacji', 'Praca bez sieci w tej przeglądarce', 'Usuń konto'];

test('sekcje ustawień zwijają się i pamiętają stan', async ({ page }) => {
  await openApp(page, '#/today');
  const openSettings = () => page.getByLabel('Ustawienia', { exact: true }).click();
  await openSettings();
  const section = (title: string) => page.getByRole('heading', { level: 2, name: title }).getByRole('button');
  const general = section('Ogólne');
  await expect(general).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveCount(SECTIONS.length + 1);
  for (const title of SECTIONS) await expect(section(title)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('bookmarklet')).toHaveCount(0);
  await expect(page.getByTestId('offline-exceptions')).toHaveCount(0);

  for (const title of SECTIONS) {
    await section(title).click();
    await expect(page.locator(`[id="${await section(title).getAttribute('aria-controls')}"]`)).toBeVisible();
  }
  await expect(page.getByTestId('bookmarklet')).toHaveAttribute('href', /^javascript:/);
  await expect(page.getByTestId('offline-exceptions')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zapisz błąd testowy' })).toBeVisible();

  // Niezapisane pole przetrwa zwinięcie sekcji.
  const name = page.getByLabel('Jak się do Ciebie zwracać');
  await name.fill('Niezapisane');
  await general.click();
  await expect(name).toBeHidden();
  await general.click();
  await expect(name).toHaveValue('Niezapisane');

  await general.click();
  await section('Praca bez sieci w tej przeglądarce').click();
  await expect(page.getByTestId('offline-exceptions')).toBeHidden();
  await page.reload();
  await openSettings();
  await expect(general).toHaveAttribute('aria-expanded', 'false');
  await expect(section('Praca bez sieci w tej przeglądarce')).toHaveAttribute('aria-expanded', 'false');
  await expect(section('Błędy aplikacji')).toHaveAttribute('aria-expanded', 'true');

  // Powrót ze zgody Google rozwija kalendarze.
  await section('Połączone kalendarze').click();
  await expect(section('Połączone kalendarze')).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/?calendars=connected#/today');
  await expect(section('Połączone kalendarze')).toHaveAttribute('aria-expanded', 'true');
});
