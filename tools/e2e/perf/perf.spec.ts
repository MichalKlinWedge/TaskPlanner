/**
 * Pomiary na 10 000 zadań (SPECYFIKACJA §9): pierwsza synchronizacja, start z lokalnej bazy,
 * przełączanie widoków, zmiana → widok, paleta, szybkie dodawanie, płynność przeciągania.
 * Czas liczony w stronie (`performance.now()`): od akcji do narysowania klatki z wynikiem.
 * Wynik: tabela w konsoli i `tools/e2e/out/perf.json`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

interface Row {
  name: string;
  /** Próg z §9 (ms) albo `null` — tylko do wiadomości. */
  limit: number | null;
  samples: number[];
  note?: string;
}

const results: Row[] = [];
const record = (name: string, samples: number[], limit: number | null = null, note?: string) => {
  results.push({ name, limit, samples, note });
  console.log(`${name}: mediana ${Math.round(median(samples))} ms, max ${Math.round(max(samples))} ms${note ? ` (${note})` : ''}`);
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const max = (xs: number[]) => Math.max(...xs);

/**
 * W stronie: `action` (kod JS), potem czekanie, aż `ready` (wyrażenie JS) będzie prawdą, i na
 * narysowanie następnej klatki. Zwraca ms od akcji.
 */
async function timed(page: Page, action: string, ready: string, timeout = 20_000): Promise<number> {
  return page.evaluate(
    ({ action, ready, timeout }) =>
      new Promise<number>((resolve, reject) => {
        const isReady = new Function(`return (${ready});`) as () => boolean;
        const start = performance.now();
        new Function(action)();
        const painted = () => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
        const check = () => {
          if (isReady()) return painted();
          if (performance.now() - start > timeout) return reject(new Error(`Nie doczekano: ${ready}`));
          requestAnimationFrame(check);
        };
        check();
      }),
    { action, ready, timeout },
  );
}

const rowsIn = (h1: string) => `document.querySelector('main h1')?.textContent === ${JSON.stringify(h1)} && document.querySelectorAll('main [data-task-id]').length > 0`;

/** Odstępy między klatkami w trakcie `work` (rAF w stronie). */
async function frames(page: Page, work: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__frames = [];
    w.__recording = true;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames.push(now - last);
      last = now;
      if (w.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await work();
  const deltas = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__recording = false;
    return w.__frames.slice(1);
  });
  const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  return { fps: 1000 / avg, p95: [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * 0.95)]!, worst: max(deltas), dropped: deltas.filter((d) => d > 25).length, frames: deltas.length };
}

async function dragSlowly(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, back = true) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 60 });
  // Z powrotem na miejsce — upuszczenie bez zmiany danych.
  if (back) await page.mouse.move(from.x, from.y, { steps: 60 });
  await page.mouse.up();
}

