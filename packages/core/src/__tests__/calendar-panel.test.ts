/**
 * Źródła zadań do zaplanowania w kalendarzu i szukanie w tytułach; dziś = środa 2026-11-18.
 */
import { describe, expect, it } from 'vitest';

import { calendarPanelTasks, searchTaskTitles, type CalendarPanelData } from '../calendar-panel.ts';
import { workWindow } from '../time-blocking.ts';
import type { ViewContext, ViewTask } from '../views.ts';

const W1 = 'w1';
const W2 = 'w2';
const INBOX = 'inbox-1';
const LIST = 'list-1';
const ctx: ViewContext = { today: '2026-11-18', timeZone: 'Europe/Warsaw' };

const task = (id: string, over: Partial<ViewTask> = {}): ViewTask => ({
  id,
  workspaceId: W1,
  listId: LIST,
  parentId: null,
  kind: 'task',
  title: id,
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
  sortKey: '0010',
  tagIds: [],
  postponeCount: 0,
  ...over,
});

const tasks: ViewTask[] = [
  task('today', { dueDate: '2026-11-18' }),
  task('today-timed', { dueDate: '2026-11-18', dueTime: '09:00' }),
  task('overdue', { dueDate: '2026-11-10' }),
  task('tomorrow', { dueDate: '2026-11-19', priority: 2 }),
  task('tomorrow-low', { dueDate: '2026-11-19', priority: 3 }),
  task('none-low', { sortKey: '0001' }),
  task('none-high', { priority: 1, sortKey: '0009' }),
  task('none-done', { status: 'done' }),
  task('habit', { kind: 'habit' }),
  task('in-inbox', { listId: INBOX, sortKey: '0002' }),
  task('in-inbox-timed', { listId: INBOX, dueDate: '2026-11-20', dueTime: '10:00' }),
  task('other-space', { workspaceId: W2, listId: 'list-2' }),
  task('p1-tomorrow', { dueDate: '2026-11-19', priority: 1, listId: 'list-2', workspaceId: W2 }),
];
const data: CalendarPanelData = {
  tasks,
  inboxListIds: new Set([INBOX]),
  savedFilters: [{ id: 'f1', query: { priorities: [1] } }],
};
const ids = (list: readonly ViewTask[]) => list.map((t) => t.id);

describe('calendarPanelTasks', () => {
  it('„Dziś i zaległe” — tylko bez godziny', () => {
    expect(ids(calendarPanelTasks('today', data, ctx)).sort()).toEqual(['overdue', 'today']);
  });

  it('wybrany dzień — według priorytetu', () => {
    expect(ids(calendarPanelTasks('day', data, ctx, '2026-11-19'))).toEqual(['p1-tomorrow', 'tomorrow', 'tomorrow-low']);
    expect(ids(calendarPanelTasks('day', data, { ...ctx, workspaceId: W1 }, '2026-11-19'))).toEqual(['tomorrow', 'tomorrow-low']);
  });

  it('Inbox i „Bez terminu” bez nawyków, ukończonych i zadań z godziną', () => {
    expect(ids(calendarPanelTasks('inbox', data, ctx))).toEqual(['in-inbox']);
    expect(ids(calendarPanelTasks('none', data, { ...ctx, workspaceId: W1 }))).toEqual(['none-high', 'none-low', 'in-inbox']);
    expect(ids(calendarPanelTasks('none', data, ctx))).toContain('other-space');
  });

  it('zapisany filtr w przestrzeni; nieznany filtr — pusto', () => {
    expect(ids(calendarPanelTasks('filter:f1', data, ctx)).sort()).toEqual(['none-high', 'p1-tomorrow']);
    expect(ids(calendarPanelTasks('filter:f1', data, { ...ctx, workspaceId: W1 }))).toEqual(['none-high']);
    expect(calendarPanelTasks('filter:brak', data, ctx)).toEqual([]);
  });

  it('bez cichego limitu', () => {
    const many = Array.from({ length: 150 }, (_, i) => task(`n${i}`));
    expect(calendarPanelTasks('none', { ...data, tasks: many }, ctx)).toHaveLength(150);
  });
});

describe('searchTaskTitles', () => {
  const list = [task('a', { title: 'Zażółć gęślą jaźń' }), task('b', { title: 'Raport kwartalny' }), task('c', { title: 'Łódź — bilety' })];
  it('każde słowo, bez ogonków i wielkości liter', () => {
    expect(ids(searchTaskTitles(list, 'gesla zaz'))).toEqual(['a']);
    expect(ids(searchTaskTitles(list, 'LODZ'))).toEqual(['c']);
    expect(ids(searchTaskTitles(list, 'raport roczny'))).toEqual([]);
    expect(ids(searchTaskTitles(list, '  '))).toEqual(['a', 'b', 'c']);
  });
});

describe('workWindow', () => {
  const work = { days: [1, 2, 3, 4, 5], start: '09:00' as const, end: '17:00' as const };
  it('godziny pracy w minutach dnia; weekend i pusty zakres — brak', () => {
    expect(workWindow('2026-11-19', work, 'Europe/Warsaw')).toEqual({ startMin: 540, endMin: 1020 });
    expect(workWindow('2026-11-21', work, 'Europe/Warsaw')).toBeNull();
    expect(workWindow('2026-11-19', { ...work, end: '09:00' }, 'Europe/Warsaw')).toBeNull();
  });
  it('zmiana czasu — zegar ścienny', () => {
    // Niedziela 25.10.2026 (doba 25 h) jako dzień roboczy: 09:00 to 600 min od północy.
    expect(workWindow('2026-10-25', { ...work, days: [7] }, 'Europe/Warsaw')).toEqual({ startMin: 600, endMin: 1080 });
  });
});
