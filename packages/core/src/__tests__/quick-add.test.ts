/**
 * PoC-2: korpus `fixtures/quick-add.jsonl` (kryterium: ≥ 95 % w całości, 0 błędów w pułapkach,
 * < 5 ms na wpis). Teraz = środa 18.11.2026, 12:00 (`fixtures/quick-add.context.json`).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseQuickAdd, suppressToken, type QuickAddContext, type QuickAddResult } from '../quick-add.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../../fixtures/${name}`, import.meta.url), 'utf8');

interface Case {
  input: string;
  expect: Record<string, unknown> & { title: string };
  note?: string;
}

const raw = JSON.parse(fixture('quick-add.context.json'));
const ctx: QuickAddContext = {
  now: raw.now,
  currentWorkspace: raw.currentWorkspace,
  workspaces: raw.workspaces,
  lists: raw.lists,
  tags: raw.tags,
};
const cases: Case[] = fixture('quick-add.jsonl')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

/** Wynik w kształcie oczekiwań korpusu (lista/przestrzeń bez nazwy przestrzeni, cykl bez kotwicy). */
function comparable(result: QuickAddResult) {
  const { target, recurrence, ...rest } = result.fields;
  return {
    title: result.title,
    ...rest,
    ...(target && { target: { kind: target.kind, name: target.name } }),
    ...(recurrence && (recurrence.mode === 'schedule' ? { recurrence: { mode: recurrence.mode, rrule: recurrence.rrule } } : { recurrence })),
  };
}

const isTrap = (c: Case) => c.note?.startsWith('pułapka') ?? false;

describe('PoC-2: szybkie dodawanie — korpus', () => {
  it.each(cases.map((c) => [c.input, c] as const))('%s', (_input, c) => {
    expect(comparable(parseQuickAdd(c.input, ctx))).toEqual(c.expect);
  });

  it('kryteria PoC-2', () => {
    const failed = cases.filter((c) => JSON.stringify(comparable(parseQuickAdd(c.input, ctx))) !== JSON.stringify(c.expect));
    const sorted = (value: unknown): unknown =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
        : value;
    const reallyFailed = failed.filter((c) => JSON.stringify(sorted(comparable(parseQuickAdd(c.input, ctx)))) !== JSON.stringify(sorted(c.expect)));
    const passRate = 1 - reallyFailed.length / cases.length;
    expect(passRate).toBeGreaterThanOrEqual(0.95);
    expect(reallyFailed.filter(isTrap)).toEqual([]);

    const start = performance.now();
    const rounds = 20;
    for (let r = 0; r < rounds; r++) for (const c of cases) parseQuickAdd(c.input, ctx);
    const perEntry = (performance.now() - start) / (rounds * cases.length);
    console.log(`korpus: ${cases.length} przypadków, zgodnych ${(passRate * 100).toFixed(1)} %, ${perEntry.toFixed(3)} ms na wpis`);
    expect(perEntry).toBeLessThan(5);
  });
});

describe('szybkie dodawanie — zakresy znaków do podświetlania', () => {
  it('przykład ze specyfikacji', () => {
    const text = 'Zapłacić rachunek za prąd jutro o 10:00 #dom !wysoki';
    const { tokens } = parseQuickAdd(text, ctx);
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ['date', 'jutro'],
      ['time', 'o 10:00'],
      ['target', '#dom'],
      ['priority', '!wysoki'],
    ]);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it('cofnięcie rozpoznania wraca fragment do tytułu, reszta zostaje', () => {
    const text = 'Spotkanie o projekcie jutro o 10:00 !2';
    const time = parseQuickAdd(text, ctx).tokens.find((t) => t.kind === 'time')!;
    const result = parseQuickAdd(suppressToken(text, time), ctx);
    expect(result.title).toBe('Spotkanie o projekcie o 10:00');
    expect(result.fields).toEqual({ dueDate: '2026-11-19', priority: 2 });
  });
});
