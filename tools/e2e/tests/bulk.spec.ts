/** Pasek zaznaczenia: grupowe dodanie / zdjęcie tagu i zmiana odpowiedzialnego przez paletę. */
import { E2E_EMAIL } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('„#” i „👤” na pasku zaznaczenia zmieniają tag i odpowiedzialnego wszystkich zaznaczonych', async ({ page, server }) => {
  const db = server.client;
  const tagName = unique('grupa').replace(' ', '-');
  const titles = [unique('Grupowo A'), unique('Grupowo B')];
  const ids: string[] = [];
  const links = async () => {
    const tags = (await db.from('tags').select('id').eq('scope_id', server.userId).eq('name', tagName).is('deleted_at', null)).data ?? [];
    return tags.length ? ((await db.from('task_tags').select('task_id, deleted_at').in('task_id', ids).in('tag_id', tags.map((t) => t.id))).data ?? []) : [];
  };
  const assignees = async () => ((await db.from('tasks').select('assignee_id').in('id', ids)).data ?? []).map((r) => r.assignee_id as string | null);
  const mine = async () => (await db.from('collaborators').select('id').eq('scope_id', server.userId).eq('email', E2E_EMAIL).is('deleted_at', null)).data ?? [];
  const hadSelf = (await mine()).length > 0;
  await openApp(page);
  try {
    for (const title of titles) {
      await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(title);
      await page.keyboard.press('Enter');
      ids.push((await server.waitForTask(title)).id);
    }
    for (const title of titles) await taskRow(page, title).getByText(title).click({ modifiers: ['Control'] });
    const bar = page.getByTestId('bulk-bar');
    await expect(bar.getByRole('button', { name: 'Anuluj zaznaczenie (2)' })).toBeVisible();
    const palette = page.getByRole('dialog', { name: 'Paleta poleceń' });

    // Nowy tag wpisany w palecie trafia do obu zadań.
    await bar.getByTitle('Dodaj albo zdejmij tag…').click();
    await palette.getByRole('textbox').fill(tagName);
    await expect(palette.getByRole('option').first()).toContainText('nowy tag');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await links()).filter((l) => !l.deleted_at).length).toBe(2);

    // Mają go wszystkie → ta sama pozycja go zdejmuje.
    await bar.getByTitle('Dodaj albo zdejmij tag…').click();
    await palette.getByRole('textbox').fill(tagName);
    await expect(palette.getByRole('option').first()).toContainText('zdejmij ze wszystkich');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await links()).filter((l) => !l.deleted_at).length).toBe(0);

    // „Ja” — oba zadania z tym samym wpisem.
    await bar.getByTitle('Zmień odpowiedzialnego…').click();
    await palette.getByRole('textbox').fill('ja');
    await expect(palette.getByRole('option').first()).toContainText('Ja');
    await page.keyboard.press('Enter');
    await expect.poll(async () => new Set(await assignees()).size === 1 && !(await assignees()).includes(null)).toBe(true);
    for (const title of titles) await expect(taskRow(page, title).getByTestId('task-people')).toContainText('Odpowiedzialny');
  } finally {
    const at = new Date().toISOString();
    if (ids.length) await db.from('tasks').update({ assignee_id: null, deleted_at: at }).in('id', ids);
    await db.from('tags').update({ deleted_at: at }).eq('scope_id', server.userId).eq('name', tagName);
    if (!hadSelf) for (const p of await mine()) await db.from('collaborators').update({ deleted_at: at }).eq('id', p.id);
  }
});
