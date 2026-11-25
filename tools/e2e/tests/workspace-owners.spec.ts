/**
 * Rola właściciela dla współpracownika i przekazanie przestrzeni (v1.x): propozycja działa dopiero po
 * potwierdzeniu przez drugą osobę. Przestrzeń „Wspólna E2E” (`sharedIds`): właściciel = konto E2E,
 * edytor = `E2E_EMAIL_2`; na końcu wraca do konta E2E.
 */
import type { Page } from '@playwright/test';

import { E2E_EMAIL, E2E_EMAIL_2 } from '../src/constants.ts';
import { expect, openApp, test, type Server } from '../src/fixtures.ts';
import { AUTH_FILE_2, sharedIds } from '../src/global-setup.ts';

const WORKSPACE = 'Wspólna E2E';

/** Pytania (`window.confirm`) ze strony; każde przyjęte. */
function acceptDialogs(page: Page): string[] {
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.accept();
  });
  return asked;
}

/** Powrót do karty przeglądarki — odświeża propozycje i panel osób. */
const focus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

/** Przycisk („Udostępnij”) na karcie przestrzeni „Wspólna E2E” — inne testy dokładają przestrzenie, więc po nazwie. */
const openPeople = (page: Page, name: string) =>
  page.locator('main').getByRole('button', { name: WORKSPACE, exact: true }).locator(`xpath=ancestor::*[.//button[normalize-space()="${name}"]][1]`).getByRole('button', { name, exact: true }).click();

/** Role na serwerze, np. `{ A: 'owner*' }` (`*` = główny właściciel). */
async function roles(server: Server, workspace: string, names: Record<string, string>) {
  const [{ data: members }, { data: scope }] = await Promise.all([
    server.client.from('scope_members').select('user_id, role').eq('scope_id', workspace),
    server.client.from('sync_scopes').select('owner_id').eq('id', workspace).single(),
  ]);
  return Object.fromEntries((members ?? []).map((m) => [names[String(m.user_id)], `${m.role}${scope?.owner_id === m.user_id ? '*' : ''}`]));
}

test('właściciel proponuje rolę i przekazuje przestrzeń — za zgodą współpracownika', async ({ page, browser, server }, info) => {
  test.setTimeout(120_000);
  const { workspace } = sharedIds(server.userId);
  await server.resetSharedRoles(workspace);
  const { data: others } = await server.client.from('scope_members').select('user_id').eq('scope_id', workspace).neq('user_id', server.userId);
  const secondId = String(others![0]!.user_id);
  const now = () => roles(server, workspace, { [server.userId]: 'A', [secondId]: 'B' });
  const use = info.project.use;
  const other = await browser.newContext({ baseURL: use.baseURL, locale: use.locale, timezoneId: use.timezoneId, viewport: use.viewport, storageState: AUTH_FILE_2 });
  const second = await other.newPage();
  try {
    const askedA = acceptDialogs(page);
    const askedB = acceptDialogs(second);
    await openApp(page, '#/manage');
    await openPeople(page, 'Udostępnij');
    const panel = page.getByTestId('sharing-panel');
    expect(await now()).toEqual({ A: 'owner*', B: 'editor' });

    // Propozycja roli: do zgody nic się nie zmienia.
    await panel.getByLabel(`Rola ${E2E_EMAIL_2}`).selectOption('owner');
    await expect(panel.getByTestId('owner-offer')).toContainText(`Rola właściciela dla ${E2E_EMAIL_2}`);
    expect(askedA.at(-1)).toContain('te same uprawnienia');
    expect(await now()).toEqual({ A: 'owner*', B: 'editor' });

    // Odmowa.
    await openApp(second, '#/manage');
    const offer = second.getByTestId('ownership-offer');
    await expect(offer).toContainText(`${E2E_EMAIL} proponuje Ci rolę właściciela`);
    await offer.getByRole('button', { name: 'Odmów' }).click();
    await expect(offer).toHaveCount(0);
    expect(await now()).toEqual({ A: 'owner*', B: 'editor' });

    // Ponowna propozycja i zgoda z potwierdzeniem.
    await focus(page);
    await expect(panel.getByTestId('owner-offer')).toHaveCount(0);
    await panel.getByLabel(`Rola ${E2E_EMAIL_2}`).selectOption('owner');
    await expect(panel.getByTestId('owner-offer')).toHaveCount(1);
    await focus(second);
    await offer.getByRole('button', { name: 'Przyjmij…' }).click();
    await expect(second.getByText(`Jesteś teraz właścicielem przestrzeni „${WORKSPACE}”.`)).toBeVisible();
    expect(askedB.at(-1)).toContain('Potwierdź przejęcie');
    expect(await now()).toEqual({ A: 'owner*', B: 'owner' });

    // Przekazanie przestrzeni: współwłaściciel staje się głównym, dotychczasowy — edytorem.
    await focus(page);
    await expect(panel.getByText('Główny właściciel').first()).toBeVisible();
    await panel.getByTestId('ownership').getByLabel('Przejmuje').selectOption(secondId);
    await panel.screenshot({ path: info.outputPath('wlasciciel.png') });
    await panel.getByRole('button', { name: 'Przekaż przestrzeń…' }).click();
    await expect(panel.getByTestId('owner-offer')).toContainText('Przekazanie przestrzeni');
    expect(await now()).toEqual({ A: 'owner*', B: 'owner' });
    await focus(second);
    await expect(offer).toContainText('zrzeka się roli właściciela');
    await second.screenshot({ path: info.outputPath('zgoda.png') });
    await offer.getByRole('button', { name: 'Przejmij…' }).click();
    await expect.poll(now).toEqual({ A: 'editor', B: 'owner*' });
    expect(askedB.at(-1)).toContain('głównym właścicielem');

    // Nowa rola dochodzi do poprzedniego właściciela synchronizacją (bez odświeżania strony).
    await expect(page.locator('main').getByText('udostępniona · edytor')).toBeVisible({ timeout: 15_000 });
    await focus(page);
    await expect(panel.getByText('Twoja rola: Edytor.')).toBeVisible();
    await expect(panel.getByTestId('ownership')).toHaveCount(0);

    // Z powrotem do konta E2E: B przekazuje i zostaje z podglądem.
    await openPeople(second, 'Udostępnij');
    const panelB = second.getByTestId('sharing-panel');
    await panelB.getByTestId('ownership').getByLabel('Przejmuje').selectOption(server.userId);
    await panelB.getByTestId('ownership').getByLabel('Twoja rola potem').selectOption('viewer');
    await panelB.getByRole('button', { name: 'Przekaż przestrzeń…' }).click();
    await expect(panelB.getByTestId('owner-offer')).toHaveCount(1);
    await focus(page);
    await page.getByTestId('ownership-offer').getByRole('button', { name: 'Przejmij…' }).click();
    await expect.poll(now).toEqual({ A: 'owner*', B: 'viewer' });
  } finally {
    await other.close();
  }
});
