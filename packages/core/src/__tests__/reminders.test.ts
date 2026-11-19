/**
 * Przypomnienia (M8, §7.6): czas pływający → chwila w strefie (także przy zmianie czasu), względne
 * i bezwzględne, serie, okno 7 dni, limit, zamknięte zadania, treść powiadomienia.
 */
import { describe, expect, it } from 'vitest';

import { zonedInstant } from '../dates.ts';
import { reminderBody, reminderFireTimes, snoozeUntil, toReminderRule, type ReminderRule, type ReminderTask } from '../reminders.ts';

const WAW = 'Europe/Warsaw';
const task = (over: Partial<ReminderTask> = {}): ReminderTask => ({ id: 't1', kind: 'task', status: 'todo', title: 'Lekarz', dueDate: '2026-11-20', dueTime: '10:00', recurrence: null, ...over });
const rel = (offsetMin: number, over: Partial<ReminderRule> = {}): ReminderRule => ({ id: `r${offsetMin}`, taskId: 't1', kind: 'relative', offsetMin, atDate: null, atTime: null, ...over });
const win = { from: '2026-11-19T12:00:00Z', timeZone: WAW, defaultTime: '09:00' as const };

describe('zonedInstant', () => {
  it('zimą +1 h, latem +2 h', () => {
    expect(zonedInstant('2026-11-20', '10:00', WAW).toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(zonedInstant('2026-07-01', '10:00', WAW).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(zonedInstant('2026-11-20', '10:00', 'America/New_York').toISOString()).toBe('2026-11-20T15:00:00.000Z');
  });

  it('zmiana czasu: luka wiosną → godzinę później, podwójna godzina jesienią → pierwsza', () => {
    // 29.03.2026 02:00 → 03:00 (godziny 2:xx nie ma).
    expect(zonedInstant('2026-03-29', '02:30', WAW).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedInstant('2026-03-29', '03:30', WAW).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 25.10.2026 03:00 → 02:00 (2:30 jest dwa razy; pierwsza w czasie letnim).
    expect(zonedInstant('2026-10-25', '02:30', WAW).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(zonedInstant('2026-10-25', '04:00', WAW).toISOString()).toBe('2026-10-25T03:00:00.000Z');
  });
});

describe('reminderFireTimes', () => {
  it('względne: przed godziną terminu; bez godziny — przed domyślną godziną', () => {
    const fires = reminderFireTimes([task(), task({ id: 't2', dueTime: null })], [rel(30), rel(0, { id: 'd', taskId: 't2' })], win);
    expect(fires.map((f) => [f.key, f.fireAt])).toEqual([
      ['d:2026-11-20', '2026-11-20T08:00:00.000Z'],
      ['r30:2026-11-20', '2026-11-20T08:30:00.000Z'],
    ]);
    expect(fires[1]!.dueAt).toBe('2026-11-20T09:00:00.000Z');
  });

  it('bezwzględne raz, w strefie; przeszłe i poza oknem pomijane', () => {
    const abs: ReminderRule = { id: 'a', taskId: 't1', kind: 'absolute', offsetMin: null, atDate: '2026-11-19', atTime: '20:00' };
    const past: ReminderRule = { ...abs, id: 'p', atTime: '08:00' };
    const far: ReminderRule = { ...abs, id: 'f', atDate: '2026-11-30' };
    expect(reminderFireTimes([task()], [abs, past, far], win).map((f) => [f.key, f.fireAt])).toEqual([['a:2026-11-19', '2026-11-19T19:00:00.000Z']]);
  });

  it('seria według harmonogramu: każde wystąpienie w oknie; po ukończeniu — tylko bieżące', () => {
    const daily = task({ dueDate: '2026-11-19', dueTime: '18:00', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } });
    const fires = reminderFireTimes([daily], [rel(15)], win);
    expect(fires).toHaveLength(7);
    expect(fires[0]!.occurrenceDate).toBe('2026-11-19');
    expect(fires.at(-1)!.occurrenceDate).toBe('2026-11-25');
    const after = task({ recurrence: { mode: 'after_completion', every: { unit: 'day', n: 1 } } });
    expect(reminderFireTimes([after], [rel(15)], win)).toHaveLength(1);
  });

  it('zaległa seria przypomina o kolejnych wystąpieniach (bez przeglądania lat wstecz)', () => {
    const old = task({ dueDate: '2024-01-01', dueTime: '08:00', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2024-01-01' } });
    const fires = reminderFireTimes([old], [rel(0)], win);
    expect(fires[0]!.occurrenceDate).toBe('2026-11-20');
    expect(fires).toHaveLength(7);
  });

  it('zamknięte zadania i usunięte reguły bez przypomnień; limit i kolejność', () => {
    expect(reminderFireTimes([task({ status: 'done' })], [rel(30)], win)).toEqual([]);
    expect(reminderFireTimes([task()], [rel(30, { taskId: 'inne' })], win)).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => task({ id: `t${i}`, dueTime: `${String(10 + (i % 10)).padStart(2, '0')}:00` }));
    const fires = reminderFireTimes(many, many.map((t) => rel(0, { id: `r-${t.id}`, taskId: t.id })), { ...win, limit: 50 });
    expect(fires).toHaveLength(50);
    expect([...fires].sort((a, b) => a.fireAt.localeCompare(b.fireAt))).toEqual(fires);
  });

  it('strefa przypięta do zadania wygrywa ze strefą urządzenia', () => {
    const ny = task({ timeZone: 'America/New_York' });
    expect(reminderFireTimes([ny], [rel(0)], win)[0]!.fireAt).toBe('2026-11-20T15:00:00.000Z');
  });

  it('te same dane → te same klucze (przeplanowanie bez duplikatów)', () => {
    const a = reminderFireTimes([task()], [rel(30), rel(60)], win).map((f) => f.key);
    const b = reminderFireTimes([task()], [rel(60), rel(30)], { ...win, from: '2026-11-19T13:00:00Z' }).map((f) => f.key);
    expect(b).toEqual(a);
  });
});

describe('treść i odłożenie', () => {
  const fire = { occurrenceDate: '2026-11-20' as const, dueAt: '2026-11-20T09:00:00.000Z' };
  it('za N min / termin minął / dzień i godzina', () => {
    expect(reminderBody(task(), fire, '2026-11-20T08:30:00Z', WAW).body).toBe('Za 30 min (10:00)');
    expect(reminderBody(task(), fire, '2026-11-20T09:15:00Z', WAW).body).toBe('Termin minął 15 min temu');
    expect(reminderBody(task(), fire, '2026-11-19T19:00:00Z', WAW).body).toBe('Termin: jutro 10:00');
    expect(reminderBody(task({ dueTime: null }), fire, '2026-11-20T07:00:00Z', WAW).body).toBe('Termin: dziś');
  });
  it('odłożenie i wiersz z bazy', () => {
    expect(snoozeUntil('2026-11-20T08:30:00Z', 10)).toBe('2026-11-20T08:40:00.000Z');
    expect(toReminderRule({ id: 'x', task_id: 't', kind: 'absolute', offset_min: null, at_date: '2026-11-20', at_time: '08:00:00' })).toEqual({ id: 'x', taskId: 't', kind: 'absolute', offsetMin: null, atDate: '2026-11-20', atTime: '08:00' });
  });
});

describe('nawyki (Etap 8)', () => {
  const habit = task({ id: 'h', kind: 'habit', title: 'Woda', dueDate: null, dueTime: null, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' }, habit: { time: '07:30', target: 8, unit: 'szklanek' } });
  const rule = rel(0, { id: 'hr', taskId: 'h' });

  it('każdy dzień reguły o porze nawyku; bez pory — domyślna godzina; dni zaliczone i wolne pominięte', () => {
    const all = reminderFireTimes([habit], [rule], { ...win, to: '2026-11-22T12:00:00Z' });
    expect(all.map((f) => [f.key, f.fireAt])).toEqual([
      ['hr:2026-11-20', '2026-11-20T06:30:00.000Z'],
      ['hr:2026-11-21', '2026-11-21T06:30:00.000Z'],
      ['hr:2026-11-22', '2026-11-22T06:30:00.000Z'],
    ]);
    const noTime = reminderFireTimes([{ ...habit, habit: null }], [rel(15, { id: 'hr', taskId: 'h' })], { ...win, to: '2026-11-21T12:00:00Z' });
    expect(noTime.map((f) => f.fireAt)).toEqual(['2026-11-20T07:45:00.000Z', '2026-11-21T07:45:00.000Z']);
    const done = new Map([['h', [{ date: '2026-11-20', kind: 'done' as const, value: 8 }, { date: '2026-11-21', kind: 'skipped' as const }, { date: '2026-11-22', kind: 'done' as const, value: 3 }]]]);
    expect(reminderFireTimes([habit], [rule], { ...win, to: '2026-11-22T12:00:00Z', habitCompletions: done }).map((f) => f.key)).toEqual(['hr:2026-11-22']);
  });

  it('bezwzględne i zamknięte nawyki nie przypominają; treść z celem', () => {
    expect(reminderFireTimes([habit], [{ ...rule, kind: 'absolute', offsetMin: null, atDate: '2026-11-20', atTime: '10:00' }], win)).toEqual([]);
    expect(reminderFireTimes([{ ...habit, status: 'cancelled' }], [rule], win)).toEqual([]);
    const [fire] = reminderFireTimes([habit], [rule], win);
    expect(reminderBody(habit, fire!, '2026-11-20T06:30:00Z', WAW)).toEqual({ title: 'Woda', body: 'Nawyk na dziś · cel 8 szklanek' });
    expect(reminderBody({ ...habit, habit: null }, fire!, '2026-11-20T06:30:00Z', WAW).body).toBe('Nawyk na dziś — odhacz, gdy zrobisz');
  });
});
