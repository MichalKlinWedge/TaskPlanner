/**
 * Widok „Karteczki” (v1.x): karteczka nie wchodzi na zajętą komórkę, karta z paska „Do ułożenia”
 * na tablicę, dwuklik dodaje karteczkę w komórce, kolejność tagów zmienia kolor, pełny ekran,
 * przełącznik „Tylko główne / Z podzadaniami”, eksport PNG / PDF (także offline), blokada edycji bez sieci,
 * strzałki („blokuje” = zależność, cykl odrzucony, „wynika z”, Delete i „Cofnij”), menu „Ułóż” (podgląd,
 * według priorytetu z ramkami, „Cofnij”, ponownie bez zmian, „Zagęść”, „Według hierarchii”, offline). Dane listy z `global-setup.ts` (`canvasIds`).
 */
import { readFile } from 'node:fs/promises';

import type { Locator } from '@playwright/test';

import { E2E_CANVAS } from '../src/constants.ts';
import { center, drag } from '../src/drag.ts';
import { expect, openApp, test, unique } from '../src/fixtures.ts';
import { canvasIds } from '../src/global-setup.ts';

/** Kolor w stylu karteczki (`color-mix(…)`), niezależnie od zapisu przeglądarki (hex / rgb). */
const hasColor = (card: Locator, hex: string, rgb: string) =>
  expect.poll(async () => {
    const style = ((await card.getAttribute('style')) ?? '').toLowerCase();
    return style.includes(hex.toLowerCase()) || style.includes(rgb);
  });

