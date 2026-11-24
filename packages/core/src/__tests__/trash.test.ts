import { describe, expect, it } from 'vitest';

import { toTrashedTask, trashedWith, trashListLabel, trashPreview, trashRoots, trashSince, type TrashedTask } from '../trash.ts';

const AT = '2026-11-20T10:00:00.000Z';
/** Ten sam moment w zapisie serwera (po synchronizacji). */
const AT_SERVER = '2026-11-20T10:00:00+00:00';
const EARLIER = '2026-11-18T08:00:00.000Z';

const row = (id: string, parentId: string | null, deletedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  scope_id: 'w1',
  list_id: 'l1',
  parent_id: parentId,
  kind: 'task',
  title: id.toUpperCase(),
  status: 'todo',
  priority: 4,
  start_date: null,
  due_date: null,
  due_time: null,
  duration_min: null,
  recurrence: null,
  habit: null,
  completed_at: null,
  created_at: AT,
  sort_key: id,
  postpone_count: 0,
  deleted_at: deletedAt,
  list_name: 'Zakupy',
  list_archived_at: null,
  list_deleted_at: null,
  tag_ids: null,
  ...extra,
});
const task = (...args: Parameters<typeof row>): TrashedTask => toTrashedTask(row(...args));

/** a → (c, b → d); „e” usunięte wcześniej z podzadaniem „f”; „g” = podzadanie żywego „z”. */
const trashed = [
  task('a', null, AT),
  task('c', 'a', AT),
  task('b', 'a', AT_SERVER),
  task('d', 'b', AT),
  task('e', 'a', EARLIER),
  task('f', 'e', EARLIER),
  task('g', 'z', AT),
];
const alive = new Set(['z']);
const back = (id: string, patch: Record<string, unknown> = {}) => ({ table: 'tasks', id, patch: { deleted_at: null, ...patch } });

describe('kosz', () => {
  it('wiersz z bazy: pola zadania, tagi w kolejności, stan listy', () => {
    expect(task('a', null, AT, { tag_ids: 't2,t1', due_date: '2026-11-25', priority: 2 })).toMatchObject({
      title: 'A',
      dueDate: '2026-11-25',
      priority: 2,
      tagIds: ['t2', 't1'],
      deletedAt: AT,
      listName: 'Zakupy',
      listState: 'active',
    });
    expect(task('a', null, AT, { list_archived_at: AT }).listState).toBe('archived');
    expect(task('a', null, AT, { list_archived_at: AT, list_deleted_at: AT }).listState).toBe('deleted');
    expect(task('a', null, AT, { list_name: null })).toMatchObject({ listName: null, listState: 'missing', tagIds: [] });
  });

  it('podpis listy: z widoków, zarchiwizowana, usunięta, nieznana', () => {
    expect(trashListLabel(task('a', null, AT), 'Inbox (Dom)')).toBe('Inbox (Dom)');
    expect(trashListLabel(task('a', null, AT))).toBe('Zakupy');
    expect(trashListLabel(task('a', null, AT, { list_archived_at: AT }))).toBe('Zakupy (zarchiwizowana)');
    expect(trashListLabel(task('a', null, AT, { list_deleted_at: AT }))).toBe('Zakupy (lista usunięta)');
    expect(trashListLabel(task('a', null, AT, { list_name: null }))).toBe('lista niedostępna');
  });

  it('pozycje kosza: usunięte razem są pod rodzicem, usunięte wcześniej osobno', () => {
    expect(trashRoots(trashed).map((t) => t.id)).toEqual(['a', 'e', 'g']);
    expect(trashedWith(trashed, 'a').map((t) => t.id)).toEqual(['c', 'b', 'd']);
    expect(trashedWith(trashed, 'e').map((t) => t.id)).toEqual(['f']);
    expect(trashedWith(trashed, 'brak')).toEqual([]);
  });

  it('podgląd głównego: podzadania w kolejności ręcznej, przywrócenie całej grupy', () => {
    const p = trashPreview(trashed, 'a', alive)!;
    expect([p.root.id, p.parent, p.children.map((t) => t.id), p.count]).toEqual(['a', null, ['b', 'c'], 3]);
    expect(p.restore).toEqual([back('a'), back('c'), back('b'), back('d')]);
    expect(p.restoreAlone).toBeNull();
  });

  it('podgląd podzadania: z grupą albo samo (jako zadanie główne, ze swoimi podzadaniami)', () => {
    const b = trashPreview(trashed, 'b', alive)!;
    expect([b.root.id, b.parent?.id, b.children.map((t) => t.id)]).toEqual(['a', 'a', ['d']]);
    expect(b.restore).toEqual(trashPreview(trashed, 'a', alive)!.restore);
    expect(b.restoreAlone).toEqual([back('b', { parent_id: null }), back('d')]);
    expect(trashPreview(trashed, 'd', alive)).toMatchObject({ root: { id: 'a' }, parent: { id: 'b' }, children: [] });
  });

  it('usunięte osobno: rodzic żywy — wraca pod niego, rodzic w koszu — jako główne', () => {
    expect(trashPreview(trashed, 'g', alive)).toMatchObject({ root: { id: 'g' }, parent: null, restore: [back('g')] });
    expect(trashPreview(trashed, 'e', alive)!.restore).toEqual([back('e', { parent_id: null }), back('f')]);
  });

  it('brak danych: zadania albo rodzica nie ma na urządzeniu', () => {
    expect(trashPreview(trashed, 'brak', alive)).toBeNull();
    expect(trashPreview([task('x', 'nieznany', AT)], 'x', alive)).toMatchObject({ root: { id: 'x' }, parent: null, restoreAlone: null, restore: [back('x', { parent_id: null })] });
  });

  it('pętla rodziców w uszkodzonych danych nie zawiesza podglądu', () => {
    expect(trashPreview([task('x', 'y', AT), task('y', 'x', AT)], 'x', alive)?.task.id).toBe('x');
  });

  it('granica kosza: 30 dni', () => {
    expect(trashSince(new Date('2026-11-30T12:00:00Z'))).toBe('2026-10-31T12:00:00.000Z');
  });
});
