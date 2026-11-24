/** Kosz (M3): szczegóły usuniętego zadania (i podzadania usuniętego z nim) tylko do odczytu, przywrócenie z panelu. */
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('szczegóły zadania z kosza: podgląd, podzadanie, przywrócenie; nowe urządzenie bez danych', async ({ page, server, browser }) => {
  await openApp(page, '#/inbox');
  const title = unique('Do kosza');
  const step = unique('Krok w koszu');

  // Zadanie z tagami, opisem, komentarzem i podzadaniem.
  await page.keyboard.press('q');
  const input = page.getByRole('dialog', { name: 'Szybkie dodawanie' }).getByRole('textbox');
  await input.fill(`${title} jutro !wysoki @kosz-jeden @kosz-dwa`);
  await input.press('Enter');
  const created = await server.waitForTask(title);
  await taskRow(page, title).getByText(title).click();
  const panel = page.getByRole('complementary', { name: 'Zadanie', exact: true });
  await panel.getByRole('button', { name: 'Markdown', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Opis zadania (Markdown)' }).fill('Opis **ważny**');
  await panel.getByRole('textbox', { name: 'Nowy komentarz' }).fill('Komentarz przed usunięciem');
  await panel.getByRole('button', { name: 'Dodaj komentarz' }).click();
  const subtask = panel.getByPlaceholder('Dodaj podzadanie');
  await subtask.fill(step);
  await subtask.press('Enter');
  const child = await server.waitForTask(step);
  // Sekcja zwinięta w profilu da się rozwinąć także w podglądzie.
  await panel.locator('[data-section="Osoby"] button[aria-expanded]').click();
  await expect(panel.locator('[data-section="Osoby"]').getByLabel('Odpowiedzialny')).toBeHidden();
  await panel.getByRole('button', { name: 'Przenieś do kosza' }).click();
  await expect.poll(() => server.task(title)).toBeNull();
  await expect.poll(() => server.task(step)).toBeNull();

  // Kosz → szczegóły: wszystko widać, nic nie da się zmienić.
  await page.getByRole('link', { name: 'Kosz', exact: true }).click();
  const row = page.locator('main [data-card]').filter({ hasText: title });
  await expect(row).toContainText('z 1 podzadaniem');
  await expect(page.locator('main [data-card]').filter({ hasText: step })).toHaveCount(0);
  await row.getByText(title).click();
  await expect(panel.getByTestId('task-trashed')).toContainText('tylko podgląd');
  await expect(panel.getByRole('textbox', { name: 'Tytuł' })).toHaveValue(title);
  await expect(panel.getByTestId('description-preview')).toContainText('Opis ważny');
  await expect(panel.getByText('Komentarz przed usunięciem')).toBeVisible();
  await expect(panel.getByTestId('task-tag-chip')).toHaveText([/kosz-jeden/, /kosz-dwa/]);
  await expect(panel.getByTestId('task-tag-chip').first()).toHaveAttribute('draggable', 'false');
  await panel.locator('[data-section="Osoby"] button[aria-expanded]').click();
  await expect(panel.locator('[data-section="Osoby"]').getByLabel('Odpowiedzialny')).toBeDisabled();
  await expect(panel.locator('input:enabled:not([type=file]), textarea:enabled, select:enabled')).toHaveCount(0);
  await expect(panel.getByRole('checkbox', { name: 'Ukończ zadanie' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Przenieś do kosza' })).toHaveCount(0);

  // Podzadanie usunięte razem z rodzicem: własny podgląd i powrót do rodzica.
  await expect(panel.getByRole('checkbox', { name: `Ukończ „${step}”` })).toBeDisabled();
  await panel.getByRole('button', { name: step, exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Tytuł' })).toHaveValue(step);
  await expect(panel.getByTestId('task-trashed')).toContainText(`usunięte razem z „${title}”`);
  await expect(panel.getByTestId('task-parent')).toHaveText(title);
  await expect(panel.getByRole('button', { name: 'Przywróć tylko to' })).toBeEnabled();
  await panel.getByRole('button', { name: `↑ ${title}` }).click();
  await expect(panel.getByRole('textbox', { name: 'Tytuł' })).toHaveValue(title);

  // Nowe urządzenie: pełne pobranie pomija usunięte — komunikat zamiast pustego panelu.
  const other = await browser.newContext({ storageState: '.auth/e2e.json' });
  const fresh = await other.newPage();
  await openApp(fresh, `?task=${created.id}#/trash`);
  await expect(fresh.getByRole('complementary', { name: 'Zadanie', exact: true })).toContainText('Tego zadania już nie ma');
  await other.close();

  // Przywrócenie z panelu: zadanie wraca z podzadaniem i od razu jest do edycji.
  await panel.getByRole('button', { name: 'Przywróć', exact: true }).click();
  await expect(panel.getByTestId('task-trashed')).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: 'Tytuł' })).toBeEnabled();
  await server.waitForTask(title);
  await server.waitForTask(step);

  // Samo podzadanie z kosza: wraca jako zadanie główne, rodzic zostaje w koszu.
  await panel.getByRole('button', { name: 'Przenieś do kosza' }).click();
  await expect.poll(() => server.task(step)).toBeNull();
  await row.getByText(title).click();
  await panel.getByRole('button', { name: step, exact: true }).click();
  await panel.getByRole('button', { name: 'Przywróć tylko to' }).click();
  await server.waitForTask(step);
  const { data } = await server.client.from('tasks').select('parent_id').eq('id', child.id).single();
  expect(data?.parent_id).toBeNull();
  expect(await server.task(title)).toBeNull();
});

test('definitywne usunięcie: potwierdzenie, z listy i z panelu, znika z serwera i innych urządzeń', async ({ page, server, browser }) => {
  await openApp(page, '#/inbox');
  const add = async (title: string) => {
    await page.keyboard.press('q');
    const input = page.getByRole('dialog', { name: 'Szybkie dodawanie' }).getByRole('textbox');
    await input.fill(title);
    await input.press('Enter');
    return server.waitForTask(title);
  };
  const [first, second] = [unique('Na zawsze z listy'), unique('Na zawsze z panelu')];
  const step = unique('Krok na zawsze');
  const ids = [(await add(first)).id];
  await add(second);
  const panel = page.getByRole('complementary', { name: 'Zadanie', exact: true });

  await taskRow(page, first).getByText(first).click();
  await panel.getByPlaceholder('Dodaj podzadanie').fill(step);
  await panel.getByPlaceholder('Dodaj podzadanie').press('Enter');
  ids.push((await server.waitForTask(step)).id);

  // Drugie urządzenie ma już te zadania, gdy trafiają do kosza.
  const other = await browser.newContext({ storageState: '.auth/e2e.json' });
  const second2 = await other.newPage();
  await openApp(second2, '#/inbox');
  await expect(taskRow(second2, first)).toBeVisible();

  await panel.getByRole('button', { name: 'Przenieś do kosza' }).click();
  await taskRow(page, second).getByText(second).click();
  await panel.getByRole('button', { name: 'Przenieś do kosza' }).click();
  await expect.poll(() => server.task(second)).toBeNull();
  await page.getByRole('link', { name: 'Kosz', exact: true }).click();
  const row = (p: typeof page, title: string) => p.locator('main [data-card]').filter({ hasText: title });
  await second2.getByRole('link', { name: 'Kosz', exact: true }).click();
  await expect(row(second2, first)).toBeVisible();

  // Anulowanie niczego nie zmienia.
  let question = '';
  page.once('dialog', (d) => {
    question = d.message();
    void d.dismiss();
  });
  await row(page, first).getByRole('button', { name: 'Usuń na stałe' }).click();
  expect(question).toContain(`Usunąć na stałe „${first}”?`);
  expect(question).toContain('z 1 podzadaniem');
  expect(question).toContain('Tego nie da się cofnąć');
  await expect(row(page, first)).toBeVisible();

  // Bez sieci: komunikat, zadanie zostaje.
  await page.context().setOffline(true);
  page.once('dialog', (d) => void d.accept());
  await row(page, first).getByRole('button', { name: 'Usuń na stałe' }).click();
  await expect(page.getByText('Definitywne usunięcie wymaga sieci')).toBeVisible();
  await expect(row(page, first)).toBeVisible();
  await page.context().setOffline(false);

  // Z listy: zadanie z podzadaniem znika z bazy i z drugiego urządzenia.
  page.once('dialog', (d) => void d.accept());
  await row(page, first).getByRole('button', { name: 'Usuń na stałe' }).click();
  await expect(page.getByText(`Usunięto na stałe „${first}”`)).toBeVisible();
  await expect(row(page, first)).toHaveCount(0);
  await expect(row(second2, first)).toHaveCount(0);
  expect((await server.client.from('tasks').select('id').in('id', ids)).data).toEqual([]);
  await other.close();

  // Z panelu: podgląd się zamyka.
  await row(page, second).getByText(second).click();
  await expect(panel.getByTestId('task-trashed')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await panel.getByRole('button', { name: 'Usuń na stałe' }).click();
  await expect(panel).toHaveCount(0);
  await expect(row(page, second)).toHaveCount(0);
});
