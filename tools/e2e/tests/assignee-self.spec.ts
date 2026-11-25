/** „Ja” w polu „Odpowiedzialny”: pierwszy wybór tworzy wpis z e-mailem konta, znaczek przy zadaniu. */
import { E2E_EMAIL } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('jawne wskazanie siebie jako odpowiedzialnego', async ({ page, server }) => {
  const db = server.client;
  const mine = async () => (await db.from('collaborators').select('id, name').eq('scope_id', server.userId).eq('email', E2E_EMAIL).is('deleted_at', null)).data ?? [];
  const assigneeOf = async (id: string) => (await db.from('tasks').select('assignee_id').eq('id', id).single()).data?.assignee_id as string | null;
  await openApp(page);
  const titles = [unique('Ja pierwsze'), unique('Ja drugie')];
  const ids: string[] = [];
  try {
    for (const title of titles) {
      await page.getByRole('textbox', { name: 'Dodaj zadanie na dziś' }).fill(title);
      await page.keyboard.press('Enter');
      ids.push((await server.waitForTask(title)).id);
    }
    const panel = page.getByRole('complementary', { name: 'Zadanie', exact: true });
    for (const [i, title] of titles.entries()) {
      await taskRow(page, title).getByText(title).click();
      const section = panel.locator('[data-section="Osoby"]');
      const toggle = section.locator('button[aria-expanded="false"]');
      if (await toggle.count()) await toggle.first().click();
      const select = section.getByLabel('Odpowiedzialny');
      await select.selectOption({ label: 'Ja — E2E' });
      await expect.poll(() => assigneeOf(ids[i]!)).not.toBeNull();
      await expect(select.locator('option:checked')).toHaveText('Ja — E2E');
      await expect(taskRow(page, title).getByTestId('task-people')).toContainText('Odpowiedzialny: E2E');
      await expect(select.locator('option', { hasText: 'E2E' })).toHaveCount(1);
    }
    // Drugie zadanie — ten sam wpis.
    const people = await mine();
    expect(people).toHaveLength(1);
    expect(await Promise.all(ids.map(assigneeOf))).toEqual([people[0]!.id, people[0]!.id]);
  } finally {
    const at = new Date().toISOString();
    if (ids.length) await db.from('tasks').update({ assignee_id: null, deleted_at: at }).in('id', ids);
    for (const p of await mine()) await db.from('collaborators').update({ deleted_at: at }).eq('id', p.id);
  }
});
