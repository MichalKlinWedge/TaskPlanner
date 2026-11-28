/**
 * Strona startowa (v1.x): liczby pulpitu policzone ręcznie (dziś = czwartek 2026-11-26, strefa Europe/Warsaw).
 */
import { describe, expect, it } from 'vitest';

import { HOME_HISTORY_DAYS, HOME_UPCOMING_DAYS, homeStats, homeTileTones, homeTodayProgress, type HomeStats, type HomeStatsInput } from '../home.ts';
import type { Recurrence } from '../recurrence.ts';
import type { ViewContext, ViewTask } from '../views.ts';

const W1 = '0190a000-0000-7000-8000-000000000001';
const W2 = '0190a000-0000-7000-8000-000000000002';
const ctx: ViewContext = { today: '2026-11-26', timeZone: 'Europe/Warsaw', firstDayOfWeek: 1 };
const now = new Date('2026-11-26T15:00:00Z');

const task = (over: Partial<ViewTask> & { id: string }): ViewTask => ({
  workspaceId: W1,
  listId: 'dom',
  parentId: null,
  kind: 'task',
  title: over.id,
  status: 'todo',
  priority: 4,
  startDate: null,
  dueDate: null,
  dueTime: null,
  durationMin: null,
  recurrence: null,
  habit: null,
  completedAt: null,
  createdAt: '2026-10-01T10:00:00Z',
  sortKey: '0010',
  tagIds: [],
  postponeCount: 0,
  ...over,
});

const lists = [
  { id: 'inbox1', kind: 'inbox' },
  { id: 'dom', kind: 'list' },
  { id: 'proj', kind: 'project' },
  { id: 'inbox2', kind: 'inbox' },
];

const input = (tasks: ViewTask[], over: Partial<HomeStatsInput> = {}): HomeStatsInput => ({
  tasks,
  lists,
  seriesDone: [],
  habitCompletions: new Map(),
  timeEntries: [],
  now,
  ...over,
});

