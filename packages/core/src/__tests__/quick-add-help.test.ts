/** Ściąga szybkiego dodawania: każdy przykład parser rozpoznaje jako fragment podanego rodzaju. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { datePresets } from '../format.ts';
import { QUICK_ADD_HELP } from '../quick-add-help.ts';
import { parseQuickAdd, type QuickAddContext } from '../quick-add.ts';

const raw = JSON.parse(readFileSync(new URL('../../../../fixtures/quick-add.context.json', import.meta.url), 'utf8'));
const ctx: QuickAddContext = { now: raw.now, currentWorkspace: raw.currentWorkspace, workspaces: raw.workspaces, lists: raw.lists, tags: raw.tags };

describe('ściąga składni szybkiego dodawania', () => {
  const cases = QUICK_ADD_HELP.flatMap((row) => row.examples.map((example) => [row.kind, example] as const));
  it.each(cases)('%s: %s', (kind, example) => {
    const text = `Zadanie ${example}`;
    const { title, tokens } = parseQuickAdd(text, ctx);
    expect(title).toBe('Zadanie');
    expect(tokens.map((t) => t.kind)).toContain(kind);
    // Cały przykład zjada rozpoznanie (bez reszty w tytule i bez innego rodzaju).
    expect(tokens.every((t) => t.kind === kind || (kind === 'time' && t.kind === 'duration'))).toBe(true);
  });
  it('każdy rodzaj fragmentu ma wiersz', () => {
    expect(new Set(QUICK_ADD_HELP.map((r) => r.kind)).size).toBe(8);
  });
});

describe('gotowe dni wyboru terminu', () => {
  it('środa: pon. w przyszłym tygodniu', () => {
    expect(datePresets('2026-11-18')).toEqual([
      { label: 'Dziś', date: '2026-11-18' },
      { label: 'Jutro', date: '2026-11-19' },
      { label: 'Pojutrze', date: '2026-11-20' },
      { label: 'Pon. 23.11', date: '2026-11-23' },
      { label: 'Za tydzień', date: '2026-11-25' },
    ]);
  });
  it('poniedziałek: następny poniedziałek, nie dziś', () => {
    expect(datePresets('2026-11-23')[3]).toEqual({ label: 'Pon. 30.11', date: '2026-11-30' });
  });
  it('niedziela: poniedziałek = jutro; przełom roku', () => {
    expect(datePresets('2026-12-27')[3]).toEqual({ label: 'Pon. 28.12', date: '2026-12-28' });
    expect(datePresets('2026-12-31').map((p) => p.date)).toEqual(['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-04', '2027-01-07']);
  });
});
