/** Etap 11: modele widżetów Android „Dziś”, „Cykliczne”, „Szybkie dodawanie” (M20). */
import { describe, expect, it } from 'vitest';

import type { HabitCompletion } from '../habits.ts';
import type { ScheduleRecurrence } from '../recurrence.ts';
import type { ViewContext, ViewTask } from '../views.ts';
import { habitsWidgetModel, inboxCount, sameHabitEntry, todayWidgetModel, WIDGET_TASK_LIMIT } from '../widgets.ts';

const W1 = 'w1';
const W2 = 'w2';
const ctx: ViewContext = { today: '2026-11-18', timeZone: 'Europe/Warsaw' };
const daily: ScheduleRecurrence = { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' };

let n = 0;
function task(over: Partial<ViewTask> = {}): ViewTask {
  n++;
  return {
    id: `t${String(n).padStart(3, '0')}`,
    workspaceId: W1,
    listId: 'l1',
    parentId: null,
    kind: 'task',
    title: `Zadanie ${n}`,
    status: 'todo',
    priority: 4,
    startDate: null,
    dueDate: null,
    dueTime: null,
    durationMin: null,
    recurrence: null,
    habit: null,
    completedAt: null,
    createdAt: '2026-11-01T10:00:00Z',
    sortKey: `k${String(n).padStart(3, '0')}`,
    tagIds: [],
    postponeCount: 0,
    ...over,
  };
}

describe('widżet „Dziś”', () => {
  it('zaległe, dziś, ukończone dziś; najwyżej 10 wierszy, otwarte mają pierwszeństwo', () => {
    const done = task({ id: 'done', status: 'done', dueDate: '2026-11-18', completedAt: '2026-11-18T08:00:00Z' });
    const late = task({ id: 'late', dueDate: '2026-11-17' });
    const timed = task({ id: 'timed', dueDate: '2026-11-18', dueTime: '09:30' });
    const many = Array.from({ length: 9 }, () => task({ dueDate: '2026-11-18' }));
    const model = todayWidgetModel([done, ...many, timed, late, task({ dueDate: '2026-11-19' })], ctx);
    expect(model.items).toHaveLength(WIDGET_TASK_LIMIT);
    expect(model.items[0]).toMatchObject({ id: 'late', overdue: true, done: false });
    expect(model.items[1]).toMatchObject({ id: 'timed', time: '09:30', overdue: false });
    expect(model.items.some((i) => i.id === 'done')).toBe(false);
    expect(model.open).toBe(11);
    expect(model.more).toBe(2);
  });

  it('ukończone dziś na końcu; seria niesie wystąpienie do kliknięcia', () => {
    const series = task({ id: 'series', dueDate: '2026-11-18', recurrence: daily });
    const done = task({ id: 'done', status: 'done', completedAt: '2026-11-18T08:00:00Z' });
    const model = todayWidgetModel([done, series], ctx);
    expect(model.items.map((i) => [i.id, i.done, i.occurrence])).toEqual([
      ['series', false, '2026-11-18'],
      ['done', true, null],
    ]);
    expect(model).toMatchObject({ open: 1, more: 0 });
  });

  it('bieżąca przestrzeń', () => {
    const model = todayWidgetModel([task({ id: 'a', dueDate: '2026-11-18' }), task({ id: 'b', dueDate: '2026-11-18', workspaceId: W2 })], { ...ctx, workspaceId: W2 });
    expect(model.items.map((i) => i.id)).toEqual(['b']);
  });
});

describe('widżet „Cykliczne”', () => {
  const habit = (over: Partial<ViewTask>) => task({ kind: 'habit', recurrence: daily, ...over });

  it('stan dnia, postęp i wpisy kliknięć (stan docelowy)', () => {
    const tasks = [
      habit({ id: 'read', title: 'Czytanie' }),
      habit({ id: 'water', title: 'Woda', habit: { target: 8, unit: 'szklanek' } }),
      habit({ id: 'gym', title: 'Siłownia', habit: { goal: { period: 'week', times: 2 } } }),
      habit({ id: 'old', status: 'cancelled' }),
      habit({ id: 'later', recurrence: { ...daily, anchor: '2026-11-20' } }),
      task({ id: 'plain', dueDate: '2026-11-18' }),
    ];
    const completions = new Map<string, HabitCompletion[]>([
      ['read', [{ date: '2026-11-18', kind: 'done' }]],
      ['water', [{ date: '2026-11-18', kind: 'done', value: 3 }]],
      ['gym', [{ date: '2026-11-16', kind: 'done' }, { date: '2026-11-17', kind: 'done' }]],
    ]);
    const model = habitsWidgetModel(tasks, completions, ctx);
    expect(model.date).toBe('2026-11-18');
    expect(model.items.map((h) => h.id)).toEqual(['read', 'water', 'gym']);
    const [read, water, gym] = model.items;
    expect(read).toMatchObject({ done: true, settled: true, toggle: null, plusOne: null, progress: null });
    expect(water).toMatchObject({ done: false, settled: false, progress: '3 / 8 szklanek', toggle: { kind: 'done', value: 8 }, plusOne: { kind: 'done', value: 4 } });
    expect(gym).toMatchObject({ done: false, settled: true, progress: '2 / 2 w tym tygodniu', toggle: { kind: 'done', value: null }, plusOne: null });
    expect(model.open).toBe(1);
  });

  it('nawyk ilościowy bez wpisu: +1 od zera', () => {
    const model = habitsWidgetModel([habit({ id: 'w', habit: { target: 2 } })], new Map(), ctx);
    expect(model.items[0]).toMatchObject({ plusOne: { kind: 'done', value: 1 }, toggle: { kind: 'done', value: 2 } });
  });

  it('powtórzone kliknięcie = ten sam wpis → bez zapisu', () => {
    expect(sameHabitEntry(null, null)).toBe(true);
    expect(sameHabitEntry({ date: '2026-11-18', kind: 'done', value: 4 }, { kind: 'done', value: 4 })).toBe(true);
    expect(sameHabitEntry({ date: '2026-11-18', kind: 'done' }, { kind: 'done', value: null })).toBe(true);
    expect(sameHabitEntry({ date: '2026-11-18', kind: 'done', value: 3 }, { kind: 'done', value: 4 })).toBe(false);
    expect(sameHabitEntry({ date: '2026-11-18', kind: 'skipped' }, { kind: 'done' })).toBe(false);
    expect(sameHabitEntry({ date: '2026-11-18', kind: 'done' }, null)).toBe(false);
  });
});

describe('widżet „Szybkie dodawanie”', () => {
  it('licznik Inbox: otwarte zadania list inbox bieżącej przestrzeni', () => {
    const tasks = [
      task({ listId: 'in1' }),
      task({ listId: 'in1', status: 'done' }),
      task({ listId: 'in2', workspaceId: W2 }),
      task({ listId: 'l1' }),
      task({ listId: 'in1', kind: 'habit' }),
    ];
    const inbox = new Set(['in1', 'in2']);
    expect(inboxCount(tasks, inbox, ctx)).toBe(2);
    expect(inboxCount(tasks, inbox, { ...ctx, workspaceId: W1 })).toBe(1);
  });
});
