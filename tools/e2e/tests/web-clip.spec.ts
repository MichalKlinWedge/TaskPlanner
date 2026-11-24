/** Zakładka „+ Task Planner”: wycinek strony w części `#` → opis zadania z cytatem i link; „✨ Streść”. */
import { defaultWorkspaceId } from '@taskplanner/core';
import type { BrowserContext, Page } from '@playwright/test';

import { expect, openApp, test, unique, type Server } from '../src/fixtures.ts';

const SITE = 'https://blog.example.test';
const PREFIXES = ['Ogród', 'Drugie', 'Nawadnianie', 'Stara zakładka'];
const PARAGRAPH = 'Podlewaj rano, zanim słońce nagrzeje ziemię — zażółć gęślą jaźń. ';

/** Strona testowa poza aplikacją (inna domena, bez sieci). */
async function openSite(context: BrowserContext, title: string): Promise<Page> {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><nav>MENU</nav><article><p id="p1">Pierwszy &lt;b&gt; akapit.</p><p id="p2">Drugi akapit z access_token i [linkiem](https://zly.example).</p><p>${PARAGRAPH.repeat(6)}</p></article>`;
  await context.route(`${SITE}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const site = await context.newPage();
  await site.goto(`${SITE}/wpis?a=1`);
  return site;
}

/** Kod zakładki z karty w Ustawieniach (`href`, jak po przeciągnięciu na pasek). */
async function bookmarklet(page: Page): Promise<string> {
  await openApp(page, '#/settings');
  const link = page.getByTestId('bookmarklet');
  await expect(link).toHaveAttribute('href', /^javascript:/);
  return (await link.getAttribute('href'))!;
}

/** Kliknięcie zakładki: kod z adresu `javascript:` na stronie; zwraca nową kartę aplikacji i otwarty adres. */
async function click(site: Page, href: string): Promise<{ app: Page; opened: string }> {
  const requests: string[] = [];
  site.context().on('request', (r) => requests.push(r.url()));
  const popup = site.context().waitForEvent('page');
  // Przeglądarka dekoduje procenty w adresie `javascript:`, zanim go wykona.
  await site.evaluate((code) => void window.setTimeout(decodeURIComponent(code), 0), href.slice('javascript:'.length));
  const app = await popup;
  await expect(app.getByRole('dialog', { name: 'Szybkie dodawanie' })).toBeVisible({ timeout: 30_000 });
  return { app, opened: requests.find((u) => u.includes('localhost') && new URL(u).pathname === '/') ?? '' };
}

async function taskDetails(server: Server, title: string) {
  const { id } = await server.waitForTask(title);
  const read = async () => {
    const { data: task } = await server.client.from('tasks').select('description_md, source').eq('id', id).single();
    const { data: links } = await server.client.from('attachments').select('url').eq('task_id', id).is('deleted_at', null);
    return { description: task?.description_md as string | null, source: task?.source as { kind: string }, links: links?.map((l) => l.url as string) ?? [] };
  };
  await expect.poll(async () => (await read()).links.length).toBe(1);
  return read();
}

// Okno otwiera się nad „Dziś”, więc zadania mają dzisiejszy termin — do kosza, żeby nie zapychały kalendarza kolejnym testom.
test.afterEach(async ({ server }) => {
  const { error } = await server.client.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('scope_id', defaultWorkspaceId(server.userId, 'personal')).or(PREFIXES.map((t) => `title.like.${t} *`).join(','));
  expect(error).toBeNull();
});

test('zaznaczenie: cytat ze źródłem w opisie, poprawiony przed dodaniem; adres bez treści strony', async ({ page, context, server }) => {
  const title = unique('Ogród');
  const href = await bookmarklet(page);
  const site = await openSite(context, title);
  await site.evaluate(() => {
    const range = document.createRange();
    range.setStartBefore(document.getElementById('p1')!);
    range.setEndAfter(document.getElementById('p2')!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  const { app, opened } = await click(site, href);
  // Do serwera idzie sam adres aplikacji: treść była tylko w części `#`, a ta znika z adresu.
  expect(new URL(opened).search).toBe('');
  expect(new URL(app.url()).search).toBe('');
  expect(new URL(app.url()).hash).not.toContain('share');

  const dialog = app.getByRole('dialog', { name: 'Szybkie dodawanie' });
  await expect(dialog.getByRole('textbox', { name: 'Zadanie z udostępnionego linku' })).toHaveValue(title);
  const description = dialog.getByRole('textbox', { name: 'Opis' });
  const quote = `> Pierwszy \\<b> akapit.\n>\n> Drugi akapit z access_token i \\[linkiem\\](https://zly.example).\n\nŹródło: [${title}](${SITE}/wpis?a=1)`;
  await expect(description).toHaveValue(quote);
  await expect(dialog.getByRole('button', { name: /Streść/ })).toHaveCount(0);
  await description.fill(`${quote}\n\nMoja notatka`);
  // Escape w opisie wraca do tytułu, nie zamyka okna.
  await description.press('Escape');
  await expect(dialog.getByRole('textbox', { name: 'Zadanie z udostępnionego linku' })).toBeFocused();
  await app.keyboard.press('Control+Enter');
  // Okno zostaje (Ctrl+Enter), ale wycinek należał do pierwszego zadania.
  await expect(description).toHaveCount(0);
  const second = unique('Drugie');
  await dialog.getByRole('textbox').fill(second);
  await app.keyboard.press('Enter');
  await expect(dialog).toBeHidden();

  expect(await taskDetails(server, title)).toEqual({ description: `${quote}\n\nMoja notatka`, source: { kind: 'link', url: `${SITE}/wpis?a=1`, title }, links: [`${SITE}/wpis?a=1`] });
  const other = await server.waitForTask(second);
  const { data } = await server.client.from('tasks').select('description_md, source, attachments(id)').eq('id', other.id).single();
  expect(data).toMatchObject({ description_md: null, source: { kind: 'quick_add' }, attachments: [] });

  // Opis w panelu zadania to cytat: znacznik i link z obcej strony są tekstem.
  await app.goto(`/?task=${(await server.task(title))!.id}`);
  const panel = app.getByRole('complementary', { name: 'Zadanie' });
  const preview = panel.locator('blockquote');
  if (!(await preview.isVisible().catch(() => false))) await panel.getByRole('button', { name: 'Podgląd' }).first().click();
  await expect(preview).toContainText('Pierwszy <b> akapit.');
  await expect(preview).toContainText('[linkiem](');
  await expect(preview.locator('b')).toHaveCount(0);
  await app.close();
});

test('bez zaznaczenia tekst strony nie trafia do opisu; „Streść” wypełnia pola, zapis po Enter', async ({ page, context, server }) => {
  const title = unique('Nawadnianie');
  // Sprawdzone konto AI bez klucza w Vault — odpowiedź funkcji jest podstawiona w przeglądarce.
  await server.client.from('ai_accounts').update({ deleted_at: new Date().toISOString() }).eq('user_id', server.userId);
  const { data: account, error } = await server.client
    .from('ai_accounts')
    .insert({ user_id: server.userId, provider: 'gemini', model: 'gemini-3.5-flash-lite', status: 'active', key_hint: '…test', billing_confirmed_at: new Date().toISOString() })
    .select('id')
    .single();
  expect(error).toBeNull();
  try {
    const href = await bookmarklet(page);
    const asked: Record<string, unknown>[] = [];
    await context.route('**/functions/v1/ai/clip', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      asked.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: { title: `#Praca ${title} latem`, points: ['Podlewaj rano.', '[Zaloguj](https://zly.example) <i>teraz</i>'], model: 'gemini-3.5-flash-lite' },
      });
    });
    const site = await openSite(context, title);
    const { app } = await click(site, href);
    const dialog = app.getByRole('dialog', { name: 'Szybkie dodawanie' });
    const name = dialog.getByRole('textbox', { name: 'Zadanie z udostępnionego linku' });
    const description = dialog.getByRole('textbox', { name: 'Opis' });
    await expect(name).toHaveValue(title);
    await expect(description).toHaveValue('');

    await context.setOffline(true);
    await expect(dialog.getByRole('button', { name: '✨ Streść' })).toBeDisabled();
    await context.setOffline(false);
    await dialog.getByRole('button', { name: '✨ Streść' }).click();
    const summary = `- Podlewaj rano.\n- Zaloguj teraz\n\nŹródło: [${title}](${SITE}/wpis?a=1)`;
    await expect(description).toHaveValue(summary);
    await expect(name).toHaveValue(`Praca ${title} latem`);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ accountId: account!.id, title, site: 'blog.example.test' });
    expect(String(asked[0]!.text)).toContain('zażółć gęślą jaźń');
    expect(String(asked[0]!.text)).not.toContain('MENU');
    // Nic się nie zapisało, a wynik da się cofnąć.
    expect(await server.task(title)).toBeNull();
    await dialog.getByRole('button', { name: 'Cofnij streszczenie' }).click();
    await expect(name).toHaveValue(title);
    await expect(description).toHaveValue('');
    await dialog.getByRole('button', { name: '✨ Streść' }).click();
    await expect(description).toHaveValue(summary);
    await name.fill(title);
    await name.press('Enter');
    await expect(dialog).toBeHidden();

    expect(await taskDetails(server, title)).toMatchObject({ description: summary, links: [`${SITE}/wpis?a=1`] });
    await app.close();
  } finally {
    await server.client.from('ai_accounts').update({ deleted_at: new Date().toISOString() }).eq('id', account!.id);
  }
});

test('stara zakładka i Web Share Target (`?share_…`) działają jak dotąd', async ({ page, server }) => {
  const title = unique('Stara zakładka');
  await page.goto(`/?${new URLSearchParams({ share_url: `${SITE}/stary`, share_title: title })}`);
  const dialog = page.getByRole('dialog', { name: 'Szybkie dodawanie' });
  const name = dialog.getByRole('textbox', { name: 'Zadanie z udostępnionego linku' });
  await expect(name).toHaveValue(title, { timeout: 30_000 });
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  expect(new URL(page.url()).search).toBe('');
  await name.press('Enter');
  expect(await taskDetails(server, title)).toEqual({ description: null, source: { kind: 'link', url: `${SITE}/stary`, title }, links: [`${SITE}/stary`] });
});
