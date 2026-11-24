/**
 * Eksport i import przestrzeni (v1.x): udostępniona przestrzeń z załącznikiem zapisana do pliku JSON
 * i wczytana jako nowa — zadania, plik w Storage i zaproszenie z rolą są na serwerze.
 */
import { readFile } from 'node:fs/promises';

import { inboxId } from '@taskplanner/core';

import { E2E_EMAIL_2, E2E_SHARED_CARDS, E2E_SHARED_LIST } from '../src/constants.ts';
import { expect, openApp, taskRow, test, unique } from '../src/fixtures.ts';
import { sharedIds } from '../src/global-setup.ts';

test('przestrzeń z załącznikiem i rolami: eksport do JSON i import jako nowa', async ({ page, server }) => {
  const { workspace } = sharedIds(server.userId);
  await openApp(page, `#/list/${inboxId(workspace)}`);
  const title = unique('Z plikiem');
  const add = page.getByRole('main').getByRole('textbox', { name: 'Dodaj do „Inbox”' });
  await add.fill(title);
  await add.press('Enter');
  const task = await server.waitForTask(title);
  await taskRow(page, title).getByText(title).click();
  await page.getByLabel('Wybierz pliki').setInputFiles({ name: 'umowa.txt', mimeType: 'text/plain', buffer: Buffer.from('Treść umowy ż') });
  const attachments = async (taskId: string) => (await server.client.from('attachments').select('*').eq('task_id', taskId).is('deleted_at', null)).data ?? [];
  await expect.poll(async () => (await attachments(task.id)).length, { timeout: 15_000 }).toBe(1);

  // Eksport z karty przestrzeni.
  await openApp(page, '#/manage');
  const card = page.locator('main').getByRole('button', { name: 'Wspólna E2E', exact: true }).locator('xpath=ancestor::*[.//button[@data-testid="workspace-export"]][1]');
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByTestId('workspace-export').click()]);
  expect(download.suggestedFilename()).toMatch(/^wspolna-e2e-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.getByTestId('workspace-export-message')).toContainText('Zapisano przestrzeń „Wspólna E2E”');
  const path = await download.path();
  const json = JSON.parse(await readFile(path, 'utf8')) as { accounts: { email: string; role: string }[]; tables: Record<string, unknown[]>; files: { data: string }[] };
  expect(json.accounts.map((a) => a.role).sort()).toEqual(['editor', 'owner']);
  expect(json.tables.tasks!.length).toBeGreaterThanOrEqual(E2E_SHARED_CARDS + 1);
  expect(Buffer.from(json.files[0]!.data, 'base64').toString('utf8')).toBe('Treść umowy ż');

  // Import: podgląd, nowa nazwa, osoba z rolą „Podgląd”.
  await page.getByTestId('workspace-import-file').setInputFiles({ name: 'wspolna.json', mimeType: 'application/json', buffer: await readFile(path) });
  const preview = page.getByTestId('workspace-import-preview');
  await expect(preview.getByTestId('workspace-import-name')).toHaveValue('Wspólna E2E (import)');
  const name = unique('Kopia');
  await preview.getByTestId('workspace-import-name').fill(name);
  const role = preview.getByRole('combobox', { name: `Rola po imporcie: ${E2E_EMAIL_2}` });
  await expect(role).toHaveValue('editor');
  await role.selectOption('viewer');
  await preview.getByTestId('workspace-import-run').click();
  const message = page.getByTestId('workspace-import-message');
  await expect(message).toContainText(`Utworzono przestrzeń „${name}”`, { timeout: 30_000 });
  await expect(message).toContainText(`Zaproszenia wysłane: ${E2E_EMAIL_2}`);

  // Serwer: nowa przestrzeń z tymi samymi zadaniami, zaproszenie z rolą, plik pod nową ścieżką.
  const { data: created } = await server.client.from('workspaces').select('id').eq('name', name).single();
  const scope = created!.id as string;
  const { count } = await server.client.from('tasks').select('id', { count: 'exact', head: true }).eq('scope_id', scope);
  expect(count).toBe(json.tables.tasks!.length);
  const { data: lists } = await server.client.from('lists').select('name').eq('scope_id', scope);
  expect(lists!.map((l) => l.name)).toContain(E2E_SHARED_LIST);
  const { data: invites } = await server.client.from('scope_invites').select('email, role').eq('scope_id', scope);
  expect(invites).toEqual([{ email: E2E_EMAIL_2, role: 'viewer' }]);
  const { data: copy } = await server.client.from('tasks').select('id').eq('scope_id', scope).eq('title', title).single();
  await expect.poll(async () => (await attachments(copy!.id as string)).length, { timeout: 30_000 }).toBe(1);
  const [row] = await attachments(copy!.id as string);
  const { data: blob } = await server.client.storage.from('attachments').download(String(row!.storage_path));
  expect(await blob!.text()).toBe('Treść umowy ż');
});
