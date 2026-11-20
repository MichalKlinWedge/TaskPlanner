/**
 * Przegląd dnia i tygodnia (M16, §7.8); dziś = środa 2026-11-18.
 */
import { describe, expect, it } from 'vitest';

import { REVIEW_ACTION } from '../labels.ts';
import { dailyReviewQueue, dailySummary, reschedulePatch, reviewBulkAction, reviewFinishOp, reviewStartOp, reviewsDue, ReviewStats, reviewStats, weeklyReview, type ReviewAction, type ReviewList } from '../review.ts';
import { bulkTaskOps } from '../tasks.ts';
import type { ViewContext, ViewTask } from '../views.ts';

const W1 = '0190a000-0000-7000-8000-000000000001';
const W2 = '0190a000-0000-7000-8000-000000000002';
const ctx: ViewContext = { today: '2026-11-18', timeZone: 'Europe/Warsaw' };

const task = (over: Partial<ViewTask> & { id: string }): ViewTask => ({
  workspaceId: W1,
  listId: 'list',
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
  createdAt: '2026-11-01T10:00:00Z',
  sortKey: '0010',
  tagIds: [],
  postponeCount: 0,
  ...over,
});

describe('przegląd dnia', () => {
  it('zaległe, potem dzisiejsze; oznaczenie przesuwanych ≥ 3 razy', () => {
    const queue = dailyReviewQueue(
      [
        task({ id: 'today', dueDate: '2026-11-18' }),
        task({ id: 'late', dueDate: '2026-11-12', postponeCount: 3 }),
        task({ id: 'done', dueDate: '2026-11-18', status: 'done', completedAt: '2026-11-18T08:00:00Z' }),
        task({ id: 'tomorrow', dueDate: '2026-11-19' }),
      ],
      ctx,
    );
    expect(queue.map((i) => `${i.section}:${i.task.id}${i.needsDecision ? '!' : ''}`)).toEqual(['overdue:late!', 'today:today']);
  });
});

describe('decyzje przeglądu', () => {
  const late = task({ id: 'late', dueDate: '2026-11-12', dueTime: '09:00', postponeCount: 1 });

  it('Dziś / Jutro / data: godzina zostaje, przesunięcie na później liczy się', () => {
    expect(reschedulePatch(late, { kind: 'today' }, ctx)).toEqual({ dueDate: '2026-11-18', postponeCount: 2 });
    expect(reschedulePatch(late, { kind: 'tomorrow' }, ctx)).toEqual({ dueDate: '2026-11-19', postponeCount: 2 });
    expect(reschedulePatch(late, { kind: 'date', date: '2026-11-10' }, ctx)).toEqual({ dueDate: '2026-11-10' });
    expect(reschedulePatch(task({ id: 'undated' }), { kind: 'today' }, ctx)).toEqual({ dueDate: '2026-11-18' });
  });

  it('zakres wielodniowy przesuwa się w całości', () => {
    const range = task({ id: 'range', startDate: '2026-11-10', dueDate: '2026-11-14' });
    expect(reschedulePatch(range, { kind: 'date', date: '2026-11-24' }, ctx)).toEqual({ dueDate: '2026-11-24', startDate: '2026-11-20', postponeCount: 1 });
  });

  it('Kiedyś czyści termin; nic do zapisania dla tego samego dnia, ukończenia, usunięcia i serii', () => {
    expect(reschedulePatch(late, { kind: 'someday' }, ctx)).toEqual({ dueDate: null, dueTime: null, startDate: null, postponeCount: 2 });
    expect(reschedulePatch(task({ id: 'x', dueDate: '2026-11-18' }), { kind: 'today' }, ctx)).toBeNull();
    expect(reschedulePatch(late, { kind: 'done' }, ctx)).toBeNull();
    expect(reschedulePatch(late, { kind: 'delete' }, ctx)).toBeNull();
    const series = task({ id: 's', dueDate: '2026-11-12', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } });
    expect(reschedulePatch(series, { kind: 'someday' }, ctx)).toBeNull();
    expect(reschedulePatch(series, { kind: 'tomorrow' }, ctx)).toEqual({ dueDate: '2026-11-19', postponeCount: 1 });
  });

  it('statystyki sesji (ostatnia decyzja przy zadaniu)', () => {
    const a = task({ id: 'a', postponeCount: 4 });
    const b = task({ id: 'b' });
    const c = task({ id: 'c' });
    const stats = reviewStats([
      { task: a, action: { kind: 'tomorrow' } },
      { task: b, action: { kind: 'someday' } },
      { task: a, action: { kind: 'done' } },
      { task: c, action: { kind: 'delete' } },
    ]);
    expect(stats).toEqual({ reviewed: 3, done: 1, rescheduled: 0, someday: 1, deleted: 1, needsDecision: 1 });
    expect(ReviewStats.parse(stats)).toEqual(stats);
    // „Dziś” przy dzisiejszym = przejrzane, nie przeniesione; „Dziś” przy zaległym = przeniesione.
    const log = [
      { task: task({ id: 'd', dueDate: '2026-11-18' }), action: { kind: 'today' } as ReviewAction },
      { task: task({ id: 'e', dueDate: '2026-11-15' }), action: { kind: 'today' } as ReviewAction },
    ];
    expect(reviewStats(log, ctx)).toMatchObject({ reviewed: 2, rescheduled: 1 });
    expect(reviewStats(log)).toMatchObject({ reviewed: 2, rescheduled: 2 });
  });
});