test('10 000 zadań', async ({ page }) => {
  // 1. Pierwsza synchronizacja: pusta lokalna baza (nowy kontekst przeglądarki) → komplet danych.
  const started = Date.now();
  await page.goto('/#/today');
  // Status bywa „Zsynchronizowano” na chwilę przed pobieraniem — warunek łączny: powłoka, wiersze „Dziś”, status.
  await page.waitForFunction(
    new Function(`return document.querySelector('[data-testid=sync-status]')?.textContent === 'Zsynchronizowano' && (${rowsIn('Dziś')});`) as () => boolean,
    undefined,
    { timeout: 280_000, polling: 100 },
  );
  const firstSync = Date.now() - started;
  const localTasks = await page.evaluate(() => document.querySelectorAll('main [data-task-id]').length);
  record('Pierwsza synchronizacja (pusta baza → „Zsynchronizowano”)', [firstSync], null, `${localTasks} wierszy w „Dziś” po synchronizacji`);

  // 2. Start z lokalnej bazy (SW + OPFS): przeładowanie → „Dziś” z zadaniami.
  const starts: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.reload();
    const handle = await page.waitForFunction(new Function(`return (${rowsIn('Dziś')}) ? performance.now() : false;`) as () => number | false, undefined, { timeout: 60_000 });
    starts.push((await handle.jsonValue()) as number);
  }
  record('Start: przeładowanie → „Dziś” z zadaniami', starts);
  await expect(page.getByTestId('sync-status')).toHaveText('Zsynchronizowano', { timeout: 60_000 });

  // 3. Przełączanie widoków (dane już w pamięci; widok liczony z 10 000 zadań).
  const project = await page.evaluate(() => {
    // Lista z największym licznikiem w pasku bocznym.
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#/list/"]')];
    const scored = links.map((a) => ({ href: a.getAttribute('href')!, name: a.querySelector('span.truncate, span')?.textContent ?? '', count: Number(a.textContent?.match(/(\d+)\s*$/)?.[1] ?? 0) }));
    return scored.sort((a, b) => b.count - a.count)[0]!;
  });
  const projectName = await page.locator(`a[href="${project.href}"]`).evaluate((a) => a.textContent?.replace(/\d+\s*$/, '').trim() ?? '');
  const views: { name: string; hash: string; ready: string; limit: number | null }[] = [
    { name: '„Nadchodzące”', hash: '#/upcoming', ready: rowsIn('Nadchodzące'), limit: null },
    { name: '„Dziś”', hash: '#/today', ready: rowsIn('Dziś'), limit: 100 },
    { name: `Lista projektu („${projectName}”, ${project.count} otwartych)`, hash: project.href, ready: rowsIn(projectName), limit: 100 },
    { name: '„Inbox”', hash: '#/inbox', ready: rowsIn('Inbox'), limit: null },
    { name: 'Tablica', hash: '#/board', ready: `!!document.querySelector('[data-testid=board] [data-card]')`, limit: null },
    { name: 'Kalendarz (tydzień)', hash: '#/calendar', ready: `!!document.querySelector('[data-testid=calendar] .fc-timegrid-event, [data-testid=calendar] .fc-daygrid-event')`, limit: null },
    { name: 'Oś czasu (pierwsze otwarcie, potem zamontowana)', hash: '#/timeline', ready: `!!document.querySelector('[data-testid=timeline] .wx-bar')`, limit: null },
  ];
  await page.evaluate(() => localStorage.setItem('tp-calendar-view', 'timeGridWeek'));
  const samples = new Map<string, number[]>(views.map((v) => [v.name, []]));
  // Każde przejście z lekkiego widoku (Inbox, a do Inboxu — z „Dziś”): bez kosztu zdejmowania poprzedniego, ciężkiego widoku.
  for (let round = 0; round < 5; round++) {
    for (const v of views) {
      const from = v.hash === '#/inbox' ? { hash: '#/today', ready: rowsIn('Dziś') } : { hash: '#/inbox', ready: rowsIn('Inbox') };
      await timed(page, `location.hash = ${JSON.stringify(from.hash)};`, from.ready);
      samples.get(v.name)!.push(await timed(page, `location.hash = ${JSON.stringify(v.hash)};`, v.ready));
    }
  }
  for (const v of views) record(`Widok: ${v.name}`, samples.get(v.name)!, v.limit);

  // 4. Zmiana → widok: ukończenie zadania w „Dziś” (zapis, kolejka, odczyt 10 000 zadań, przeliczenie), potem „Cofnij”.
  await timed(page, `location.hash = '#/today';`, rowsIn('Dziś'));
  const done: number[] = [];
  const undo: number[] = [];
  for (let i = 0; i < 5; i++) {
    // Zadanie bez podzadań (rodzic pyta o podzadania przez `confirm`).
    const id = await page.evaluate(() =>
      [...document.querySelectorAll('main [data-task-id]')].find((row) => row.querySelector('[role=checkbox][aria-checked=false]') && !row.querySelector('[aria-expanded]'))!.getAttribute('data-task-id')!,
    );
    const box = `document.querySelector('main [data-task-id="${id}"] [role=checkbox]')`;
    done.push(await timed(page, `${box}.click();`, `!${box} || ${box}.getAttribute('aria-checked') === 'true'`));
    const undoButton = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cofnij')`;
    await page.waitForFunction(new Function(`return !!${undoButton};`) as () => boolean, undefined, { timeout: 10_000 });
    undo.push(await timed(page, `${undoButton}.click();`, `!!${box} && ${box}.getAttribute('aria-checked') === 'false'`));
  }
  record('Zmiana: ukończenie zadania → widok', done);
  record('Zmiana: „Cofnij” → widok', undo);

  // 5. Paleta: otwarcie (indeks z 10 000 zadań) i kolejne znaki zapytania.
  const opens: number[] = [];
  const keys: number[] = [];
  const typeInto = (selector: string, value: string) =>
    `const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true }));`;
  for (let i = 0; i < 5; i++) {
    opens.push(await timed(page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }));`, `!!document.querySelector('[role=dialog][aria-label="Paleta poleceń"] input')`));
    const input = '[role=dialog][aria-label="Paleta poleceń"] input';
    for (const q of ['r', 'ra', 'rap', 'rapo', 'rapor', 'raport', 'raport z', 'raport za']) {
      keys.push(await timed(page, typeInto(input, q), `true`));
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Paleta poleceń' })).toBeHidden();
  }
  record('Paleta: otwarcie (Ctrl+K)', opens);
  record('Paleta: znak zapytania → wyniki', keys);

  // 6. Szybkie dodawanie: znak → podgląd (parser z 40 listami i tagami + przerysowanie).
  const quick: number[] = [];
  await page.keyboard.press('q');
  const qInput = '[role=dialog][aria-label="Szybkie dodawanie"] input';
  const text = 'Zadzwonić do hydraulika jutro o 10 #Remont kuchni !wysoki ~30m';
  for (let n = 1; n <= text.length; n += 3) quick.push(await timed(page, typeInto(qInput, text.slice(0, n)), 'true'));
  await page.keyboard.press('Escape');
  record('Szybkie dodawanie: znak → podgląd', quick, null, 'parser sam: < 5 ms na wpis (korpus w core)');

  // 7. Płynność przeciągania: karta na tablicy i blok w kalendarzu (tam i z powrotem, bez zmiany danych).
  await timed(page, `location.hash = '#/board';`, `!!document.querySelector('[data-testid=board] [data-card]')`);
  const card = page.locator('[data-testid=board] [data-card]').first();
  const cardBox = (await card.boundingBox())!;
  const target = (await page.locator('[data-testid=board] section[data-column]').nth(1).boundingBox())!;
  const board = await frames(page, () => dragSlowly(page, { x: cardBox.x + cardBox.width / 2, y: cardBox.y + 10 }, { x: target.x + target.width / 2, y: target.y + 80 }));
  record('Przeciąganie karty na tablicy (kl./s)', [board.fps], null, `p95 ${board.p95.toFixed(1)} ms, najgorsza ${board.worst.toFixed(0)} ms, zgubione ${board.dropped}/${board.frames}`);

  await timed(page, `location.hash = '#/calendar';`, `!!document.querySelector('[data-testid=calendar] .fc-timegrid-event')`);
  const event = page.locator('[data-testid=calendar] .fc-timegrid-event:not(.tp-virtual)').first();
  const eventBox = (await event.boundingBox())!;
  const calendar = await frames(page, () => dragSlowly(page, { x: eventBox.x + eventBox.width / 2, y: eventBox.y + 4 }, { x: eventBox.x + eventBox.width / 2 + 150, y: eventBox.y + 120 }));
  record('Przeciąganie bloku w kalendarzu (kl./s)', [calendar.fps], null, `p95 ${calendar.p95.toFixed(1)} ms, najgorsza ${calendar.worst.toFixed(0)} ms, zgubione ${calendar.dropped}/${calendar.frames}`);

  const table = results.map((r) => ({
    pomiar: r.name,
    mediana: Math.round(median(r.samples)),
    max: Math.round(max(r.samples)),
    prog: r.limit ?? '',
    ok: r.limit === null ? '' : median(r.samples) < r.limit ? 'tak' : 'NIE',
    uwagi: r.note ?? '',
  }));
  console.table(table);
  const out = fileURLToPath(new URL('../out/', import.meta.url));
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}perf.json`, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
});
