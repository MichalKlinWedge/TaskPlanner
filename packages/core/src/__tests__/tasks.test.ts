/**
 * Wiersz lokalnej bazy → `ViewTask`; ukończenie zwykłego zadania, serii i nawyku z cofnięciem.
 */
import { describe, expect, it } from 'vitest';

import { completionId, tagId, taskTagId } from '../ids.ts';
import { parseQuickAdd } from '../quick-add.ts';
import {
  bulkTaskOps,
  canAddSubtask,
  completeTaskOps,
  datesPatch,
  deleteTaskOps,
  descendants,
  dropTaskOps,
  endSeriesOps,
  moveTaskOps,
  openDescendants,
  quickAddTaskOps,
  reopenTaskPatch,
  restoreTaskOps,
  skipOccurrenceOps,
  taskDepth,
  toViewTask,
  type LocalTaskRow,
  type QuickAddScope,
} from '../tasks.ts';

const ID = '0190a000-0000-7000-8000-000000000001';

const row: LocalTaskRow = {
  id: ID,
  scope_id: 'w1',
  list_id: 'l1',
  parent_id: null,
  kind: 'task',
  title: 'Podlać kwiaty',
  status: 'todo',
  priority: 3,
  start_date: null,
  due_date: '2026-11-18',
  due_time: null,
  duration_min: null,
  recurrence: null,
  habit: null,
  completed_at: null,
  created_at: '2026-11-01T10:00:00Z',
  sort_key: 'a0',
  postpone_count: 2,
  field_clock: JSON.stringify({ status: '001763460000000:00000:dev1' }),
};

const NOW = '2026-11-19T11:00:00Z';

