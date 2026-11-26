import { describe, expect, it } from 'vitest';

import { ADHOC_FILTERS_MAX, keepShownSelection, parseAdhocFilters, withAdhocFilter } from '../view-memory.ts';

const TAG = '0192f0a0-0000-7000-8000-000000000001';

describe('filtry doraźne per widok (R-06)', () => {
  it('zapisuje, zastępuje i usuwa pusty filtr', () => {
    let map = withAdhocFilter({}, '#/inbox', { priorities: [1] });
    map = withAdhocFilter(map, '#/today', { hasTime: true });
    map = withAdhocFilter(map, '#/inbox', { priorities: [2] });
    expect(map).toEqual({ '#/today': { hasTime: true }, '#/inbox': { priorities: [2] } });
    expect(Object.keys(map)).toEqual(['#/today', '#/inbox']);
    expect(withAdhocFilter(map, '#/today', {})).toEqual({ '#/inbox': { priorities: [2] } });
  });

  it('pamięta najwyżej ADHOC_FILTERS_MAX widoków, najdawniej zmienione wypadają', () => {
    let map = {};
    for (let i = 0; i <= ADHOC_FILTERS_MAX; i += 1) map = withAdhocFilter(map, `k${i}`, { hasTime: true });
    expect(Object.keys(map)).toHaveLength(ADHOC_FILTERS_MAX);
    expect(map).not.toHaveProperty('k0');
    expect(map).toHaveProperty(`k${ADHOC_FILTERS_MAX}`);
  });

  it('odczyt pomija złe wpisy i zły JSON', () => {
    const raw = JSON.stringify({ a: { tags: { ids: [TAG], match: 'any' } }, b: { priorities: [] }, c: 'x', d: {} });
    expect(parseAdhocFilters(raw)).toEqual({ a: { tags: { ids: [TAG], match: 'any' } } });
    expect(parseAdhocFilters('{')).toEqual({});
    expect(parseAdhocFilters('[1]')).toEqual({});
    expect(parseAdhocFilters(null)).toEqual({});
  });
});

describe('zaznaczenie po zmianie danych (R-12)', () => {
  it('wypadają tylko zadania, które zniknęły z widoku', () => {
    const selected = ['a', 'b', 'c'];
    expect(keepShownSelection(selected, new Set(['a', 'b']), new Set(['a']))).toEqual(['a', 'c']);
  });

  it('bez zmian zwraca tę samą tablicę', () => {
    const selected = ['a', 'b'];
    expect(keepShownSelection(selected, new Set(['a', 'b']), new Set(['a', 'b', 'x']))).toBe(selected);
  });
});