describe('homeStats', () => {
  it('kafelki: otwarte, Inbox, dziś, zaległe, priorytety', () => {
    const stats = homeStats(
      input([
        task({ id: 'a', listId: 'inbox1', priority: 1 }),
        task({ id: 'b', dueDate: '2026-11-26', priority: 2 }),
        task({ id: 'c', dueDate: '2026-11-20' }),
        task({ id: 'd', status: 'done', completedAt: '2026-11-26T09:00:00Z', dueDate: '2026-11-26' }),
        task({ id: 'e', status: 'cancelled' }),
        task({ id: 'f', workspaceId: W2, listId: 'inbox2' }),
      ]),
      ctx,
    );
    expect(stats).toMatchObject({ open: 4, inbox: 2, today: 1, overdue: 1, doneToday: 1, priority: { 1: 1, 2: 1, 3: 0, 4: 2 } });
    expect(homeStats(input([task({ id: 'a', listId: 'inbox1' }), task({ id: 'f', workspaceId: W2, listId: 'inbox2' })]), { ...ctx, workspaceId: W2 })).toMatchObject({ open: 1, inbox: 1 });
  });

  it('historia: dzień ukończenia w strefie użytkownika, seria liczona raz', () => {
    const series: Recurrence = { mode: 'schedule', anchor: '2026-11-01', rrule: 'FREQ=DAILY;COUNT=30' };
    const stats = homeStats(
      input(
        [
          // 23:30 UTC 25.11 = 00:30 26.11 w Warszawie.
          task({ id: 'late', status: 'done', completedAt: '2026-11-25T23:30:00Z', createdAt: '2026-11-25T10:00:00Z' }),
          task({ id: 'old', status: 'done', completedAt: '2026-11-24T12:00:00Z' }),
          // Ostatnie wystąpienie zamknęło serię — ta sama chwila co wpis `task_completions`.
          task({ id: 's', recurrence: series, status: 'done', completedAt: '2026-11-25T08:00:00Z' }),
          task({ id: 'new', createdAt: '2026-11-26T08:00:00Z' }),
          task({ id: 'prev', status: 'done', completedAt: '2026-11-16T12:00:00Z' }),
        ],
        {
          seriesDone: [
            { taskId: 's', completedAt: '2026-11-24T08:00:00Z' },
            { taskId: 's', completedAt: '2026-11-25T08:00:00Z' },
          ],
        },
      ),
      ctx,
    );
    expect(stats.history).toHaveLength(HOME_HISTORY_DAYS);
    expect(stats.history.at(-1)).toEqual({ date: '2026-11-26', done: 1, created: 1 });
    expect(stats.history.at(-2)).toEqual({ date: '2026-11-25', done: 1, created: 1 });
    expect(stats.history.at(-3)).toEqual({ date: '2026-11-24', done: 2, created: 0 });
    expect(stats).toMatchObject({ doneToday: 1, doneWeek: 4, donePrevWeek: 1, createdWeek: 2, streak: 3 });
  });

  it('seria dni: bez ukończonego dziś liczy od wczoraj, przerwa ją kończy', () => {
    const done = (id: string, day: string) => task({ id, status: 'done', completedAt: `${day}T12:00:00Z` });
    expect(homeStats(input([done('a', '2026-11-25'), done('b', '2026-11-24'), done('c', '2026-11-22')]), ctx).streak).toBe(2);
    expect(homeStats(input([done('a', '2026-11-24')]), ctx).streak).toBe(0);
  });

  it('najbliższe dni, postęp list i minuty skupienia', () => {
    const stats = homeStats(
      input(
        [
          task({ id: 'a', listId: 'proj', dueDate: '2026-11-27', durationMin: 30 }),
          task({ id: 'b', listId: 'proj', dueDate: '2026-11-27', durationMin: 45 }),
          task({ id: 'c', listId: 'proj', status: 'done', completedAt: '2026-11-01T10:00:00Z' }),
          task({ id: 'd', listId: 'dom' }),
          task({ id: 'e', listId: 'inbox1' }),
          task({ id: 'f', listId: 'dom', status: 'done', completedAt: '2026-11-01T10:00:00Z' }),
          task({ id: 'g', listId: 'dom', status: 'done', completedAt: '2026-11-01T10:00:00Z' }),
        ],
        {
          timeEntries: [
            // Od 23:00 UTC 25.11 (= północ w Warszawie) — liczy się 30 min; przerwa się nie liczy; otwarty do `now`.
            { taskId: 'a', kind: 'focus', startedAt: '2026-11-25T22:30:00Z', endedAt: '2026-11-25T23:30:00Z' },
            { taskId: 'a', kind: 'break', startedAt: '2026-11-26T10:00:00Z', endedAt: '2026-11-26T10:05:00Z' },
            { taskId: 'a', kind: 'focus', startedAt: '2026-11-26T14:40:00Z', endedAt: null },
          ],
        },
      ),
      ctx,
    );
    expect(stats.upcoming).toHaveLength(HOME_UPCOMING_DAYS);
    expect(stats.upcoming[1]).toEqual({ date: '2026-11-27', items: 2, minutes: 75 });
    expect(stats.lists).toEqual([
      { listId: 'proj', open: 2, done: 1 },
      { listId: 'dom', open: 1, done: 2 },
    ]);
    expect(stats.focusTodayMin).toBe(50);
  });

  it('tony kafelków: dobrze / źle / informacja', () => {
    const base = { today: 0, overdue: 0, inbox: 0, open: 3, doneToday: 2, doneWeek: 5, donePrevWeek: 5, createdWeek: 5, habitsDone: 1, habitsTotal: 1, focusTodayMin: 25 } as HomeStats;
    expect(homeTileTones(base)).toEqual({ today: 'ok', overdue: 'ok', inbox: 'ok', open: 'info', doneToday: 'ok', doneWeek: 'ok', createdWeek: 'ok', habits: 'ok', focus: 'ok' });
    expect(homeTileTones({ ...base, today: 4, overdue: 1, inbox: 2, doneToday: 0, doneWeek: 4, createdWeek: 9, habitsDone: 0, focusTodayMin: 0 })).toEqual({
      today: 'info',
      overdue: 'bad',
      inbox: 'info',
      open: 'info',
      doneToday: 'info',
      doneWeek: 'bad',
      createdWeek: 'bad',
      habits: 'info',
      focus: 'info',
    });
  });

  it('postęp „Na dziś”: ukończone wobec ukończonych + otwartych', () => {
    expect(homeTodayProgress({ today: 12, doneToday: 4 } as HomeStats)).toEqual({ done: 4, total: 16, pct: 25 });
    expect(homeTodayProgress({ today: 0, doneToday: 0 } as HomeStats)).toEqual({ done: 0, total: 0, pct: 0 });
  });
});