test('karteczki: przesuwanie bez nachodzenia, pasek, dodawanie, kolor z tagu, pełny ekran, offline', async ({ page, context, server }) => {
  const ids = canvasIds(server.userId);
  await openApp(page, `#/list/${ids.list}`);
  const view = page.getByTestId('canvas-view');
  const board = page.getByTestId('canvas-board');
  const tray = page.getByTestId('canvas-tray');
  const card = (id: string) => board.locator(`[data-canvas-card][data-task-id="${id}"]`);
  await expect(view).toBeVisible();
  await expect(board.locator('[data-canvas-card]')).toHaveCount(2);
  await expect(tray.getByText(E2E_CANVAS.tray)).toBeVisible();

  await test.step('odpowiedzialny, obrysowany uczestnik i kolor pierwszego kolorowego tagu', async () => {
    await expect(card(ids.first).getByTestId('canvas-assignee')).toHaveText('ON');
    await expect(card(ids.first).getByTestId('canvas-participant')).toHaveText('JK');
    await hasColor(card(ids.first), '#3b82f6', 'rgb(59, 130, 246)').toBe(true);
  });

  await test.step('karteczka upuszczona na zajętą komórkę ląduje w najbliższej wolnej', async () => {
    await drag(page, await center(card(ids.first)), await center(card(ids.second)));
    // Komórka (1, 0) zajęta → najbliższa wolna przy remisie: wyższy wiersz → (1, −1).
    const moved = await server.waitForTask(E2E_CANVAS.first, (t) => t.canvas_pos?.row === -1);
    expect(moved.canvas_pos).toEqual({ col: 1, row: -1 });
    expect((await server.task(E2E_CANVAS.second))?.canvas_pos).toEqual({ col: 1, row: 0 });
  });

  await test.step('karta z paska „Do ułożenia” na tablicę', async () => {
    const target = await center(card(ids.second));
    await drag(page, await center(tray.getByText(E2E_CANVAS.tray)), { x: target.x + 2 * 204, y: target.y + 144 });
    await expect(card(ids.tray)).toBeVisible();
    await expect(tray.locator('[data-task-id]')).toHaveCount(0);
    await server.waitForTask(E2E_CANVAS.tray, (t) => t.canvas_pos !== null);
  });

  await test.step('dwuklik w puste miejsce dodaje karteczkę w tej komórce', async () => {
    const box = (await board.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width - 120, box.y + box.height - 100);
    const title = unique('Karteczka');
    await page.getByPlaceholder('Nowa karteczka — Enter dodaje, Esc zamyka').fill(title);
    await page.keyboard.press('Enter');
    const added = await server.waitForTask(title, (t) => t.canvas_pos !== null);
    await expect(card(added.id)).toBeVisible();
  });

  await test.step('tytuł 120 znaków mieści się w karcie tego samego kształtu', async () => {
    const box = (await board.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width - 120, box.y + box.height - 270);
    const title = 'Przygotować na warsztaty zespołu listę pomysłów na nową stronę główną, zebrać opinie klientów i ustalić budżet kampanii.'.slice(0, 120);
    expect(title).toHaveLength(120);
    await page.getByPlaceholder('Nowa karteczka — Enter dodaje, Esc zamyka').fill(title);
    await page.keyboard.press('Enter');
    const added = await server.waitForTask(title, (t) => t.canvas_pos !== null);
    await expect(card(added.id)).toBeVisible();
    await expect(card(added.id)).not.toHaveAttribute('data-clipped');
    const [long, short] = await Promise.all([card(added.id).boundingBox(), card(ids.second).boundingBox()]);
    expect({ w: Math.round(long!.width), h: Math.round(long!.height) }).toEqual({ w: Math.round(short!.width), h: Math.round(short!.height) });
  });

  await test.step('kolejność tagów w panelu zadania zmienia kolor karteczki', async () => {
    // Karteczka w wierszu −1 wystaje nad obszar — najpierw cała tablica w widoku.
    await view.getByRole('button', { name: 'Dopasuj' }).click();
    await card(ids.first).dblclick();
    const chips = page.getByTestId('task-tag-chip');
    await expect(chips).toHaveCount(2);
    await chips.filter({ hasText: 'czerwony' }).dragTo(chips.filter({ hasText: 'niebieski' }));
    await expect(chips.first()).toContainText('czerwony');
    await hasColor(card(ids.first), '#ef4444', 'rgb(239, 68, 68)').toBe(true);
    await page.getByRole('button', { name: 'Zamknij panel (Esc)' }).click();
  });

  await test.step('spacja + przeciąganie nad karteczką przesuwa tablicę, nie kartę', async () => {
    await board.click({ position: { x: 10, y: 10 } });
    const before = (await card(ids.second).boundingBox())!;
    await page.keyboard.down('Space');
    await drag(page, await center(card(ids.second)), { x: before.x + before.width / 2 + 150, y: before.y + before.height / 2 + 80 });
    await page.keyboard.up('Space');
    const after = (await card(ids.second).boundingBox())!;
    expect(Math.round(after.x - before.x)).toBeGreaterThan(100);
    expect(Math.round(after.y - before.y)).toBeGreaterThan(50);
    expect((await server.task(E2E_CANVAS.second))?.canvas_pos).toEqual({ col: 1, row: 0 });
  });

  await test.step('nowa grupa: nazwa wpisana od razu po „Grupuj” trafia do grupy, nie do skrótów', async () => {
    await board.click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+a');
    await view.getByRole('button', { name: /Grupuj/ }).click();
    await page.keyboard.type('Ryzyka');
    await page.keyboard.press('Enter');
    await expect(board.locator('[data-canvas-group]').filter({ hasText: 'Ryzyka' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zamknij panel (Esc)' })).toBeHidden();
  });

  await test.step('pełny ekran i wyjście klawiszem Esc', async () => {
    await page.getByTestId('canvas-full').click();
    await expect(view).toHaveAttribute('data-full', 'true');
    await board.click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Escape');
    await expect(view).not.toHaveAttribute('data-full');
  });

  await test.step('„Z podzadaniami” pokazuje podzadanie, „Tylko główne” je ukrywa — bez zmiany jego komórki', async () => {
    await expect(card(ids.second).getByTestId('canvas-subtasks')).toHaveText('↳ 0/1');
    await expect(card(ids.sub)).toHaveCount(0);
    await view.getByRole('radio', { name: 'Z podzadaniami' }).click();
    await expect(card(ids.sub)).toBeVisible();
    await expect(card(ids.sub).getByTestId('canvas-parent')).toContainText(E2E_CANVAS.second);
    // Linia rodzic → podzadanie (kropkowana, tylko do oglądania).
    const parentLine = board.locator(`[data-canvas-arrow][data-kind="parent"][data-from="${ids.second}"][data-to="${ids.sub}"]`);
    await expect(parentLine).toHaveCount(1);
    // „Hierarchia” chowa linię rodzic → podzadanie (karta podzadania zostaje).
    const hierarchy = view.getByRole('button', { name: 'Hierarchia', exact: true });
    await hierarchy.click();
    await expect(parentLine).toHaveCount(0);
    await expect(card(ids.sub)).toBeVisible();
    await hierarchy.click();
    await expect(parentLine).toHaveCount(1);
    await view.getByRole('radio', { name: 'Tylko główne' }).click();
    await expect(hierarchy).toBeDisabled();
    await expect(card(ids.sub)).toHaveCount(0);
    await expect(parentLine).toHaveCount(0);
    expect((await server.task(E2E_CANVAS.sub))?.canvas_pos).toEqual({ col: -2, row: 3 });
  });

  await test.step('eksport: PNG online i PDF offline — poprawny nagłówek pliku, niezerowy rozmiar', async () => {
    const save = async (button: 'canvas-export-png' | 'canvas-export-pdf') => {
      await page.getByTestId('canvas-export').click();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId(button).click()]);
      return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
    };
    const png = await save('canvas-export-png');
    expect(png.name).toMatch(/^burza-e2e-\d{4}-\d{2}-\d{2}\.png$/);
    expect([...png.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Szerokość z nagłówka IHDR: skala 2× (co najmniej dwie karty po 180 px).
    expect(png.bytes.readUInt32BE(16)).toBeGreaterThan(2 * 2 * 180);
    await context.setOffline(true);
    await expect(page.getByTestId('canvas-note')).toBeVisible();
    const pdf = await save('canvas-export-pdf');
    expect(pdf.name).toMatch(/\.pdf$/);
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.bytes.subarray(-8).toString('latin1')).toContain('%%EOF');
    expect(pdf.bytes.toString('latin1')).toContain('/Filter /DCTDecode');
    expect(pdf.bytes.length).toBeGreaterThan(5000);
    await context.setOffline(false);
    await expect(page.getByTestId('canvas-note')).toBeHidden();
  });

  await test.step('bez sieci edycja zablokowana', async () => {
    await context.setOffline(true);
    await expect(page.getByTestId('canvas-note')).toBeVisible();
    await expect(view.getByRole('button', { name: '+ Karteczka' })).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByTestId('canvas-note')).toBeHidden();
  });
});

test('karteczki: strzałka „blokuje” = zależność na serwerze, cykl odrzucony, Delete i „Cofnij”, „wynika z”, pasek', async ({ page, context, server }) => {
  const ids = canvasIds(server.userId);
  await openApp(page, `#/list/${ids.list}`);
  const view = page.getByTestId('canvas-view');
  const board = page.getByTestId('canvas-board');
  const tray = page.getByTestId('canvas-tray');
  const card = (id: string) => board.locator(`[data-canvas-card][data-task-id="${id}"]`);
  const handle = (id: string) => card(id).locator('[data-canvas-handle]');
  const arrow = (from: string, to: string, kind: 'blocks' | 'derived') => board.locator(`[data-canvas-arrows="base"] [data-canvas-arrow][data-from="${from}"][data-to="${to}"][data-kind="${kind}"]`);
  const menu = page.getByTestId('canvas-link-menu');
  /** Strzałka z uchwytu karty `from` na kartę `to`. */
  const drawArrow = async (from: string, to: string) => {
    await card(from).hover();
    await drag(page, await center(handle(from)), await center(card(to)));
    await expect(menu).toBeVisible();
  };
  await expect(card(ids.first)).toBeVisible();
  await view.getByRole('button', { name: 'Dopasuj' }).click();

  await test.step('„blokuje” tworzy wiersz task_dependencies na serwerze', async () => {
    await drawArrow(ids.first, ids.second);
    await menu.getByRole('menuitem', { name: /blokuje/ }).click();
    await expect(arrow(ids.first, ids.second, 'blocks')).toHaveCount(1);
    const rows = await server.waitForDependency(ids.first, ids.second, (r) => r.some((d) => d.deleted_at === null));
    expect(rows).toHaveLength(1);
  });

  await test.step('odwrotna „blokuje” zamknęłaby cykl — odrzucona z komunikatem, bez wiersza', async () => {
    await drawArrow(ids.second, ids.first);
    await menu.getByRole('menuitem', { name: /blokuje/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'zamknęłaby cykl' })).toBeVisible();
    await expect(arrow(ids.second, ids.first, 'blocks')).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(await server.dependencies(ids.second, ids.first)).toHaveLength(0);
  });

  await test.step('zaznaczona strzałka: Delete usuwa zależność (nie karty), „Cofnij” ją przywraca', async () => {
    // Pionowa / pozioma linia ma ramkę o zerowej szerokości — Playwright uważa ją za niewidoczną; klik myszą w środek odcinka.
    const line = (await arrow(ids.first, ids.second, 'blocks').locator('line').first().boundingBox())!;
    await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
    await expect(page.getByTestId('canvas-arrow-label')).toContainText('blokuje');
    await page.keyboard.press('Delete');
    await expect(arrow(ids.first, ids.second, 'blocks')).toHaveCount(0);
    await expect(card(ids.first)).toBeVisible();
    await expect(card(ids.second)).toBeVisible();
    await server.waitForDependency(ids.first, ids.second, (r) => r.length === 1 && r[0]!.deleted_at !== null);
    await page.getByRole('status').getByRole('button', { name: 'Cofnij' }).click();
    await expect(arrow(ids.first, ids.second, 'blocks')).toHaveCount(1);
    await server.waitForDependency(ids.first, ids.second, (r) => r.length === 1 && r[0]!.deleted_at === null);
  });

  await test.step('„wynika z” (klawisz W) zapisuje tasks.derived_from', async () => {
    await drawArrow(ids.second, ids.first);
    await page.keyboard.press('w');
    await expect(arrow(ids.second, ids.first, 'derived')).toHaveCount(1);
    await server.waitForTask(E2E_CANVAS.first, (t) => t.derived_from?.includes(ids.second) ?? false);
  });

  await test.step('„Zależności” ukrywa strzałki (także po odświeżeniu) bez zmian na serwerze; nowa strzałka je włącza', async () => {
    const toggle = view.getByRole('button', { name: 'Zależności', exact: true });
    const all = board.locator('[data-canvas-arrows="base"] [data-canvas-arrow]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(all).toHaveCount(0);
    await page.reload();
    await expect(card(ids.first)).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(all).toHaveCount(0);
    expect((await server.dependencies(ids.first, ids.second)).filter((d) => d.deleted_at === null)).toHaveLength(1);
    // Odrzucony duplikat nie włącza strzałek.
    await drawArrow(ids.first, ids.second);
    await menu.getByRole('menuitem', { name: /blokuje/ }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(arrow(ids.first, ids.second, 'blocks')).toHaveCount(1);
    await expect(arrow(ids.second, ids.first, 'derived')).toHaveCount(1);
    // Usunięcie „blokuje” przy widocznych strzałkach, ukrycie, narysowanie od nowa → znów widoczne.
    const line = (await arrow(ids.first, ids.second, 'blocks').locator('line').first().boundingBox())!;
    await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
    await page.keyboard.press('Delete');
    await expect(arrow(ids.first, ids.second, 'blocks')).toHaveCount(0);
    await toggle.click();
    await expect(all).toHaveCount(0);
    await drawArrow(ids.first, ids.second);
    await menu.getByRole('menuitem', { name: /blokuje/ }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(arrow(ids.first, ids.second, 'blocks')).toHaveCount(1);
    await server.waitForDependency(ids.first, ids.second, (r) => r.filter((d) => d.deleted_at === null).length === 1);
  });

  await test.step('karta odłożona do paska: strzałek nie widać, „⇢ N” na drugiej karcie, zależność zostaje', async () => {
    await drag(page, await center(card(ids.second)), await center(tray));
    await expect(card(ids.second)).toHaveCount(0);
    await expect(board.locator('[data-canvas-arrows="base"] [data-canvas-arrow]')).toHaveCount(0);
    await expect(card(ids.first).getByTestId('canvas-offboard')).toHaveText('⇢ 1');
    expect((await server.dependencies(ids.first, ids.second)).filter((d) => d.deleted_at === null)).toHaveLength(1);
    // Z powrotem na tablicę — strzałki wracają.
    const target = await center(card(ids.first));
    await drag(page, await center(tray.getByText(E2E_CANVAS.second)), { x: target.x, y: target.y + 2 * 144 });
    await expect(arrow(ids.first, ids.second, 'blocks')).toHaveCount(1);
    await expect(arrow(ids.second, ids.first, 'derived')).toHaveCount(1);
  });

  await test.step('eksport PNG ze strzałkami na tablicy (treść sceny sprawdza core `canvas-export.test.ts`)', async () => {
    await page.getByTestId('canvas-export').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('canvas-export-png').click()]);
    const bytes = await readFile((await download.path())!);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.length).toBeGreaterThan(5000);
  });

  await test.step('bez sieci: bez uchwytów i bez zaznaczania strzałek', async () => {
    await context.setOffline(true);
    await expect(page.getByTestId('canvas-note')).toBeVisible();
    await expect(handle(ids.first)).toHaveCount(0);
    // Bez szerokiego obrysu do klikania — sama linia.
    await expect(arrow(ids.first, ids.second, 'blocks').locator('line')).toHaveCount(1);
    await context.setOffline(false);
    await expect(handle(ids.first)).toHaveCount(1);
  });
});

