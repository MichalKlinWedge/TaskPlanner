/**
 * Wyszukiwarka i paleta (M17): bez ogonków, prefiksy, ranking, ostatnio używane, podświetlenia.
 */
import { describe, expect, it } from 'vitest';

import { COMMANDS, commandSearchItems } from '../commands.ts';
import { buildSearchIndex, normalizeText, search, taskSearchItem, type SearchItem } from '../search.ts';
import type { ViewTask } from '../views.ts';

const items: SearchItem[] = [
  { id: 't1', kind: 'task', title: 'Kupić karmę dla żółwia', tags: ['zakupy'], listName: 'Dom' },
  { id: 't2', kind: 'task', title: 'Zakupy w Łodzi', listName: 'Wyjazdy' },
  { id: 't3', kind: 'task', title: 'Zadzwonić do hydraulika', tags: ['telefon'], description: 'Cieknie kran w łazience' },
  { id: 't4', kind: 'task', title: 'Raport kwartalny', listName: 'Praca', description: 'zakupy działu', closed: true },
  { id: 't5', kind: 'task', title: 'Telefon do mamy', tags: ['rodzina'] },
  { id: 'l1', kind: 'list', title: 'Zakupy' },
  { id: 'g1', kind: 'tag', title: 'telefon' },
  ...commandSearchItems(0),
];
const index = buildSearchIndex(items);
const ids = (query: string, opts?: Parameters<typeof search>[2]) => search(index, query, opts).map((r) => r.item.id);

describe('normalizacja', () => {
  it('małe litery, bez ogonków, także ł', () => {
    expect(normalizeText('Żółw Łódź ĘĄŚĆŃ')).toBe('zolw lodz eascn');
  });
});

describe('dopasowanie', () => {
  it('bez polskich znaków i wielkości liter', () => {
    expect(ids('zolw')).toEqual(['t1']);
    expect(ids('LODZ')).toEqual(['t2']);
    expect(ids('łazien')).toEqual(['t3']);
  });

  it('każde słowo musi pasować; prefiksy', () => {
    expect(ids('kup zol')).toEqual(['t1']);
    expect(ids('kupic lodz')).toEqual([]);
    // „kup” w środku „Zakupy” (od 3 znaków) — słabsze dopasowanie, ale jest.
    expect(ids('kup lodz')).toEqual(['t2']);
    expect(ids('hydr')).toEqual(['t3']);
  });

  it('ranking: tytuł > tagi > lista > opis, zamknięte na końcu', () => {
    expect(ids('zakupy')).toEqual(['l1', 't2', 't1', 't4']);
    expect(ids('telefon')).toEqual(['g1', 't5', 't3']);
  });

  it('środek słowa dopiero od 3 znaków i słabiej', () => {
    // Tytuł przed słowem kluczowym akcji („harmonogram”).
    expect(ids('arm')).toEqual(['t1', 'view.timeline']);
    expect(ids('ar')).toEqual([]);
  });
});

describe('paleta', () => {
  it('słowa kluczowe akcji i rodzaje', () => {
    expect(ids('dark')).toEqual(['app.theme']);
    expect(ids('gantt')).toEqual(['view.timeline']);
    expect(ids('przeglad', { kinds: ['action'] })).toEqual(['review.daily', 'review.weekly']);
    expect(ids('dzis', { kinds: ['view'] })).toEqual(['view.today']);
  });

  it('polecenia na zadaniach tylko z zaznaczeniem', () => {
    expect(commandSearchItems(0).map((i) => i.id)).not.toContain('task.complete');
    expect(commandSearchItems(2).map((i) => i.id)).toContain('task.complete');
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });
});

describe('ostatnio używane', () => {
  const recent = new Map([
    ['t5', '2026-11-18T10:00:00Z'],
    ['t3', '2026-11-18T12:00:00Z'],
  ]);

  it('puste zapytanie = ostatnio używane, od najświeższego', () => {
    expect(ids('', { recent })).toEqual(['t3', 't5']);
    expect(ids('')).toEqual([]);
  });

  it('premia nie przebija wyraźnie lepszego dopasowania, ale rozstrzyga bliskie', () => {
    // t5 i tag „telefon” pasują tak samo — rozstrzyga użycie; t3 (tylko tag) zostaje za nimi.
    expect(ids('telefon', { recent })).toEqual(['t5', 'g1', 't3']);
    // Oba mają słowo „do” w tytule; dalej słabsze (lista „Dom”, akcja „dodaj”).
    expect(ids('do', { recent }).slice(0, 2)).toEqual(['t3', 't5']);
    expect(ids('do').slice(0, 2)).toEqual(['t5', 't3']);
  });
});

describe('podświetlenia i zadania', () => {
  it('zakresy w oryginalnym tytule', () => {
    const [result] = search(index, 'zolw kup');
    expect(result!.highlights).toEqual([
      [0, 3],
      [16, 20],
    ]);
    expect(result!.item.title.slice(16, 20)).toBe('żółw');
  });

  it('zadanie jako pozycja', () => {
    const task = { id: 'x', title: 'Zrób coś', status: 'done' } as ViewTask;
    expect(taskSearchItem(task, { listName: 'Dom', tagNames: ['a'], description: null })).toEqual({
      id: 'x',
      kind: 'task',
      title: 'Zrób coś',
      listName: 'Dom',
      tags: ['a'],
      description: undefined,
      closed: true,
    });
  });

  it('wydajność: 5 000 pozycji, zapytanie < 15 ms', () => {
    const many = buildSearchIndex(Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, kind: 'task' as const, title: `Zadanie numer ${i} dotyczące spraw różnych`, description: 'opis '.repeat(20) })));
    search(many, 'zad spr');
    const start = performance.now();
    search(many, 'zadanie roz');
    expect(performance.now() - start).toBeLessThan(15);
  });
});
