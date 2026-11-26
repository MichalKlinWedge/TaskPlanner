/**
 * PoC-2: korpus `fixtures/quick-add.jsonl` (kryterium: ≥ 95 % w całości, 0 błędów w pułapkach,
 * < 5 ms na wpis). Teraz = środa 18.11.2026, 12:00 (`fixtures/quick-add.context.json`).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { quickAddChip } from '../format.ts';
import { parseQuickAdd, quickAddWhenContext, quickAddWhenInitial, suppressToken, type QuickAddContext, type QuickAddResult, type QuickAddSlot, type QuickAddWhen } from '../quick-add.ts';

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

describe('kliknięte miejsce kalendarza (slot)', () => {
  // Piątek 27.11.2026, 10:00; „teraz” = środa 18.11.2026, 12:00.
  const slot: QuickAddSlot = { date: '2026-11-27', time: '10:00' };
  const fields = (text: string, s: QuickAddSlot = slot) => parseQuickAdd(text, { ...ctx, slot: s }).fields;

  it('sam tytuł — dzień i godzina z kliknięcia', () => {
    expect(fields('Dentysta')).toEqual({ dueDate: '2026-11-27', dueTime: '10:00' });
    expect(fields('Dentysta', { date: slot.date })).toEqual({ dueDate: '2026-11-27' });
    expect(parseQuickAdd('Dentysta', { ...ctx, slot }).tokens).toEqual([]);
  });

  it('wpis wygrywa, każde pole osobno', () => {
    expect(fields('Dentysta o 14')).toEqual({ dueDate: '2026-11-27', dueTime: '14:00' });
    expect(fields('Dentysta o 14', { date: slot.date })).toEqual({ dueDate: '2026-11-27', dueTime: '14:00' });
    expect(fields('Dentysta jutro')).toEqual({ dueDate: '2026-11-19', dueTime: '10:00' });
    expect(fields('Dentysta jutro o 8')).toEqual({ dueDate: '2026-11-19', dueTime: '08:00' });
  });

  it('miejsce w przeszłości zostaje', () => {
    expect(fields('Dentysta', { date: '2026-11-16', time: '09:00' })).toEqual({ dueDate: '2026-11-16', dueTime: '09:00' });
  });

  it('cykl liczony od klikniętego dnia', () => {
    expect(fields('Podlać co tydzień')).toMatchObject({ dueDate: '2026-11-27', dueTime: '10:00', recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=FR', anchor: '2026-11-27' } });
    expect(fields('Podlać co poniedziałek')).toMatchObject({ dueDate: '2026-11-30', dueTime: '10:00', recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor: '2026-11-30' } });
    // Dziś o godzinie, która już minęła: kliknięcie jest wprost, więc seria zaczyna się tego dnia.
    expect(fields('Podlać codziennie', { date: '2026-11-18', time: '09:00' })).toMatchObject({ dueDate: '2026-11-18', dueTime: '09:00' });
  });
});

describe('pola „Termin” i „Godzina” okna (fixed)', () => {
  // „Teraz” = środa 18.11.2026, 12:00.
  const parse = (text: string, fixed: QuickAddContext['fixed'], extra: Partial<QuickAddContext> = {}) => parseQuickAdd(text, { ...ctx, ...extra, fixed });

  it('pole wygrywa z wpisem, fragment i tak znika z tytułu', () => {
    const result = parse('Dentysta jutro o 8', { date: '2026-11-27', time: '15:30' });
    expect(result.title).toBe('Dentysta');
    expect(result.fields).toEqual({ dueDate: '2026-11-27', dueTime: '15:30' });
    expect(result.tokens.map((t) => [t.kind, t.overridden])).toEqual([
      ['date', true],
      ['time', true],
    ]);
    expect(quickAddChip(result.tokens[0]!, result, '2026-11-18')).toBe('Termin: jutro — wygrywa pole');
  });

  it('każde pole osobno', () => {
    expect(parse('Dentysta jutro o 8', { date: '2026-11-27' }).fields).toEqual({ dueDate: '2026-11-27', dueTime: '08:00' });
    const onlyTime = parse('Dentysta jutro o 8', { time: '15:30' });
    expect(onlyTime.fields).toEqual({ dueDate: '2026-11-19', dueTime: '15:30' });
    expect(onlyTime.tokens.find((t) => t.kind === 'date')?.overridden).toBeUndefined();
    // Sama godzina z pola: dziś, jeśli jeszcze nie minęła, inaczej jutro — jak „o 10” we wpisie.
    expect(parse('Dentysta', { time: '10:00' }).fields).toEqual({ dueDate: '2026-11-19', dueTime: '10:00' });
  });

  it('pole wygrywa też z klikniętym miejscem kalendarza', () => {
    expect(parse('Dentysta', { date: '2026-12-01' }, { slot: { date: '2026-11-27', time: '10:00' } }).fields).toEqual({ dueDate: '2026-12-01', dueTime: '10:00' });
  });

  it('cykl i przypomnienie liczą się od daty z pola', () => {
    expect(parse('Podlać co tydzień', { date: '2026-11-24' }).fields).toMatchObject({ dueDate: '2026-11-24', recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=TU', anchor: '2026-11-24' } });
    expect(parse('Zadzwonić przypomnij o 9', { date: '2026-11-24' }).fields.reminders).toEqual([{ kind: 'absolute', atDate: '2026-11-24', atTime: '09:00' }]);
  });
});

describe('quickAddWhenContext', () => {
  const slot: QuickAddSlot = { date: '2026-11-27', time: '10:00' };
  const when = (patch: Partial<QuickAddWhen>, defaults: Parameters<typeof quickAddWhenInitial>[0] = { slot }): QuickAddWhen => ({ ...quickAddWhenInitial(defaults), ...patch });

  it('pola na start = domyślne widoku', () => {
    expect(quickAddWhenInitial({ slot })).toEqual({ date: '2026-11-27', time: '10:00', dateSet: false, timeSet: false });
    expect(quickAddWhenInitial({ dueDate: '2026-11-18' })).toEqual({ date: '2026-11-18', time: null, dateSet: false, timeSet: false });
    expect(quickAddWhenInitial({})).toEqual({ date: null, time: null, dateSet: false, timeSet: false });
  });

  it('nietknięte pola — jak dotąd (wpis wygrywa)', () => {
    expect(quickAddWhenContext(when({}), { slot })).toEqual({ slot, defaultDueDate: null });
    expect(quickAddWhenContext(when({}, { dueDate: '2026-11-18' }), { dueDate: '2026-11-18' })).toEqual({ defaultDueDate: '2026-11-18' });
  });

  it('ustawione pole wygrywa, druga pokazana wartość działa jak kliknięte miejsce', () => {
    expect(quickAddWhenContext(when({ date: '2026-12-01', dateSet: true }), { slot })).toEqual({ slot: { date: '2026-12-01', time: '10:00' }, fixed: { date: '2026-12-01' }, defaultDueDate: null });
    expect(quickAddWhenContext(when({ time: '15:00', timeSet: true }), { slot })).toEqual({ slot: { date: '2026-11-27' }, fixed: { time: '15:00' }, defaultDueDate: null });
    // Termin z „Dziś” nietknięty, godzina ustawiona: ten dzień o tej godzinie (wpis z datą wygrywa).
    const fromToday = quickAddWhenContext({ date: '2026-11-18', time: '15:00', dateSet: false, timeSet: true }, { dueDate: '2026-11-18' });
    expect(fromToday).toEqual({ slot: { date: '2026-11-18' }, fixed: { time: '15:00' }, defaultDueDate: null });
    expect(parseQuickAdd('Dentysta', { ...ctx, ...fromToday }).fields).toEqual({ dueDate: '2026-11-18', dueTime: '15:00' });
    expect(parseQuickAdd('Dentysta pojutrze', { ...ctx, ...fromToday }).fields).toEqual({ dueDate: '2026-11-20', dueTime: '15:00' });
  });

  it('wyczyszczone pola — bez domyślnych, decyduje wpis', () => {
    const cleared = quickAddWhenContext({ date: null, time: null, dateSet: true, timeSet: true }, { slot, dueDate: '2026-11-18' });
    expect(cleared).toEqual({ defaultDueDate: null });
    expect(parseQuickAdd('Dentysta', { ...ctx, ...cleared }).fields).toEqual({});
    expect(parseQuickAdd('Dentysta jutro', { ...ctx, ...cleared }).fields).toEqual({ dueDate: '2026-11-19' });
  });
});