describe('przegląd tygodnia', () => {
  const lists: ReviewList[] = [
    { id: 'inbox', workspaceId: W1, kind: 'inbox', status: null },
    { id: 'p-next', workspaceId: W1, kind: 'project', status: 'active' },
    { id: 'p-stuck', workspaceId: W1, kind: 'project', status: 'active' },
    { id: 'p-hold', workspaceId: W1, kind: 'project', status: 'on_hold' },
    { id: 'p-archived', workspaceId: W1, kind: 'project', status: 'active', archivedAt: '2026-11-01T00:00:00Z' },
    { id: 'p-other', workspaceId: W2, kind: 'project', status: 'active' },
  ];
  const tasks = [
    task({ id: 'in1', listId: 'inbox' }),
    task({ id: 'next', listId: 'p-next', dueDate: '2026-11-22' }),
    task({ id: 'undated', listId: 'p-stuck' }),
    task({ id: 'done-dated', listId: 'p-stuck', dueDate: '2026-11-20', status: 'done' }),
    task({ id: 'late', listId: 'p-next', dueDate: '2026-11-15', postponeCount: 5 }),
    task({ id: 'wait-long', status: 'waiting', statusChangedAt: '2026-11-01T09:00:00Z' }),
    task({ id: 'wait-short', status: 'waiting', statusChangedAt: '2026-11-15T09:00:00Z' }),
    task({ id: 'wait-old', status: 'waiting', createdAt: '2026-10-01T09:00:00Z' }),
    task({ id: 'habit', kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } }),
  ];
  const completions = new Map([
    [
      'habit',
      [
        { date: '2026-11-12', kind: 'done' as const },
        { date: '2026-11-14', kind: 'skipped' as const },
        { date: '2026-11-18', kind: 'done' as const },
      ],
    ],
  ]);

  it('wszystkie kroki', () => {
    const review = weeklyReview({ tasks, lists, completions }, ctx);
    expect(review.inbox.map((t) => t.id)).toEqual(['in1']);
    expect(review.overdue.map((t) => t.id)).toEqual(['late']);
    expect(review.projectsWithoutNext.map((l) => l.id)).toEqual(['p-stuck', 'p-other']);
    expect(review.waiting.map((w) => `${w.task.id}:${w.days}`)).toEqual(['wait-old:48', 'wait-long:17']);
    expect(review.upcoming.days).toHaveLength(7);
    expect(review.upcoming.days.flatMap((d) => d.items).map((i) => i.task.id)).toEqual(['next']);
    expect(review.habits[0]!.days.map((d) => d.state)).toEqual(['done', 'missed', 'skipped', 'missed', 'missed', 'missed', 'done']);
    expect(review.needsDecision.map((t) => t.id)).toEqual(['late']);
  });

  it('tryb jednej przestrzeni', () => {
    expect(weeklyReview({ tasks, lists }, { ...ctx, workspaceId: W2 }).projectsWithoutNext.map((l) => l.id)).toEqual(['p-other']);
  });
});

