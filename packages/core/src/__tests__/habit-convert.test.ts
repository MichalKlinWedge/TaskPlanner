/**
 * Zamiana nawyku ↔ zadania z powtarzaniem; dziś = środa 2026-11-18.
 */
import { describe, expect, it } from 'vitest';

import { habitToSeriesOps, habitToSeriesProblem, seriesToHabitOps, seriesToHabitProblem } from '../habit-convert.ts';
import type { HabitCompletion } from '../habits.ts';
import type { ViewTask } from '../views.ts';

const TODAY = '2026-11-18';

function task(over: Partial<ViewTask> = {}): ViewTask {
  return {
    id: 't1',
    workspaceId: 'w',
    listId: 'l',
    parentId: null,
    kind: 'habit',
    title: 'Spacer',
    status: 'todo',
    priority: 4,
    startDate: null,
    dueDate: null,
    dueTime: null,
    durationMin: null,
    recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', anchor: '2026-10-01' },
    habit: { time: '07:30', target: 30, unit: 'min' },
    completedAt: null,
    createdAt: '2026-10-01T10:00:00Z',
    sortKey: '0010',
    tagIds: [],
    postponeCount: 0,
    ...over,
  };
}

const done = (date: string): HabitCompletion => ({ date, kind: 'done' });
const patch = (r: { ops: { patch: Record<string, unknown> }[] }) => r.ops[0]!.patch;

describe('nawyk → zadanie z powtarzaniem', () => {
  it('termin = dzisiejsze wystąpienie, godzina = pora nawyku, cel znika', () => {
    const r = habitToSeriesOps(task(), [done('2026-11-16')], TODAY);
    expect(patch(r)).toEqual({ kind: 'task', habit: null, due_date: '2026-11-18', due_time: '07:30', start_date: null });
    expect(r.undo[0]!.patch).toEqual({ kind: 'habit', habit: { time: '07:30', target: 30, unit: 'min' }, due_date: null, due_time: null, start_date: null });
  });

  it('dziś już odhaczone albo wolne → następne wystąpienie', () => {
    expect(patch(habitToSeriesOps(task(), [done(TODAY)], TODAY)).due_date).toBe('2026-11-20');
    expect(patch(habitToSeriesOps(task(), [done(TODAY), { date: '2026-11-20', kind: 'skipped' }], TODAY)).due_date).toBe('2026-11-23');
  });

  it('bez pory → bez godziny; reguła skończona → bez terminu', () => {
    expect(patch(habitToSeriesOps(task({ habit: null }), [], TODAY)).due_time).toBeNull();
    const ended = task({ recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;UNTIL=20261110', anchor: '2026-10-01' } });
    expect(patch(habitToSeriesOps(ended, [], TODAY))).toMatchObject({ due_date: null, due_time: null });
  });

  it('cel „N razy w okresie” nie ma odpowiednika', () => {
    const goal = task({ recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-10-01' }, habit: { goal: { period: 'week', times: 3 } } });
    expect(habitToSeriesProblem(goal)).toMatch(/N razy/);
    expect(() => habitToSeriesOps(goal, [], TODAY)).toThrow(/N razy/);
    expect(habitToSeriesProblem(task({ kind: 'task' }))).not.toBeNull();
  });
});

describe('zadanie z powtarzaniem → nawyk', () => {
  const series = (over: Partial<ViewTask> = {}) => task({ kind: 'task', habit: null, dueDate: '2026-11-20', dueTime: '18:00', startDate: '2026-11-19', ...over });

  it('godzina terminu zostaje porą, termin i początek znikają', () => {
    const r = seriesToHabitOps(series());
    expect(patch(r)).toEqual({ kind: 'habit', habit: { time: '18:00' }, due_date: null, due_time: null, start_date: null });
    expect(r.undo[0]!.patch).toEqual({ kind: 'task', habit: null, due_date: '2026-11-20', due_time: '18:00', start_date: '2026-11-19' });
    expect(patch(seriesToHabitOps(series({ dueTime: null }))).habit).toEqual({});
  });

  it('odmowy: bez powtarzania, „po ukończeniu”, podzadanie, z podzadaniami', () => {
    expect(seriesToHabitProblem(series({ recurrence: null }))).toMatch(/nie powtarza/);
    expect(seriesToHabitProblem(series({ recurrence: { mode: 'after_completion', every: { unit: 'day', n: 3 } } }))).toMatch(/po ukończeniu/);
    expect(seriesToHabitProblem(series({ parentId: 'p' }))).toMatch(/Podzadanie/);
    expect(seriesToHabitProblem(series(), { subtasks: 2 })).toMatch(/podzadań/);
    expect(() => seriesToHabitOps(series(), { subtasks: 1 })).toThrow();
    expect(seriesToHabitProblem(series())).toBeNull();
  });

  it('w obie strony wraca do tego samego (bez celu ilościowego)', () => {
    const habit = task({ habit: { time: '07:30' } });
    const asSeries = patch(habitToSeriesOps(habit, [], TODAY));
    const back = series({ dueDate: asSeries.due_date as string, dueTime: asSeries.due_time as string, startDate: null });
    expect(patch(seriesToHabitOps(back))).toMatchObject({ kind: 'habit', habit: { time: '07:30' } });
  });
});
