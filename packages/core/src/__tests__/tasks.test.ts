/**
 * Wiersz lokalnej bazy → `ViewTask`; ukończenie zwykłego zadania, serii i nawyku z cofnięciem.
 */
import { describe, expect, it } from 'vitest';

import { completionId, tagId, taskTagId } from '../ids.ts';
import { parseQuickAdd } from '../quick-add.ts';
import { completeTaskOps, quickAddTaskOps, reopenTaskPatch, toViewTask, type LocalTaskRow, type QuickAddScope } from '../tasks.ts';

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
