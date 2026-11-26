/** Historia zmian zadania (M3): tagi dodane i zdjęte, zmiana z reguły integracji, „Wyślij do…” z nazwą własnej reguły. */
import { randomUUID } from 'node:crypto';

import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';

test('historia zadania: tagi, reguła integracji i wysyłka', async ({ page, server }) => {
  // Połączenie i reguła konta (bez sekretu — nic nie jest wysyłane, stan wysyłki zapisuje test).
  const [connection, rule] = [randomUUID(), randomUUID()];
  const ok = async (step: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await step;
    if (error) throw new Error(error.message);
  };
  await ok(server.client.from('plugin_connections').insert({ id: connection, user_id: server.userId, plugin: 'gitlab', label: 'GitLab E2E', config: {}, status: 'disabled' }));
  await ok(
    server.client.from('plugin_rules').insert({
      id: rule, scope_id: server.userId, created_by: server.userId, name: 'Zgłoś błąd', connection_id: connection, enabled: true,
      trigger: { kind: 'manual' }, action: {}, options: {}, sort_key: 'n',
    }),
  );

  await openApp(page, '#/inbox');
  const title = unique('Z historią');
  await page.keyboard.press('q');
  const input = page.getByRole('dialog', { name: 'Szybkie dodawanie' }).getByRole('textbox', { name: 'Dodaj zadanie' });
  await input.fill(`${title} @hist-jeden @hist-dwa`);
  await input.press('Enter');
  const task = await server.waitForTask(title);
  const tags = async () => (await server.client.from('task_tags').select('tag_id').eq('task_id', task.id).is('deleted_at', null)).data ?? [];
  await expect.poll(async () => (await tags()).length).toBe(2);

  // Jak Edge Function `plugins`: wysyłka „Wyślij do…” i zmiana zadania po niej.
  const { data: tagRows } = await server.client.from('tags').select('id, name').eq('scope_id', server.userId).in('name', ['hist-jeden', 'hist-dwa']);
  const tagId = (name: string) => tagRows!.find((t) => t.name === name)!.id as string;
  const delivery = randomUUID();
  await ok(server.client.from('plugin_deliveries').insert({ id: delivery, user_id: server.userId, rule_id: rule, connection_id: connection, task_id: task.id, source: 'manual', events: ['task.sent'], status: 'sending' }));
  await ok(server.client.rpc('plugin_after_send', { p_user: server.userId, p_task: task.id, p_status: 'waiting', p_add: [], p_remove: [tagId('hist-jeden')], p_rule: rule }));
  await ok(server.client.from('plugin_deliveries').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', delivery));

  await taskRow(page, title).getByText(title).click();
  const panel = page.getByRole('complementary', { name: 'Zadanie', exact: true });
  const history = panel.locator('[data-section="history"]');
  await history.locator('button[aria-expanded]').click();
  const entries = history.locator('ol > li');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText('Wyślij do…: wysłano do GitLab (reguła „Zgłoś błąd”)');
  await expect(entries.nth(1)).toContainText('reguła integracji „Zgłoś błąd”');
  await expect(entries.nth(1)).toContainText('Status: Oczekuje');
  await expect(entries.nth(1)).toContainText('Usunięto tag: hist-jeden');
  await expect(entries.nth(2)).toContainText('utworzono');
  await expect(entries.nth(2)).toContainText(/Dodano tagi: hist-(jeden, hist-dwa|dwa, hist-jeden)/);
});
