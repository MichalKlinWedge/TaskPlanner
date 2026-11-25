/**
 * Przypomnienia we wspólnej przestrzeni: każdy widzi i ustawia tylko własne, a osoba odpowiedzialna
 * (konto = członek z e-mailem współpracownika) dostanie automatyczne w chwili terminu — objaśnienie w panelu.
 */
import { addDays, localDateAt, uuidv7 } from '@taskplanner/core';

import { E2E_EMAIL_2, TIME_ZONE } from '../src/constants.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';
import { AUTH_FILE_2, sharedIds } from '../src/global-setup.ts';

test('przypomnienia osobne dla każdego, automatyczne dla odpowiedzialnego', async ({ page, browser, server }) => {
  const { workspace } = sharedIds(server.userId);
  const db = server.client;
  const must = async (query: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await query;
    if (error) throw new Error(error.message);
  };
  // Osobna lista zwykła (wspólna lista z ustawień to karteczki), usuwana po teście.
  const [list, task, person] = [uuidv7(), uuidv7(), uuidv7()];
  const title = unique('Odpowiedzialny');
  await must(db.from('lists').insert({ id: list, scope_id: workspace, kind: 'list', name: unique('Przypomnienia'), sort_key: 'z' }));
  await must(db.from('collaborators').insert({ id: person, scope_id: server.userId, name: 'Druga E2E', email: E2E_EMAIL_2.toUpperCase() }));
  await must(db.from('tasks').insert({ id: task, list_id: list, title, due_date: addDays(localDateAt(new Date(), TIME_ZONE), 3), due_time: '10:00', assignee_id: person, sort_key: 'a', created_by: server.userId }));

  const use = test.info().project.use;
  const other = await browser.newContext({ baseURL: use.baseURL, locale: use.locale, timezoneId: use.timezoneId, viewport: use.viewport, storageState: AUTH_FILE_2 });
  const second = await other.newPage();
  try {
    const open = async (p: typeof page) => {
      await openApp(p, `#/list/${list}`);
      await p.locator('main').getByText(title).first().click();
      const section = p.getByRole('complementary', { name: 'Zadanie', exact: true }).locator('[data-section="Przypomnienia"]');
      const toggle = section.locator('button[aria-expanded="false"]');
      if (await toggle.count()) await toggle.first().click();
      return section;
    };
    const [mine, theirs] = [await open(page), await open(second)];
    await expect(mine).toContainText('Osoba odpowiedzialna (Druga E2E) dostanie automatyczne przypomnienie');
    await expect(theirs).toContainText('Odpowiadasz za to zadanie');

    // Właściciel ustawia sobie przypomnienie — druga osoba go nie widzi.
    await mine.getByLabel('Dodaj przypomnienie').selectOption('rel:60');
    await expect(mine.getByRole('button', { name: 'Usuń przypomnienie' })).toHaveCount(1);
    await expect.poll(async () => (await db.from('reminders').select('created_by').eq('task_id', task)).data?.map((r) => r.created_by)).toEqual([server.userId]);
    await theirs.getByLabel('Dodaj przypomnienie').selectOption('rel:0');
    await expect(theirs.getByRole('button', { name: 'Usuń przypomnienie' })).toHaveCount(1);
    await expect.poll(async () => (await db.from('reminders').select('id').eq('task_id', task)).data?.length).toBe(2);
    // Po pobraniu cudzego przypomnienia lista dalej ma tylko własne.
    for (const p of [page, second]) await openApp(p, `#/list/${list}`);
    for (const section of [await open(page), await open(second)]) await expect(section.getByRole('button', { name: 'Usuń przypomnienie' })).toHaveCount(1);

    const { data } = await db.rpc('assignee_reminder_tasks', { p_users: [server.userId], p_from: '2000-01-01', p_to: '2100-01-01' });
    expect((data as { id: string }[]).some((t) => t.id === task)).toBe(false);
  } finally {
    await other.close();
    const deleted_at = new Date().toISOString();
    await db.from('lists').update({ deleted_at }).eq('id', list);
    await db.from('tasks').update({ deleted_at }).eq('id', task);
    await db.from('collaborators').update({ deleted_at }).eq('id', person);
  }
});
