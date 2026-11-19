/**
 * Time-blocking (M11, §7.4): plan dnia, konflikty zadań z wydarzeniami, wolne okna w godzinach pracy,
 * łatki przeciągania. Strefa Warszawa, czwartek 19.11.2026.
 */
import { describe, expect, it } from 'vitest';

import {
  blocksForDay,
  conflictIds,
  conflicts,
  freeSlots,
  minutesToTime,
  resizeBlockPatch,
  scheduleBlockPatch,
  snapMinutes,
  unscheduleBlockPatch,
  type BlockTask,
  type CalendarEventLike,
} from '../time-blocking.ts';

const WAW = 'Europe/Warsaw';
const DAY = '2026-11-19';
const task = (id: string, over: Partial<BlockTask> = {}): BlockTask => ({ id, title: id, status: 'todo', dueDate: DAY, dueTime: '09:00', durationMin: 60, priority: 4, recurrence: null, ...over });
// 10:00–11:00 i 12:30–13:00 czasu warszawskiego (UTC+1).
const events: CalendarEventLike[] = [
  { id: 'e1', title: 'Spotkanie', allDay: false, startAt: '2026-11-19T09:00:00Z', endAt: '2026-11-19T10:00:00Z' },
  { id: 'e2', title: 'Lunch', allDay: false, startAt: '2026-11-19T11:30:00Z', endAt: '2026-11-19T12:00:00Z', busy: false },
  { id: 'e3', title: 'Urlop', allDay: true, startDate: '2026-11-18', endDate: '2026-11-20' },
  { id: 'e4', title: 'Wczoraj', allDay: false, startAt: '2026-11-18T09:00:00Z', endAt: '2026-11-18T10:00:00Z' },
];

describe('blocksForDay', () => {
  it('zadania z godziną jako bloki, bez godziny i całodniowe osobno, wydarzenia z innego dnia pominięte', () => {
    const plan = blocksForDay([task('a'), task('b', { dueTime: null }), task('c', { dueTime: '10:30', durationMin: null }), task('x', { dueDate: '2026-11-20' })], events, DAY, { timeZone: WAW });
    expect(plan.dayMinutes).toBe(1440);
    expect(plan.timed.map((b) => [b.id, b.startMin, b.endMin])).toEqual([
      ['a', 540, 600],
      ['e1', 600, 660],
      ['c', 630, 660],
      ['e2', 750, 780],
    ]);
    expect(plan.allDay.map((i) => i.id)).toEqual(['b', 'e3']);
  });

  it('seria: przyszłe wystąpienie jako blok wirtualny; zmiana czasu — doba 25 h', () => {
    const weekly = task('w', { dueDate: '2026-11-12', dueTime: '08:00', recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=TH', anchor: '2026-11-05' } });
    const block = blocksForDay([weekly], [], DAY, { timeZone: WAW }).timed[0]!;
    expect(block).toMatchObject({ id: 'w', startMin: 480, virtual: true });
    expect(blocksForDay([], [], '2026-10-25', { timeZone: WAW }).dayMinutes).toBe(1500);
    // 04:00 w dniu zmiany czasu to 300 min od północy (doba ma 25 h).
    expect(blocksForDay([task('d', { dueDate: '2026-10-25', dueTime: '04:00' })], [], '2026-10-25', { timeZone: WAW }).timed[0]!.startMin).toBe(300);
  });
});

describe('konflikty i wolne okna', () => {
  const plan = blocksForDay([task('a', { dueTime: '09:30' }), task('b', { dueTime: '12:30', durationMin: 30 }), task('done', { dueTime: '10:15', status: 'done' }), task('c', { dueTime: '15:00', durationMin: 30 })], events, DAY, { timeZone: WAW });

  it('zadanie na spotkaniu — konflikt; „wolny” i ukończone — nie', () => {
    const list = conflicts(plan.timed);
    expect(list.map((c) => [c.a.id, c.b.id, c.overlapMin])).toEqual([['a', 'e1', 30]]);
    expect([...conflictIds(list)].sort()).toEqual(['a', 'e1']);
  });

  it('wolne okna w godzinach pracy, nie krótsze niż minimum', () => {
    const work = { days: [1, 2, 3, 4, 5], start: '09:00' as const, end: '17:00' as const };
    // Zajęte: 9:30–10:30 (a), 10:00–11:00 (e1), 12:30–13:00 (b), 15:00–15:30 (c).
    expect(freeSlots(plan, work, { timeZone: WAW }).map((s) => [minutesToTime(s.startMin), minutesToTime(s.endMin)])).toEqual([
      ['09:00', '09:30'],
      ['11:00', '12:30'],
      ['13:00', '15:00'],
      ['15:30', '17:00'],
    ]);
    expect(freeSlots(plan, work, { timeZone: WAW, minMinutes: 60 }).map((s) => minutesToTime(s.startMin))).toEqual(['11:00', '13:00', '15:30']);
    expect(freeSlots({ ...plan, date: '2026-11-21' }, work, { timeZone: WAW })).toEqual([]);
  });
});

describe('przeciąganie', () => {
  it('na godzinę: termin, godzina, czas trwania; zaokrąglenie do 15 min', () => {
    expect(scheduleBlockPatch({ startDate: null, durationMin: null }, DAY, snapMinutes(607))).toEqual({ due_date: DAY, due_time: '10:00', duration_min: 30 });
    expect(scheduleBlockPatch({ startDate: '2026-11-25', durationMin: 90 }, DAY, 840)).toEqual({ due_date: DAY, due_time: '14:00', duration_min: 90, start_date: DAY });
    expect(resizeBlockPatch(600, 602)).toEqual({ duration_min: 5 });
    expect(unscheduleBlockPatch()).toEqual({ due_time: null });
    expect(minutesToTime(-30)).toBe('23:30');
  });
});