describe('toViewTask', () => {
  it('kolumny i JSON z tekstu', () => {
    const task = toViewTask({ ...row, recurrence: '{"mode":"after_completion","every":{"unit":"day","n":3}}' }, ['t1']);
    expect(task).toMatchObject({ id: ID, workspaceId: 'w1', listId: 'l1', dueDate: '2026-11-18', priority: 3, tagIds: ['t1'], postponeCount: 2 });
    expect(task.recurrence).toEqual({ mode: 'after_completion', every: { unit: 'day', n: 3 } });
    expect(task.statusChangedAt).toBe(new Date(1763460000000).toISOString());
  });

  it('zła reguła i brak created_at nie psują widoku', () => {
    const task = toViewTask({ ...row, recurrence: '{"mode":"co-tydzień"}', habit: 'nie-json', created_at: null, field_clock: null });
    expect(task.recurrence).toBeNull();
    expect(task.habit).toBeNull();
    expect(task.createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(task.statusChangedAt).toBeNull();
  });
});

describe('completeTaskOps', () => {
  it('zwykłe zadanie: done i cofnięcie', () => {
    const { ops, undo, nextDue } = completeTaskOps(toViewTask(row), { now: NOW });
    expect(ops).toEqual([{ table: 'tasks', id: ID, patch: { status: 'done', completed_at: '2026-11-19T11:00:00.000Z' } }]);
    expect(undo).toEqual([{ table: 'tasks', id: ID, patch: { status: 'todo', completed_at: null } }]);
    expect(nextDue).toBeNull();
  });

  it('seria według harmonogramu po terminie: wpis wykonania, termin po dziś, zakres przesunięty', () => {
    const task = toViewTask({ ...row, start_date: '2026-11-16', recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=WE', anchor: '2026-11-04' } });
    const { ops, undo, nextDue } = completeTaskOps(task, { now: NOW, timeZone: 'Europe/Warsaw' });
    expect(nextDue).toBe('2026-11-25');
    expect(ops).toEqual([
      {
        table: 'task_completions',
        id: completionId(ID, '2026-11-18'),
        patch: { task_id: ID, occurrence_date: '2026-11-18', kind: 'done', value: null, completed_at: '2026-11-19T11:00:00.000Z', deleted_at: null },
      },
      { table: 'tasks', id: ID, patch: { due_date: '2026-11-25', start_date: '2026-11-23', postpone_count: 0 } },
    ]);
    expect(undo).toEqual([
      { table: 'task_completions', id: completionId(ID, '2026-11-18'), patch: { deleted_at: '2026-11-19T11:00:00.000Z' } },
      { table: 'tasks', id: ID, patch: { due_date: '2026-11-18', start_date: '2026-11-16', postpone_count: 2 } },
    ]);
  });

  it('po ukończeniu: od dnia ukończenia; ostatnie wystąpienie zamyka serię', () => {
    const after = toViewTask({ ...row, recurrence: { mode: 'after_completion', every: { unit: 'day', n: 3 } } });
    expect(completeTaskOps(after, { now: NOW }).nextDue).toBe('2026-11-22');
    const last = toViewTask({ ...row, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;COUNT=3', anchor: '2026-11-16' } });
    const { ops, nextDue } = completeTaskOps(last, { now: NOW });
    expect(nextDue).toBeNull();
    expect(ops.map((o) => o.table)).toEqual(['task_completions', 'tasks']);
    expect(ops[1]!.patch).toEqual({ status: 'done', completed_at: '2026-11-19T11:00:00.000Z' });
  });

  it('dzień ukończenia w strefie użytkownika; nawyk = wpis na dziś', () => {
    const habit = toViewTask({ ...row, kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } });
    // 23:30 UTC 19.11 = 00:30 20.11 w Warszawie.
    const { ops } = completeTaskOps(habit, { now: '2026-11-19T23:30:00Z', timeZone: 'Europe/Warsaw' });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ table: 'task_completions', id: completionId(ID, '2026-11-20'), patch: { occurrence_date: '2026-11-20' } });
  });

  it('ponowne otwarcie', () => {
    expect(reopenTaskPatch()).toEqual({ status: 'todo', completed_at: null });
  });
});

describe('wystąpienia serii (M7)', () => {
  const weekly = toViewTask({ ...row, recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=WE', anchor: '2026-11-04' } });
  const subtasks = [
    { id: 's1', status: 'done' as const, completedAt: '2026-11-18T10:00:00.000Z' },
    { id: 's2', status: 'todo' as const, completedAt: null },
    { id: 's3', status: 'in_progress' as const, completedAt: null },
  ];

  it('ukończenie serii resetuje podzadania i cofa reset', () => {
    const { ops, undo } = completeTaskOps(weekly, { now: NOW, subtasks });
    expect(ops.slice(2)).toEqual([
      { table: 'tasks', id: 's1', patch: { status: 'todo', completed_at: null } },
      { table: 'tasks', id: 's3', patch: { status: 'todo', completed_at: null } },
    ]);
    expect(undo.slice(2)).toEqual([
      { table: 'tasks', id: 's1', patch: { status: 'done', completed_at: '2026-11-18T10:00:00.000Z' } },
      { table: 'tasks', id: 's3', patch: { status: 'in_progress', completed_at: null } },
    ]);
  });

  it('koniec serii nie rusza podzadań', () => {
    const last = toViewTask({ ...row, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;COUNT=3', anchor: '2026-11-16' } });
    expect(completeTaskOps(last, { now: NOW, subtasks }).ops.map((o) => o.id)).toEqual([completionId(ID, '2026-11-18'), ID]);
  });

  it('pominięcie: wpis skipped i następny termin', () => {
    const { ops, nextDue } = skipOccurrenceOps(weekly, { now: NOW });
    expect(nextDue).toBe('2026-11-25');
    expect(ops[0]).toMatchObject({ table: 'task_completions', id: completionId(ID, '2026-11-18'), patch: { kind: 'skipped' } });
    expect(ops[1]).toMatchObject({ patch: { due_date: '2026-11-25' } });
  });

  it('pominięcie ostatniego wystąpienia anuluje serię; zwykłe zadanie nie ma czego pomijać', () => {
    const last = toViewTask({ ...row, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;COUNT=3', anchor: '2026-11-16' } });
    expect(skipOccurrenceOps(last, { now: NOW }).ops[1]!.patch).toEqual({ status: 'cancelled', completed_at: '2026-11-19T11:00:00.000Z' });
    expect(skipOccurrenceOps(toViewTask(row), { now: NOW }).ops).toEqual([]);
  });

  it('zakończenie serii: anulowana, reguła zostaje, cofnięcie', () => {
    const { ops, undo } = endSeriesOps(weekly, NOW);
    expect(ops).toEqual([{ table: 'tasks', id: ID, patch: { status: 'cancelled', completed_at: '2026-11-19T11:00:00.000Z' } }]);
    expect(undo).toEqual([{ table: 'tasks', id: ID, patch: { status: 'todo', completed_at: null } }]);
    expect(endSeriesOps(toViewTask(row), NOW).ops).toEqual([]);
  });
});

describe('quickAddTaskOps', () => {
  const scope: QuickAddScope = {
    userId: 'u1',
    workspaces: [
      { id: 'w-dom', name: 'Dom' },
      { id: 'w-praca', name: 'Praca' },
    ],
    lists: [
      { id: 'in-dom', workspaceId: 'w-dom', kind: 'inbox', name: 'Inbox' },
      { id: 'in-praca', workspaceId: 'w-praca', kind: 'inbox', name: 'Inbox' },
      { id: 'l-remont', workspaceId: 'w-dom', kind: 'project', name: 'Remont kuchni' },
    ],
    tags: [{ id: 'g-tel', name: 'telefon', sortKey: 'b' }],
    defaultListId: 'in-dom',
    lastSortKey: (listId) => (listId === 'l-remont' ? 'm' : undefined),
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  };
  const parse = (text: string) =>
    parseQuickAdd(text, {
      now: '2026-11-18T12:00',
      currentWorkspace: 'Dom',
      workspaces: scope.workspaces.map((w) => w.name),
      lists: [{ workspace: 'Dom', name: 'Remont kuchni', kind: 'project' }],
      tags: scope.tags.map((t) => t.name),
    });

  it('pola, przestrzeń → jej Inbox, źródło', () => {
    const text = 'Zapłacić rachunek za prąd jutro o 10:00 #praca !wysoki ~30m';
    const { taskId, listId, ops } = quickAddTaskOps(parse(text), text, scope);
    expect(listId).toBe('in-praca');
    expect(ops).toEqual([
      {
        table: 'tasks',
        id: taskId,
        patch: expect.objectContaining({
          list_id: 'in-praca',
          title: 'Zapłacić rachunek za prąd',
          priority: 2,
          due_date: '2026-11-19',
          due_time: '10:00',
          duration_min: 30,
          source: { kind: 'quick_add', text },
        }),
      },
    ]);
  });

  it('lista z nazwy, koniec kolejności, tag istniejący i nowy, przypomnienie', () => {
    const text = 'Kupić płytki #remont-kuchni @telefon @Hurtownia jutro o 9 ^15m';
    const { taskId, listId, ops } = quickAddTaskOps(parse(text), text, scope);
    expect(listId).toBe('l-remont');
    expect((ops[0]!.patch.sort_key as string) > 'm').toBe(true);
    const newTag = tagId('u1', 'Hurtownia');
    expect(ops.slice(1)).toEqual([
      { table: 'task_tags', id: taskTagId(taskId, 'g-tel'), patch: { task_id: taskId, tag_id: 'g-tel', deleted_at: null } },
      { table: 'tags', id: newTag, patch: { name: 'Hurtownia', color: null, sort_key: expect.any(String) } },
      { table: 'task_tags', id: taskTagId(taskId, newTag), patch: { task_id: taskId, tag_id: newTag, deleted_at: null } },
      { table: 'reminders', id: expect.any(String), patch: { task_id: taskId, kind: 'relative', offset_min: 15, at_date: null, at_time: null } },
    ]);
  });

  it('termin domyślny widoku, cykl, pusty tytuł', () => {
    const { ops } = quickAddTaskOps(parse('Podlać kwiaty co tydzień'), 'Podlać kwiaty co tydzień', { ...scope, defaultDueDate: '2026-11-25' });
    expect(ops[0]!.patch).toMatchObject({ list_id: 'in-dom', due_date: '2026-11-18', recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=WE' } });
    expect(quickAddTaskOps(parse('Coś'), 'Coś', { ...scope, defaultDueDate: '2026-11-25' }).ops[0]!.patch.due_date).toBe('2026-11-25');
    expect(() => quickAddTaskOps(parse('jutro'), 'jutro', scope)).toThrow('tytuł');
  });
});

describe('podzadania, przenoszenie, kosz', () => {
  // a → b → c → d (4 poziomy), a → e; f osobno.
  const tree = [
    { id: 'a', parentId: null, listId: 'L1', status: 'todo' },
    { id: 'b', parentId: 'a', listId: 'L1', status: 'done' },
    { id: 'c', parentId: 'b', listId: 'L1', status: 'todo' },
    { id: 'd', parentId: 'c', listId: 'L1', status: 'cancelled' },
    { id: 'e', parentId: 'a', listId: 'L1', status: 'in_progress' },
    { id: 'f', parentId: null, listId: 'L1', status: 'todo' },
  ] as const;

  it('potomkowie, poziom, limit 4 poziomów, otwarte podzadania', () => {
    expect(descendants(tree, 'a').map((t) => t.id)).toEqual(['b', 'e', 'c', 'd']);
    expect(taskDepth(tree, 'a')).toBe(1);
    expect(taskDepth(tree, 'd')).toBe(4);
    expect(canAddSubtask(tree, 'c')).toBe(true);
    expect(canAddSubtask(tree, 'd')).toBe(false);
    expect(openDescendants(tree, 'a').map((t) => t.id)).toEqual(['e', 'c']);
  });

  it('daty: bez terminu nie ma godziny ani początku, początek nie po terminie', () => {
    const cur = { startDate: '2026-11-16', dueDate: '2026-11-18', dueTime: '10:00' } as const;
    expect(datesPatch(cur, { due_date: null })).toEqual({ start_date: null, due_date: null, due_time: null });
    expect(datesPatch(cur, { due_date: '2026-11-15' })).toEqual({ start_date: '2026-11-15', due_date: '2026-11-15' });
    expect(datesPatch(cur, { due_time: '11:30' })).toEqual({ due_time: '11:30' });
    expect(datesPatch(cur, { due_date: '2026-11-18' })).toEqual({});
  });

  it('przeniesienie: z podzadaniami; podzadanie na inną listę → zadanie główne', () => {
    expect(moveTaskOps(tree, 'a', 'L2')).toEqual([
      { table: 'tasks', id: 'a', patch: { list_id: 'L2' } },
      ...['b', 'e', 'c', 'd'].map((id) => ({ table: 'tasks', id, patch: { list_id: 'L2' } })),
    ]);
    expect(moveTaskOps(tree, 'c', 'L2')[0]).toEqual({ table: 'tasks', id: 'c', patch: { list_id: 'L2', parent_id: null } });
    expect(moveTaskOps(tree, 'a', 'L1')).toEqual([]);
  });

  it('kosz: usunięcie z podzadaniami, przywrócenie tych usuniętych razem', () => {
    const at = '2026-11-19T10:00:00.000Z';
    expect(deleteTaskOps(tree, 'b', at)).toEqual(['b', 'c', 'd'].map((id) => ({ table: 'tasks', id, patch: { deleted_at: at } })));
    const trashed = tree.map((t) => ({ ...t, deletedAt: ['b', 'c'].includes(t.id) ? at : t.id === 'd' ? '2026-11-01T00:00:00.000Z' : null }));
    expect(restoreTaskOps(trashed, 'b', { parentAlive: true })).toEqual([
      { table: 'tasks', id: 'b', patch: { deleted_at: null } },
      { table: 'tasks', id: 'c', patch: { deleted_at: null } },
    ]);
    expect(restoreTaskOps(trashed, 'c', { parentAlive: false })).toEqual([{ table: 'tasks', id: 'c', patch: { deleted_at: null, parent_id: null } }]);
  });

  it('szybkie dodawanie podzadania: lista rodzica, kolejność wśród rodzeństwa', () => {
    const parse = (text: string) => parseQuickAdd(text, { now: '2026-11-18T12:00', workspaces: ['Dom'], lists: [{ workspace: 'Dom', name: 'Zakupy' }], tags: [] });
    const { listId, ops } = quickAddTaskOps(parse('Kupić mleko #zakupy'), 'Kupić mleko #zakupy', {
      userId: 'u1',
      workspaces: [{ id: 'w', name: 'Dom' }],
      lists: [{ id: 'zak', workspaceId: 'w', kind: 'list', name: 'Zakupy' }],
      tags: [],
      defaultListId: 'in',
      parent: { id: 'a', listId: 'L1' },
      lastSortKey: (id) => (id === 'a' ? 'k' : undefined),
    });
    expect(listId).toBe('L1');
    expect(ops[0]!.patch).toMatchObject({ list_id: 'L1', parent_id: 'a' });
    expect((ops[0]!.patch.sort_key as string) > 'k').toBe(true);
  });
});

describe('bulkTaskOps', () => {
  const base = toViewTask(row);
  const a = { ...base, id: 'a', dueDate: '2026-11-18' as const, dueTime: '09:00' as const, priority: 3 as const };
  const b = { ...base, id: 'b', parentId: 'a', dueDate: null, priority: 4 as const, postponeCount: 0 };
  const c = { ...base, id: 'c', status: 'done' as const, completedAt: '2026-11-18T10:00:00Z' };
  const all = [a, b, c];
  const ctx = { today: '2026-11-19' as const, now: NOW };

  it('priorytet z cofnięciem; bez zmiany — bez operacji', () => {
    const { ops, undo } = bulkTaskOps([a, b], all, { kind: 'priority', priority: 4 }, ctx);
    expect(ops).toEqual([{ table: 'tasks', id: 'a', patch: { priority: 4 } }]);
    expect(undo).toEqual([{ table: 'tasks', id: 'a', patch: { priority: 3 } }]);
  });

  it('jutro: godzina zostaje, licznik przesunięć rośnie; cofnięcie przywraca termin i licznik', () => {
    const { ops, undo } = bulkTaskOps([a, b], all, { kind: 'tomorrow' }, ctx);
    expect(ops).toEqual([
      { table: 'tasks', id: 'a', patch: { due_date: '2026-11-20', postpone_count: 3 } },
      { table: 'tasks', id: 'b', patch: { due_date: '2026-11-20' } },
    ]);
    expect(undo[0]).toEqual({ table: 'tasks', id: 'a', patch: { due_date: '2026-11-18', postpone_count: 2 } });
  });

  it('przeniesienie i kosz: podzadanie zaznaczone z rodzicem idzie z nim raz', () => {
    expect(bulkTaskOps([a, b], all, { kind: 'move', listId: 'L9' }, ctx).ops).toEqual([
      { table: 'tasks', id: 'a', patch: { list_id: 'L9' } },
      { table: 'tasks', id: 'b', patch: { list_id: 'L9' } },
    ]);
    const del = bulkTaskOps([b, a], all, { kind: 'delete' }, ctx);
    expect(del.ops.map((o) => o.id)).toEqual(['a', 'b']);
    expect(del.undo.every((u) => u.patch.deleted_at === null)).toBe(true);
  });

  it('ukończenie pomija zamknięte', () => {
    const { ops, undo } = bulkTaskOps([a, c], all, { kind: 'complete' }, ctx);
    expect(ops.map((o) => o.id)).toEqual(['a']);
    expect(undo).toEqual([{ table: 'tasks', id: 'a', patch: { status: 'todo', completed_at: null } }]);
  });
});

describe('dropTaskOps', () => {
  // a(k1) → [a1(k1), a2(k2)], b(k2), c(k3) → c1 → c2 → c3 (4 poziomy)
  const t = (id: string, parentId: string | null, sortKey: string) => ({ id, parentId, listId: 'L', sortKey });
  const tasks = [t('a', null, 'k1'), t('a1', 'a', 'k1'), t('a2', 'a', 'k2'), t('b', null, 'k2'), t('c', null, 'k3'), t('c1', 'c', 'k1'), t('c2', 'c1', 'k1'), t('c3', 'c2', 'k1')];

  it('kolejność wśród rodzeństwa', () => {
    const ops = dropTaskOps(tasks, 'c', 'a', 'before')!;
    expect(ops).toHaveLength(1);
    expect((ops[0]!.patch.sort_key as string) < 'k1').toBe(true);
    const mid = dropTaskOps(tasks, 'a', 'b', 'after')!;
    expect(mid[0]!.patch.sort_key as string).toSatisfy((k: string) => k > 'k2' && k < 'k3');
  });

  it('bez zmiany miejsca — nic', () => {
    expect(dropTaskOps(tasks, 'b', 'a', 'after')).toEqual([]);
    expect(dropTaskOps(tasks, 'b', 'c', 'before')).toEqual([]);
  });

  it('zmiana rodzica: zadanie główne obok podzadania', () => {
    const ops = dropTaskOps(tasks, 'b', 'a2', 'after')!;
    expect(ops[0]!.patch).toMatchObject({ parent_id: 'a' });
    expect((ops[0]!.patch.sort_key as string) > 'k2').toBe(true);
  });

  it('cykl i za głęboko — odrzucone', () => {
    expect(dropTaskOps(tasks, 'c', 'c2', 'after')).toBeNull();
    // a (2 poziomy) obok c3 (poziom 4) → 3 + 2 > 4
    expect(dropTaskOps(tasks, 'a', 'c3', 'after')).toBeNull();
    // b (1 poziom) obok c3 → dokładnie 4 poziomy — dozwolone.
    expect(dropTaskOps(tasks, 'b', 'c3', 'after')![0]!.patch).toMatchObject({ parent_id: 'c2' });
  });
});