test('karteczki: „Ułóż” — podgląd, według priorytetu z ramkami, „Cofnij”, ponownie bez zmian, zagęszczanie, hierarchia, offline', async ({ page, context, server }) => {
  const ids = canvasIds(server.userId);
  await openApp(page, `#/list/${ids.list}`);
  const view = page.getByTestId('canvas-view');
  const board = page.getByTestId('canvas-board');
  const card = (id: string) => board.locator(`[data-canvas-card][data-task-id="${id}"]`);
  const arrange = page.getByTestId('canvas-arrange');
  const menu = page.getByTestId('canvas-arrange-menu');
  const byPriority = page.getByTestId('canvas-arrange-priority');
  const groupNames = async () => {
    const { data, error } = await server.client.from('lists').select('canvas_groups').eq('id', ids.list).single();
    if (error) throw new Error(error.message);
    return ((data.canvas_groups ?? []) as { name: string }[]).map((g) => g.name);
  };
  const pos = async (title: string) => (await server.task(title))!.canvas_pos;
  await expect(card(ids.first)).toBeVisible();
  await view.getByRole('button', { name: 'Dopasuj' }).click();
  const before = { first: await pos(E2E_CANVAS.first), second: await pos(E2E_CANVAS.second), groups: await groupNames() };
  expect(before.groups).toContain('Ryzyka');

  await test.step('najechanie na „Według priorytetu” pokazuje komórki docelowe i ramki, bez zapisu', async () => {
    await arrange.click();
    await expect(menu).toBeVisible();
    await byPriority.hover();
    await expect(board.locator('[data-canvas-arrange-cell]').first()).toBeVisible();
    await expect(board.locator('[data-canvas-arrange-frame]').filter({ hasText: '!1 Krytyczny' })).toBeVisible();
    await expect(byPriority).toContainText('ramki: +');
    expect(await pos(E2E_CANVAS.first)).toEqual(before.first);
  });

  await test.step('klik: kolumny priorytetów z ramkami na serwerze; pusta już grupa „Ryzyka” znika', async () => {
    await byPriority.click();
    await expect(menu).toBeHidden();
    await expect(board.locator('[data-canvas-arrange-cell]')).toHaveCount(0);
    await expect(board.locator('[data-canvas-group]').filter({ hasText: '!1 Krytyczny' })).toBeVisible();
    // `!1` (pierwsza karta) w pierwszej kolumnie, `!4` (druga) dalej w prawo, obie od tej samej górnej krawędzi.
    await expect.poll(async () => (await groupNames()).sort()).toEqual(['!1 Krytyczny', '!4 Niski']);
    const [first, second] = [await pos(E2E_CANVAS.first), await pos(E2E_CANVAS.second)];
    expect(second!.col).toBeGreaterThan(first!.col);
    expect(second!.row).toBe(first!.row);
  });

  await test.step('„Cofnij” przywraca komórki i grupy', async () => {
    await page.getByRole('status').filter({ hasText: 'Według priorytetu' }).getByRole('button', { name: 'Cofnij' }).click();
    await expect.poll(async () => (await groupNames()).sort()).toEqual([...before.groups].sort());
    await expect.poll(() => pos(E2E_CANVAS.first)).toEqual(before.first);
    expect(await pos(E2E_CANVAS.second)).toEqual(before.second);
    await expect(board.locator('[data-canvas-group]').filter({ hasText: 'Ryzyka' })).toBeVisible();
  });

  await test.step('ułożenie jeszcze raz, potem ten sam sposób — nic do zmiany', async () => {
    await arrange.click();
    await byPriority.click();
    await expect.poll(async () => (await groupNames()).sort()).toEqual(['!1 Krytyczny', '!4 Niski']);
    await arrange.click();
    await byPriority.hover();
    await expect(byPriority).toContainText('nic do zmiany');
    await expect(board.locator('[data-canvas-arrange-cell]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  await test.step('„Zagęść” na ułożonej tablicy nie ma czego skracać', async () => {
    await arrange.click();
    await page.getByTestId('canvas-arrange-compact').hover();
    await expect(page.getByTestId('canvas-arrange-compact')).toContainText('nic do zmiany');
    await page.keyboard.press('Escape');
  });

  await test.step('„Według hierarchii” z „Tylko główne”: pokazuje podzadania, główne w jednym rzędzie, podzadanie pod rodzicem; „Cofnij”', async () => {
    const start = { second: await pos(E2E_CANVAS.second), sub: await pos(E2E_CANVAS.sub) };
    const all = view.getByRole('radio', { name: 'Z podzadaniami' });
    await expect(all).toHaveAttribute('aria-checked', 'false');
    await arrange.click();
    await page.getByTestId('canvas-arrange-hierarchy').click();
    await expect(all).toHaveAttribute('aria-checked', 'true');
    await expect(card(ids.sub)).toBeVisible();
    await page.getByRole('status').filter({ hasText: 'Według hierarchii' }).getByRole('button', { name: 'Cofnij' }).click();
    await expect(all).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => ({ second: await pos(E2E_CANVAS.second), sub: await pos(E2E_CANVAS.sub) })).toEqual(start);
    await arrange.click();
    await page.getByTestId('canvas-arrange-hierarchy').click();
    await expect.poll(async () => {
      const [parent, sub] = [await pos(E2E_CANVAS.second), await pos(E2E_CANVAS.sub)];
      return parent && sub ? { dc: sub.col - parent.col, dr: sub.row - parent.row } : null;
    }).toEqual({ dc: 0, dr: 2 });
    expect((await pos(E2E_CANVAS.first))!.row).toBe((await pos(E2E_CANVAS.second))!.row);
    await expect(board.locator(`[data-canvas-arrow][data-kind="parent"][data-from="${ids.second}"][data-to="${ids.sub}"]`)).toHaveCount(1);
    await view.getByRole('radio', { name: 'Tylko główne' }).click();
    await expect(card(ids.sub)).toHaveCount(0);
  });

  await test.step('bez sieci menu „Ułóż” wyłączone', async () => {
    await context.setOffline(true);
    await expect(page.getByTestId('canvas-note')).toBeVisible();
    await expect(arrange).toBeDisabled();
    await context.setOffline(false);
    await expect(arrange).toBeEnabled();
  });
});
