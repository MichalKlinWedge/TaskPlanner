/**
 * Najbliższy zaplanowany dzień nawyku i kolejność listy „Cykliczne”; dziś = środa 2026-11-18.
 */
import { describe, expect, it } from 'vitest';

import { habitNextDate, sortHabitsByNext, type Habit, type HabitCompletion } from '../habits.ts';
import type { ViewTask } from '../views.ts';

const TODAY = '2026-11-18';
const rule = (rrule: string, anchor = '2026-10-01') => ({ mode: 'schedule' as const, rrule, anchor });
const done = (date: string, value?: number): HabitCompletion => ({ date, kind: 'done', value });

describe('habitNextDate', () => {
  it('dzień reguły od dziś bez wpisu', () => {
    const mwf: Habit = { recurrence: rule('FREQ=WEEKLY;BYDAY=MO,WE,FR') };
    expect(habitNextDate(mwf, [], TODAY)).toBe('2026-11-18');
    expect(habitNextDate(mwf, [done(TODAY)], TODAY)).toBe('2026-11-20');
    expect(habitNextDate(mwf, [done(TODAY), { date: '2026-11-20', kind: 'skipped' }], TODAY)).toBe('2026-11-23');
    expect(habitNextDate({ recurrence: rule('FREQ=WEEKLY;BYDAY=SA') }, [], TODAY)).toBe('2026-11-21');
  });

  it('częściowa wartość celu nie zalicza dnia', () => {
    const water: Habit = { recurrence: rule('FREQ=DAILY'), target: 8 };
    expect(habitNextDate(water, [done(TODAY, 3)], TODAY)).toBe(TODAY);
    expect(habitNextDate(water, [done(TODAY, 8)], TODAY)).toBe('2026-11-19');
  });

  it('początek w przyszłości, koniec w przeszłości', () => {
    expect(habitNextDate({ recurrence: rule('FREQ=DAILY', '2026-12-01') }, [], TODAY)).toBe('2026-12-01');
    expect(habitNextDate({ recurrence: rule('FREQ=DAILY;UNTIL=20261110') }, [], TODAY)).toBeNull();
  });

  it('cel „N razy w tygodniu”: osiągnięty → poniedziałek następnego tygodnia', () => {
    const gym: Habit = { recurrence: rule('FREQ=DAILY'), goal: { period: 'week', times: 3 } };
    expect(habitNextDate(gym, [done('2026-11-16')], TODAY)).toBe(TODAY);
    expect(habitNextDate(gym, [done('2026-11-16'), done(TODAY)], TODAY)).toBe('2026-11-19');
    expect(habitNextDate(gym, [done('2026-11-16'), done('2026-11-17'), done(TODAY)], TODAY)).toBe('2026-11-23');
    const ending: Habit = { recurrence: rule('FREQ=DAILY;UNTIL=20261122'), goal: { period: 'week', times: 1 } };
    expect(habitNextDate(ending, [done('2026-11-16')], TODAY)).toBeNull();
  });
});

describe('sortHabitsByNext', () => {
  const habit = (id: string, rrule: string, over: Partial<ViewTask> = {}): ViewTask => ({
    id, workspaceId: 'w', listId: 'l', parentId: null, kind: 'habit', title: id, status: 'todo', priority: 4,
    startDate: null, dueDate: null, dueTime: null, durationMin: null, recurrence: rule(rrule), habit: null,
    completedAt: null, createdAt: '2026-10-01T10:00:00Z', sortKey: '0010', tagIds: [], postponeCount: 0, ...over,
  });

  it('najbliższy dzień, potem pora, potem kolejność ręczna; zakończone na końcu', () => {
    const tasks = [
      habit('sobota', 'FREQ=WEEKLY;BYDAY=SA', { sortKey: '0001' }),
      habit('koniec', 'FREQ=DAILY;UNTIL=20261110', { sortKey: '0002' }),
      habit('dzis-bez-pory', 'FREQ=DAILY', { sortKey: '0003' }),
      habit('dzis-zrobione', 'FREQ=DAILY', { sortKey: '0004' }),
      habit('dzis-0700', 'FREQ=DAILY', { sortKey: '0009', habit: { time: '07:00' } }),
      habit('dzis-bez-pory-2', 'FREQ=DAILY', { sortKey: '0002' }),
    ];
    const completions = new Map([['dzis-zrobione', [done(TODAY)]]]);
    const order = sortHabitsByNext(tasks, (id) => completions.get(id) ?? [], TODAY).map((t) => t.id);
    expect(order).toEqual(['dzis-0700', 'dzis-bez-pory-2', 'dzis-bez-pory', 'dzis-zrobione', 'sobota', 'koniec']);
  });
});