describe('asystent przeglądu (Etap 9)', () => {
  const all = [
    task({ id: 'late', dueDate: '2026-11-10', dueTime: '09:00', postponeCount: 2 }),
    task({ id: 'range', startDate: '2026-11-14', dueDate: '2026-11-16' }),
    task({ id: 'series', dueDate: '2026-11-15', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } }),
  ];
  const opts = { today: ctx.today, now: new Date('2026-11-18T19:00:00Z'), timeZone: ctx.timeZone };
  const run = (id: string, action: ReviewAction) => bulkTaskOps(all.filter((t) => t.id === id), all, reviewBulkAction(action), opts);

  it('decyzje jako akcje zbiorcze: jutro z godziną i licznikiem, zakres w całości, „Kiedyś” bez godziny, cofnięcie', () => {
    expect(run('late', { kind: 'tomorrow' }).ops).toEqual([{ table: 'tasks', id: 'late', patch: { due_date: '2026-11-19', postpone_count: 3 } }]);
    expect(run('range', { kind: 'date', date: '2026-11-20' }).ops[0]!.patch).toEqual({ due_date: '2026-11-20', start_date: '2026-11-18', postpone_count: 1 });
    const someday = run('late', { kind: 'someday' });
    expect(someday.ops[0]!.patch).toEqual({ due_date: null, due_time: null, start_date: null, postpone_count: 3 });
    expect(someday.undo[0]!.patch).toEqual({ due_date: '2026-11-10', due_time: '09:00', start_date: null, postpone_count: 2 });
    expect(run('series', { kind: 'someday' }).ops).toEqual([]);
    expect(run('late', { kind: 'done' }).ops[0]!.patch).toMatchObject({ status: 'done' });
    expect(run('late', { kind: 'delete' }).ops[0]!.patch).toHaveProperty('deleted_at');
  });

  it('sesja: początek i koniec z statystykami', () => {
    const now = new Date('2026-11-18T19:00:00Z');
    expect(reviewStartOp('s1', 'daily', now)).toEqual({ table: 'review_sessions', id: 's1', patch: { kind: 'daily', started_at: now.toISOString(), finished_at: null, stats: null } });
    const stats = reviewStats([{ task: all[0]!, action: { kind: 'tomorrow' } }]);
    expect(reviewFinishOp('s1', stats, now).patch).toEqual({ finished_at: now.toISOString(), stats });
    expect(ReviewStats.parse(stats)).toEqual(stats);
  });

  it('pora przeglądu: po godzinie w strefie, raz dziennie, tygodniowy w swój dzień', () => {
    const schedule = { dailyReview: { enabled: true, time: '20:00' as const }, weeklyReview: { enabled: true, weekday: 3, time: '18:00' as const } };
    const zone = { timeZone: 'Europe/Warsaw' };
    // Środa 18.11: 18:30 w Warszawie = 17:30 UTC.
    expect(reviewsDue(schedule, new Date('2026-11-18T17:30:00Z'), zone)).toEqual(['weekly']);
    expect(reviewsDue(schedule, new Date('2026-11-18T19:05:00Z'), zone)).toEqual(['weekly', 'daily']);
    expect(reviewsDue(schedule, new Date('2026-11-18T19:05:00Z'), { ...zone, last: { daily: '2026-11-18', weekly: '2026-11-18' } })).toEqual([]);
    expect(reviewsDue(schedule, new Date('2026-11-19T19:05:00Z'), { ...zone, last: { daily: '2026-11-18' } })).toEqual(['daily']);
    expect(reviewsDue({ ...schedule, dailyReview: { enabled: false, time: '20:00' } }, new Date('2026-11-19T19:05:00Z'), zone)).toEqual([]);
  });

  it('podsumowanie dnia: ukończone dziś i plan na jutro', () => {
    const tasks = [
      task({ id: 'done-today', status: 'done', completedAt: '2026-11-18T10:00:00Z' }),
      task({ id: 'done-yesterday', status: 'done', completedAt: '2026-11-17T22:30:00Z' }),
      task({ id: 'tomorrow', dueDate: '2026-11-19' }),
      task({ id: 'today', dueDate: '2026-11-18' }),
      task({ id: 'later', dueDate: '2026-11-21' }),
      task({ id: 'other-ws', workspaceId: W2, dueDate: '2026-11-19' }),
    ];
    const summary = dailySummary(tasks, { ...ctx, workspaceId: W1 });
    expect(summary.doneToday.map((t) => t.id)).toEqual(['done-today']);
    expect(summary.tomorrow.map((t) => t.id)).toEqual(['tomorrow']);
    expect(summary.today.map((t) => t.id)).toEqual(['today']);
    expect(REVIEW_ACTION.someday).toEqual({ key: '5', label: 'Kiedyś' });
  });
});
