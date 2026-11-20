/**
 * Kanban (M10): kolumny według kryterium, kolejność z `board_sort_key` i automatyczna, przeciągnięcie
 * zmienia atrybut kolumny i miejsce, z cofnięciem.
 */
import { describe, expect, it } from 'vitest';

import { taskTagId } from '../ids.ts';
import { boardColumns, boardDropOps, boardOrder } from '../kanban.ts';
import { toViewTask, type LocalTaskRow } from '../tasks.ts';
import type { ViewTask } from '../views.ts';

const row: LocalTaskRow = {
  id: 'x',
  scope_id: 'w',
  list_id: 'L1',
  parent_id: null,
  kind: 'task',
  title: 'x',
  status: 'todo',
  priority: 4,
  start_date: null,
  due_date: null,
  due_time: null,
  duration_min: null,
  recurrence: null,
  habit: null,
  completed_at: null,
  created_at: '2026-11-01T10:00:00Z',
  sort_key: 'm',
  postpone_count: 0,
};
const t = (id: string, over: Partial<ViewTask> = {}): ViewTask => ({ ...toViewTask({ ...row, id, title: id }), ...over });
const ctx = { today: '2026-11-19' as const, now: '2026-11-19T11:00:00Z', timeZone: 'Europe/Warsaw' };

const tasks = [
  t('a', { priority: 2, dueDate: '2026-11-20', tagIds: ['g1'] }),
  t('b', { priority: 1, status: 'in_progress', dueDate: '2026-11-16', tagIds: ['g1', 'g2'] }),
  t('c', { status: 'done', completedAt: '2026-11-18T10:00:00Z', listId: 'L2' }),
  t('old', { status: 'done', completedAt: '2026-11-01T10:00:00Z' }),
  t('sub', { parentId: 'a' }),
  t('k1', { boardSortKey: 'b', priority: 4 }),
  t('k0', { boardSortKey: 'a', priority: 4 }),
  t('x', { status: 'cancelled' }),
];

describe('kolumny', () => {
  it('status: bez anulowanych i podzadań, „Gotowe” z ostatnich 7 dni; klucze tablicy przed automatyczną kolejnością', () => {
    const cols = boardColumns(tasks, 'status', ctx);
    expect(cols.map((c) => [c.key, c.tasks.map((x) => x.id)])).toEqual([
      ['todo', ['k0', 'k1', 'a']],
      ['in_progress', ['b']],
      ['waiting', []],
      ['done', ['c']],
    ]);
    expect(cols.every((c) => c.hint)).toBe(true);
    expect(boardColumns(tasks, 'priority', ctx).some((c) => c.hint)).toBe(false);
  });

  it('dzień tygodnia: bieżący tydzień od poniedziałku + bez terminu; tylko otwarte', () => {
    const cols = boardColumns(tasks, 'weekday', ctx);
    expect(cols.map((c) => c.key)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', 'none']);
    expect(cols[0]!.tasks.map((x) => x.id)).toEqual(['b']);
    expect(cols[3]!.label).toContain('dziś');
    expect(cols.at(-1)!.tasks.map((x) => x.id)).toEqual(['k0', 'k1']);
  });

  it('tag: zadanie z kilkoma tagami w każdej kolumnie; lista i priorytet', () => {
    const tags = [
      { id: 'g2', name: 'dom', sortKey: 'b' },
      { id: 'g1', name: 'telefon', sortKey: 'a' },
    ];
    expect(boardColumns(tasks, 'tag', ctx, { tags }).map((c) => [c.key, c.tasks.map((x) => x.id)])).toEqual([
      ['g1', ['b', 'a']],
      ['g2', ['b']],
      ['none', ['k0', 'k1']],
    ]);
    expect(boardColumns(tasks, 'priority', ctx).map((c) => c.tasks.length)).toEqual([1, 1, 0, 2]);
    expect(boardColumns(tasks, 'list', ctx, { lists: [{ id: 'L1', name: 'Dom', sortKey: 'a' }] }).map((c) => c.key)).toEqual(['L1']);
  });

  it('kolejność automatyczna: priorytet, potem termin', () => {
    const sorted = [t('p4'), t('p1late', { priority: 1, dueDate: '2026-12-01' }), t('p1soon', { priority: 1, dueDate: '2026-11-20' })].sort(boardOrder);
    expect(sorted.map((x) => x.id)).toEqual(['p1soon', 'p1late', 'p4']);
  });
});

describe('przeciągnięcie karty', () => {
  const todo = boardColumns(tasks, 'status', ctx)[0]!.tasks; // k0 (a), k1 (b), a (bez klucza)

  it('zmiana statusu i miejsce między kartami z kluczem — jedna operacja', () => {
    const b = tasks[1]!;
    const { ops, undo } = boardDropOps(b, tasks, 'status', 'in_progress', 'todo', todo, 1, ctx);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.patch).toMatchObject({ status: 'todo' });
    const key = ops[0]!.patch.board_sort_key as string;
    expect(key > 'a' && key < 'b').toBe(true);
    expect(undo).toEqual([{ table: 'tasks', id: 'b', patch: { status: 'in_progress', board_sort_key: null } }]);
  });

  it('upuszczenie za kartą bez klucza nadaje jej klucz (zostaje przed)', () => {
    const b = tasks[1]!;
    const { ops } = boardDropOps(b, tasks, 'status', 'in_progress', 'todo', todo, 3, ctx);
    expect(ops.map((o) => o.id)).toEqual(['a', 'b']);
    expect((ops[1]!.patch.board_sort_key as string) > (ops[0]!.patch.board_sort_key as string)).toBe(true);
  });

  it('do „Gotowe” — ukończenie jak przy odhaczeniu; z „Gotowe” — ponowne otwarcie', () => {
    const done = boardDropOps(tasks[0]!, tasks, 'status', 'todo', 'done', [], 0, ctx);
    expect(done.ops[0]).toMatchObject({ table: 'tasks', id: 'a', patch: { status: 'done' } });
    const back = boardDropOps(tasks[2]!, tasks, 'status', 'done', 'waiting', [], 0, ctx);
    expect(back.ops.at(-1)!.patch).toMatchObject({ status: 'waiting', completed_at: null });
  });

  it('dzień tygodnia: termin (licznik przesunięć przy przesunięciu na później); tag: zamiana tagu; lista: przeniesienie', () => {
    const day = boardDropOps(tasks[0]!, tasks, 'weekday', '2026-11-20', '2026-11-21', [], 0, ctx);
    expect(day.ops.at(-1)!.patch).toMatchObject({ due_date: '2026-11-21', postpone_count: 1 });
    const none = boardDropOps(tasks[0]!, tasks, 'weekday', '2026-11-20', 'none', [], 0, ctx);
    expect(none.ops.at(-1)!.patch).toMatchObject({ due_date: null });
    const tag = boardDropOps(tasks[0]!, tasks, 'tag', 'g1', 'g2', [], 0, ctx);
    expect(tag.ops.slice(0, 2)).toEqual([
      { table: 'task_tags', id: taskTagId('a', 'g1'), patch: { deleted_at: '2026-11-19T11:00:00.000Z' } },
      { table: 'task_tags', id: taskTagId('a', 'g2'), patch: { task_id: 'a', tag_id: 'g2', deleted_at: null } },
    ]);
    const list = boardDropOps(tasks[0]!, tasks, 'list', 'L1', 'L2', [], 0, ctx);
    expect(list.ops.map((o) => [o.id, o.patch.list_id])).toEqual([
      ['a', 'L2'],
      ['sub', 'L2'],
      ['a', undefined],
    ]);
  });
});
