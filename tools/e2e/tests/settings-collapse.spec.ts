/** Ustawienia: „Błędy aplikacji” i „Praca bez sieci” zwinięte, rozwinięcie pamiętane w przeglądarce. */
import { expect, openApp, test } from '../src/fixtures.ts';

test('Zwijane sekcje „Błędy aplikacji” i „Praca bez sieci”', async ({ page }) => {
  await openApp(page, '#/today');
  await page.getByLabel('Ustawienia', { exact: true }).click();
  const errors = page.getByRole('button', { name: 'Błędy aplikacji' });
  const offline = page.getByRole('button', { name: 'Praca bez sieci w tej przeglądarce' });
  await expect(errors).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Zapisz błąd testowy' })).toHaveCount(0);
  await expect(page.getByTestId('offline-exceptions')).toHaveCount(0);

  await errors.click();
  await offline.click();
  await expect(page.getByRole('button', { name: 'Zapisz błąd testowy' })).toBeVisible();
  await expect(page.getByTestId('offline-exceptions')).toBeVisible();

  await offline.click();
  await expect(page.getByTestId('offline-exceptions')).toHaveCount(0);
  await page.reload();
  await page.getByLabel('Ustawienia', { exact: true }).click();
  await expect(errors).toHaveAttribute('aria-expanded', 'true');
  await expect(offline).toHaveAttribute('aria-expanded', 'false');
});
