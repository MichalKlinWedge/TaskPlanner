/**
 * Etap 8: statystyki nawyków (M15) na 90-dniowych historiach z `fixtures/habits-90.json` (wyniki
 * policzone ręcznie) oraz odhaczanie wstecz, dni wolne, cele ilościowe i formularz nawyku.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { addDays } from '../dates.ts';
import {
  addHabitValue,
  canEditHabitDay,
  describeHabit,
  habitDayCounts,
  habitDays,
  habitDayStatus,
  habitDraft,
  habitEnded,
  habitEndDate,
  habitEntryOps,
  habitFields,
  habitMonthly,
  habitNeedsReminder,
  habitProgressLabel,
  habitSaveOps,
  habitsForDay,
  habitSlots,
  habitStats,
  habitStripHint,
  habitValueEntry,
  habitWeeks,
  habitYear,
  habitYearRange,
  nextHabitEntry,
  toHabit,
  toHabitCompletion,
  type Habit,
  type HabitCompletion,
} from '../habits.ts';
import { completionId } from '../ids.ts';
import { MODEL } from '../schemas/model.ts';
import type { ViewTask } from '../views.ts';
import { occurrences } from '../recurrence.ts';

type Run = [string | number, number];
interface Case {
  name: string;
  habit: Habit;
  history:
    | { runs: Run[] }
    | { scheduled: { from: string; to: string; missed: string[]; skipped: string[]; extra: string[] } }
    | { done: string[]; skipped: string[] };
  expect: {
    streak: { current: number; best: number };
    rates: Record<'7' | '30' | '90', [number, number]>;
    days: Record<string, number>;
    weeks: [string, number, number | null, number][];
    total: [number, number];
  };
}

const fixture = JSON.parse(readFileSync(new URL('../../../../fixtures/habits-90.json', import.meta.url), 'utf8')) as { today: string; from: string; cases: Case[] };
const { today, from } = fixture;

/** Historia z fixture → wpisy `task_completions`. */
function history(c: Case): HabitCompletion[] {
  const h = c.history;
  if ('runs' in h) {
    const out: HabitCompletion[] = [];
    let date = from;
    for (const [mark, n] of h.runs) {
      for (let i = 0; i < n; i++, date = addDays(date, 1)) {
        if (mark === 'x') out.push({ date, kind: 'done' });
        else if (mark === 's') out.push({ date, kind: 'skipped' });
        else if (typeof mark === 'number') out.push({ date, kind: 'done', value: mark });
      }
    }
    expect(date).toBe(addDays(today, 1));
    return out;
  }
  if ('scheduled' in h) {
    const s = h.scheduled;
    const out = occurrences(c.habit.recurrence, { from: s.from, to: s.to, limit: 500 })
      .filter((date) => !s.missed.includes(date))
      .map((date): HabitCompletion => ({ date, kind: s.skipped.includes(date) ? 'skipped' : 'done' }));
    return [...out, ...s.extra.map((date): HabitCompletion => ({ date, kind: 'done' }))];
  }
  return [...h.done.map((date): HabitCompletion => ({ date, kind: 'done' })), ...h.skipped.map((date): HabitCompletion => ({ date, kind: 'skipped' }))];
}

describe('Etap 8: statystyki na 90-dniowych historiach policzonych ręcznie', () => {
  it('okno 90 dni zaczyna się 21.08', () => expect(addDays(today, -89)).toBe(from));

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const completions = history(c);
    const stats = habitStats(c.habit, completions, today);
    expect({ current: stats.streak.current, best: stats.streak.best }).toEqual(c.expect.streak);
    expect({
      7: [stats.rates[7].done, stats.rates[7].possible],
      30: [stats.rates[30].done, stats.rates[30].possible],
      90: [stats.rates[90].done, stats.rates[90].possible],
    }).toEqual(c.expect.rates);
    for (const w of [7, 30, 90] as const) {
      const r = stats.rates[w];
      expect(r.rate).toBe(r.possible ? r.done / r.possible : null);
    }
    expect(habitDayCounts(habitDays(c.habit, completions, from, today, today))).toEqual(c.expect.days);
    const weeks = habitWeeks(c.habit, completions, today, c.expect.weeks.length);
    expect(weeks.map((w) => [w.start, w.done, w.target, w.value])).toEqual(c.expect.weeks);
    expect([stats.totalDone, stats.totalValue]).toEqual(c.expect.total);
  });

  it('mapa cieplna roku: 53 tygodnie pon–ndz, ostatnia kolumna z dziś, przyszłe dni puste', () => {
    const c = fixture.cases[0]!;
    const year = habitYear(c.habit, history(c), today);
    expect(year.weeks).toHaveLength(53);
    expect(year.weeks.every((w) => w.length === 7)).toBe(true);
    const last = year.weeks.at(-1)!;
    expect(last[0]!.date).toBe('2026-11-16');
    expect(last.map((d) => d.future)).toEqual([false, false, false, true, true, true, true]);
    expect(year.weeks[0]![0]!.date).toBe('2025-11-17');
    // Ostatnie 365 dni: przed 21.08 nawyku nie było (neutralne).
    expect(year.counts).toEqual({ done: 84, partial: 0, skipped: 2, missed: 3, pending: 1, off: 275 });
    // 1.11 to niedziela — należy do tygodnia 26.10 (kolumna 49; 52 = 16.11).
    expect(year.months.at(-1)).toEqual({ column: 49, month: 11 });
    expect(last.map((d) => d.planned)).toEqual(last.map((d) => d.future && c.habit.goal === undefined && occurrences(c.habit.recurrence, { from: d.date, to: d.date, limit: 1 }).length > 0));
  });

  it('mapa roku naprzód: zaplanowane dni według reguły do końca nawyku; przy celu „N razy” bez planu', () => {
    const mwf: Habit = { recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261127', anchor: '2026-11-02' } };
    const year = habitYear(mwf, [], today, { ahead: 2 });
    expect(year.weeks).toHaveLength(55);
    expect(year.weeks.flat().filter((d) => d.planned).map((d) => d.date)).toEqual(['2026-11-20', '2026-11-23', '2026-11-25', '2026-11-27']);
    expect(year.weeks.at(-3)!.map((d) => d.future)).toEqual([false, false, false, true, true, true, true]);
    expect(habitYear({ ...thrice }, [], today, { ahead: 2 }).weeks.flat().some((d) => d.planned)).toBe(false);
  });

  it('rok kalendarzowy: tygodnie od 1.01 do 31.12, dni spoza roku puste, zaplanowane do końca roku, liczniki z tego roku', () => {
    const mwf: Habit = { recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', anchor: '2026-11-02' } };
    const y = habitYear(mwf, [{ date: '2026-11-02', kind: 'done' }], today, { year: 2026 });
    // 1.01.2026 = czwartek, 31.12.2026 = czwartek → 53 kolumny od 29.12.2025 do 3.01.2027.
    expect(y.weeks).toHaveLength(53);
    expect(y.weeks[0]!.map((d) => d.outside)).toEqual([true, true, true, false, false, false, false]);
    expect(y.weeks.at(-1)!.map((d) => d.outside)).toEqual([false, false, false, false, true, true, true]);
    expect(y.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const planned = y.weeks.flat().filter((d) => d.planned).map((d) => d.date);
    expect([planned[0], planned.at(-1), planned.length]).toEqual(['2026-11-20', '2026-12-30', 18]);
    expect(y.counts.done).toBe(1);
    const next = habitYear(mwf, [], today, { year: 2027 });
    expect(next.weeks.flat().filter((d) => d.planned && d.date.startsWith('2027-01')).length).toBe(13);
    expect(next.weeks[0]![0]!.planned).toBe(false);
    expect(habitYear(mwf, [], today, { year: 2025 }).weeks.flat().some((d) => d.planned || d.state !== 'off')).toBe(false);
  });

  it('zakres lat: od początku albo najstarszego wpisu, do przyszłego roku albo roku końca', () => {
    expect(habitYearRange(daily, [], today)).toEqual({ min: 2026, max: 2027 });
    expect(habitYearRange(daily, [{ date: '2024-05-01', kind: 'done' }], today)).toEqual({ min: 2024, max: 2027 });
    expect(habitYearRange({ recurrence: { ...daily.recurrence, rrule: 'FREQ=DAILY;UNTIL=20261231' } }, [], today)).toEqual({ min: 2026, max: 2026 });
    expect(habitYearRange({ recurrence: { ...daily.recurrence, rrule: 'FREQ=DAILY;UNTIL=20290101' } }, [], today)).toEqual({ min: 2026, max: 2029 });
  });
});

const daily: Habit = { recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } };
const glasses: Habit = { ...daily, target: 8, unit: 'szklanek' };
const thrice: Habit = { ...daily, goal: { period: 'week', times: 3 } };
const NOW = '2026-11-18T19:00:00Z';

describe('Etap 8: odhaczanie', () => {
  it('wstecz najwyżej 7 dni i nie przed początkiem nawyku', () => {
    expect(canEditHabitDay(daily, '2026-11-11', today)).toBe(true);
    expect(canEditHabitDay(daily, '2026-11-10', today)).toBe(false);
    expect(canEditHabitDay(daily, '2026-11-19', today)).toBe(false);
    expect(canEditHabitDay({ ...daily, recurrence: { ...daily.recurrence, anchor: '2026-11-15' } }, '2026-11-14', today)).toBe(false);
    expect(() => habitEntryOps(daily, 'h', '2026-11-10', { kind: 'done' }, { now: NOW, today })).toThrow('najwyżej 7 dni');
    expect(() => habitEntryOps(daily, 'h', '2026-11-19', { kind: 'done' }, { now: NOW, today })).toThrow('nie nadszedł');
  });

  it('wpis z id deterministycznym; „Cofnij” przywraca poprzedni stan albo usuwa', () => {
    const id = completionId('h', '2026-11-15');
    const fresh = habitEntryOps(glasses, 'h', '2026-11-15', { kind: 'done', value: 8 }, { now: NOW, today });
    expect(fresh.ops).toEqual([{ table: 'task_completions', id, patch: { task_id: 'h', occurrence_date: '2026-11-15', kind: 'done', value: 8, completed_at: '2026-11-18T19:00:00.000Z', deleted_at: null } }]);
    expect(fresh.undo).toEqual([{ table: 'task_completions', id, patch: { deleted_at: '2026-11-18T19:00:00.000Z' } }]);

    const skip = habitEntryOps(glasses, 'h', '2026-11-15', { kind: 'skipped' }, { now: NOW, today, previous: { date: '2026-11-15', kind: 'done', value: 5 } });
    expect(skip.ops[0]!.patch).toMatchObject({ kind: 'skipped', value: null, deleted_at: null });
    expect(skip.undo[0]!.patch).toMatchObject({ kind: 'done', value: 5, deleted_at: null });

    const clear = habitEntryOps(glasses, 'h', '2026-11-15', null, { now: NOW, today });
    expect(clear.ops).toEqual([{ table: 'task_completions', id, patch: { deleted_at: '2026-11-18T19:00:00.000Z' } }]);
  });

  it('klik w dzień: brak → zrobione (z celem) → wolne → brak; „+1” do celu ilościowego', () => {
    expect(nextHabitEntry(glasses, null)).toEqual({ kind: 'done', value: 8 });
    expect(nextHabitEntry(daily, null)).toEqual({ kind: 'done', value: null });
    expect(nextHabitEntry(daily, { date: today, kind: 'done' })).toEqual({ kind: 'skipped' });
    expect(nextHabitEntry(daily, { date: today, kind: 'skipped' })).toBeNull();
    expect(addHabitValue(glasses, null, 1)).toEqual({ kind: 'done', value: 1 });
    expect(addHabitValue(glasses, { date: today, kind: 'done', value: 3 }, 1)).toEqual({ kind: 'done', value: 4 });
    expect(addHabitValue(glasses, { date: today, kind: 'done', value: null }, -1)).toEqual({ kind: 'done', value: 7 });
    expect(addHabitValue(glasses, { date: today, kind: 'done', value: 1 }, -1)).toBeNull();
    expect(addHabitValue(glasses, { date: today, kind: 'skipped' }, 1)).toEqual({ kind: 'done', value: 1 });
  });

  it('wpisana wartość dnia: przecinek lub kropka, puste / 0 czyści, błędne pole = undefined', () => {
    expect(habitValueEntry('2,5')).toEqual({ kind: 'done', value: 2.5 });
    expect(habitValueEntry(' 1.25 ')).toEqual({ kind: 'done', value: 1.25 });
    expect(habitValueEntry('3')).toEqual({ kind: 'done', value: 3 });
    expect(habitValueEntry(',5')).toEqual({ kind: 'done', value: 0.5 });
    expect(habitValueEntry('1.234')).toEqual({ kind: 'done', value: 1.23 });
    expect(habitValueEntry('')).toBeNull();
    expect(habitValueEntry('0')).toBeNull();
    expect(habitValueEntry('-1')).toBeUndefined();
    expect(habitValueEntry('abc')).toBeUndefined();
    expect(habitValueEntry('1,5 km')).toBeUndefined();
    expect(habitStripHint(glasses, 'Kliknij')).toContain('wpisać wartość');
    expect(habitStripHint(daily, 'Dotknij')).toContain('zrobione → dzień wolny → wyczyść');
  });

  it('stan dnia: postęp celu ilościowego i okresu „N razy”', () => {
    const c: HabitCompletion[] = [
      { date: '2026-11-16', kind: 'done' },
      { date: '2026-11-18', kind: 'done', value: 3 },
    ];
    const g = habitDayStatus(glasses, c, today, today);
    expect(g).toMatchObject({ state: 'partial', value: 3, scheduled: true, period: null });
    expect(habitProgressLabel(glasses, g)).toBe('3 / 8 szklanek');
    const t = habitDayStatus(thrice, c, today, today);
    expect(t.period).toEqual({ start: '2026-11-16', end: '2026-11-22', done: 2, times: 3, state: 'pending' });
    expect(habitProgressLabel(thrice, t)).toBe('2 / 3 w tym tygodniu');
    expect(habitDayStatus(daily, [], '2026-11-17', today).state).toBe('missed');
  });

  it('przypomnienie: nie po zrobieniu, dniu wolnym ani po osiągnięciu celu tygodnia; częściowo — tak', () => {
    expect(habitNeedsReminder(daily, [], today)).toBe(true);
    expect(habitNeedsReminder(daily, [{ date: today, kind: 'done' }], today)).toBe(false);
    expect(habitNeedsReminder(daily, [{ date: today, kind: 'skipped' }], today)).toBe(false);
    expect(habitNeedsReminder(glasses, [{ date: today, kind: 'done', value: 3 }], today)).toBe(true);
    const week = ['2026-11-16', '2026-11-17'].map((date): HabitCompletion => ({ date, kind: 'done' }));
    expect(habitNeedsReminder(thrice, week, today)).toBe(true);
    expect(habitNeedsReminder(thrice, [...week, { date: '2026-11-15', kind: 'done' }], today)).toBe(true);
    expect(habitNeedsReminder(thrice, [...week, { date: '2026-11-18', kind: 'done' }], '2026-11-19')).toBe(false);
  });

  it('wiersz bazy → wpis', () => {
    expect(toHabitCompletion({ occurrence_date: '2026-11-18', kind: 'done', value: '3.5' })).toEqual({ date: '2026-11-18', kind: 'done', value: 3.5 });
    expect(toHabitCompletion({ occurrence_date: '2026-11-18', kind: 'skipped', value: null })).toEqual({ date: '2026-11-18', kind: 'skipped', value: null });
    expect(toHabit({ recurrence: { mode: 'after_completion', every: { unit: 'day', n: 1 } }, habit: null })).toBeNull();
  });
});

describe('Etap 8: formularz nawyku', () => {
  const roundTrip = (draft: Parameters<typeof habitFields>[0]) => habitDraft(habitFields(draft), today);

  it('codziennie / wybrane dni / N razy / reguła spoza formularza — tam i z powrotem', () => {
    const base = { start: '2026-11-18', target: null, unit: null, time: null };
    expect(habitFields({ ...base, schedule: { kind: 'daily' } })).toEqual({ recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-18' }, habit: {} });
    expect(habitFields({ ...base, schedule: { kind: 'days', days: [5, 1, 3] } }).recurrence.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(habitFields({ ...base, schedule: { kind: 'days', days: [1, 2, 3, 4, 5, 6, 7] } }).recurrence.rrule).toBe('FREQ=DAILY');
    expect(roundTrip({ ...base, schedule: { kind: 'days', days: [1, 3, 5] } }).schedule).toEqual({ kind: 'days', days: [1, 3, 5] });
    expect(roundTrip({ ...base, schedule: { kind: 'goal', period: 'month', times: 10 }, target: 8, unit: ' szklanek ', time: '07:30' })).toEqual({
      ...base,
      end: { kind: 'never' },
      schedule: { kind: 'goal', period: 'month', times: 10 },
      target: 8,
      unit: 'szklanek',
      time: '07:30',
    });
    expect(habitDraft({ recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;INTERVAL=2', anchor: '2026-11-01' }, habit: null }, today).schedule).toEqual({ kind: 'custom', rrule: 'FREQ=DAILY;INTERVAL=2' });
    expect(habitDraft(null, today)).toEqual({ ...base, end: { kind: 'never' }, schedule: { kind: 'daily' } });
  });

  it('koniec: w dniu (UNTIL) albo po N razach (COUNT) — tam i z powrotem', () => {
    const base = { start: '2026-11-18', target: null, unit: null, time: null };
    const until = habitFields({ ...base, schedule: { kind: 'days', days: [1, 3, 5] }, end: { kind: 'until', date: '2026-12-31' } });
    expect(until.recurrence.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231');
    expect(habitDraft(until, today)).toMatchObject({ schedule: { kind: 'days', days: [1, 3, 5] }, end: { kind: 'until', date: '2026-12-31' } });
    const count = habitFields({ ...base, schedule: { kind: 'daily' }, end: { kind: 'count', n: 30 } });
    expect(count.recurrence.rrule).toBe('FREQ=DAILY;COUNT=30');
    expect(habitDraft(count, today)).toMatchObject({ schedule: { kind: 'daily' }, end: { kind: 'count', n: 30 } });
    const goal = habitFields({ ...base, schedule: { kind: 'goal', period: 'week', times: 3 }, end: { kind: 'until', date: '2026-12-06' } });
    expect(goal.recurrence.rrule).toBe('FREQ=DAILY;UNTIL=20261206');
    expect(habitDraft(goal, today)).toMatchObject({ schedule: { kind: 'goal', period: 'week', times: 3 }, end: { kind: 'until', date: '2026-12-06' } });
    // Własna reguła: koniec z pola „Koniec”, nie z reguły.
    const custom = habitDraft({ recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;INTERVAL=2;COUNT=10', anchor: '2026-11-01' }, habit: null }, today);
    expect(custom).toMatchObject({ schedule: { kind: 'custom', rrule: 'FREQ=DAILY;INTERVAL=2' }, end: { kind: 'count', n: 10 } });
    expect(habitFields({ ...custom, end: { kind: 'never' } }).recurrence.rrule).toBe('FREQ=DAILY;INTERVAL=2');
  });

  it('co miesiąc: dzień miesiąca, N-ty dzień tygodnia, ostatni (roboczy) dzień — tam i z powrotem', () => {
    const base = { start: '2026-12-10', target: null, unit: null, time: null };
    expect(habitMonthly('2026-12-10')).toEqual({ kind: 'monthly', by: 'day', day: 10, nth: 2, weekday: 'TH' });
    const cases: [Parameters<typeof habitFields>[0]['schedule'], string, string, string[]][] = [
      [habitMonthly('2026-12-10'), 'FREQ=MONTHLY;BYMONTHDAY=10', '10. dnia miesiąca', ['2026-12-10', '2027-01-10', '2027-02-10']],
      [{ kind: 'monthly', by: 'weekday', day: 10, nth: 1, weekday: 'MO' }, 'FREQ=MONTHLY;BYDAY=1MO', 'pierwszy poniedziałek miesiąca', ['2027-01-04', '2027-02-01', '2027-03-01']],
      [{ kind: 'monthly', by: 'weekday', day: 10, nth: 3, weekday: 'TU' }, 'FREQ=MONTHLY;BYDAY=3TU', 'trzeci wtorek miesiąca', ['2026-12-15', '2027-01-19', '2027-02-16']],
      [{ kind: 'monthly', by: 'last_workday', day: 10, nth: 2, weekday: 'TH' }, 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'ostatniego dnia roboczego miesiąca', ['2026-12-31', '2027-01-29', '2027-02-26']],
      // 31. dnia — krótsze miesiące bez wystąpienia.
      [{ kind: 'monthly', by: 'day', day: 31, nth: 2, weekday: 'TH' }, 'FREQ=MONTHLY;BYMONTHDAY=31', '31. dnia miesiąca', ['2026-12-31', '2027-01-31', '2027-03-31']],
    ];
    for (const [schedule, rrule, text, next] of cases) {
      const f = habitFields({ ...base, schedule, end: { kind: 'count', n: 12 } });
      expect(f.recurrence).toEqual({ mode: 'schedule', rrule: `${rrule};COUNT=12`, anchor: '2026-12-10' });
      expect(habitDraft(f, today)).toMatchObject({ schedule, end: { kind: 'count', n: 12 } });
      expect(describeHabit({ recurrence: { ...f.recurrence, rrule } })).toBe(text);
      expect(occurrences(f.recurrence, { limit: 3 })).toEqual(next);
    }
    expect(() => habitFields({ ...base, schedule: { kind: 'monthly', by: 'day', day: 32, nth: 1, weekday: 'MO' } })).toThrow('od 1 do 31');
    // Kilka dni miesiąca albo co 2 miesiące — własna reguła.
    expect(habitDraft({ recurrence: { mode: 'schedule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15', anchor: '2026-12-01' }, habit: null }, today).schedule.kind).toBe('custom');
    expect(habitDraft({ recurrence: { mode: 'schedule', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1', anchor: '2026-12-01' }, habit: null }, today).schedule.kind).toBe('custom');
  });

  it('koniec: błędy', () => {
    const base = { start: '2026-11-18', target: null, unit: null, time: null };
    expect(() => habitFields({ ...base, schedule: { kind: 'daily' }, end: { kind: 'until', date: '2026-11-17' } })).toThrow('przed początkiem');
    expect(() => habitFields({ ...base, schedule: { kind: 'daily' }, end: { kind: 'count', n: 0 } })).toThrow('od 1 do 999');
    expect(() => habitFields({ ...base, schedule: { kind: 'goal', period: 'week', times: 3 }, end: { kind: 'count', n: 5 } })).toThrow('koniec ustaw datą');
  });

  it('koniec: ostatni dzień, opis, okresy i dni po końcu', () => {
    const count: Habit = { recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4', anchor: '2026-11-02' } };
    expect(habitEndDate(count)).toBe('2026-11-09');
    expect(habitEndDate(daily)).toBeNull();
    expect(habitEnded(count, '2026-11-10')).toBe(true);
    expect(habitEnded(count, '2026-11-09')).toBe(false);
    expect(describeHabit(count)).toBe('pon, śr, pt, 4 razy');
    const goal: Habit = { recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;UNTIL=20261108', anchor: '2026-11-02' }, goal: { period: 'week', times: 2 } };
    expect(describeHabit(goal)).toBe('2 razy w tygodniu, do 8.11.2026');
    // Po końcu nie ma nowych okresów ani dni do odhaczenia; zaległy okres przed końcem = nieudany.
    const weeks = habitWeeks(goal, [{ date: '2026-11-03', kind: 'done' }], today);
    expect(weeks.slice(-3).map((w) => [w.start, w.done, w.target])).toEqual([
      ['2026-11-02', 1, 2],
      ['2026-11-09', 0, 0],
      ['2026-11-16', 0, 0],
    ]);
    const open = { ...goal, recurrence: { ...goal.recurrence, rrule: 'FREQ=DAILY' } };
    expect(habitDayStatus(open, [], today, today).state).not.toBe('off');
    expect(habitDayStatus(goal, [], today, today).state).toBe('off');
    expect(habitNeedsReminder(goal, [], '2026-11-12')).toBe(false);
  });

  it('błędy formularza', () => {
    const base = { start: '2026-11-18', target: null, unit: null, time: null };
    expect(() => habitFields({ ...base, schedule: { kind: 'days', days: [] } })).toThrow('co najmniej jeden dzień');
    expect(() => habitFields({ ...base, schedule: { kind: 'goal', period: 'week', times: 8 } })).toThrow('od 1 do 7');
    expect(() => habitFields({ ...base, schedule: { kind: 'daily' }, target: 0 })).toThrow('większy od zera');
  });

  it('opis nawyku', () => {
    expect(describeHabit(daily)).toBe('codziennie');
    expect(describeHabit(glasses)).toBe('codziennie · cel 8 szklanek');
    expect(describeHabit(thrice)).toBe('3 razy w tygodniu');
    expect(describeHabit({ ...daily, goal: { period: 'month', times: 1 } })).toBe('1 raz w miesiącu');
    expect(describeHabit({ recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', anchor: '2026-11-02' } })).toBe('pon, śr, pt');
    expect(describeHabit({ recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', anchor: '2026-11-02' } })).toBe('w dni robocze');
  });
});

describe('Etap 8: zapis nawyku i blok „Dziś”', () => {
  const ids = ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002'];
  const draft = { schedule: { kind: 'goal' as const, period: 'week' as const, times: 3 }, start: '2026-11-18', target: 8, unit: 'szklanek', time: '07:30' as const };
  const L = '00000000-0000-7000-8000-0000000000aa';

  it('nowy nawyk = poprawny wiersz `tasks` + przypomnienie o porze', () => {
    let n = 0;
    const { taskId, ops } = habitSaveOps({ title: '  Woda ', listId: L, draft, remind: true, now: NOW, newId: () => ids[n++]! });
    expect(taskId).toBe(ids[0]);
    expect(ops.map((o) => o.table)).toEqual(['tasks', 'reminders']);
    expect(MODEL.tasks.safeParse({ id: taskId, description_md: null, time_zone: null, completed_at: null, board_sort_key: null, postpone_count: 0, assignee_id: null, board_column_id: null, canvas_pos: null, derived_from: null, start_date: null, ...ops[0]!.patch }).success).toBe(true);
    expect(ops[0]!.patch).toMatchObject({ kind: 'habit', title: 'Woda', habit: { goal: { period: 'week', times: 3 }, target: 8, unit: 'szklanek', time: '07:30' } });
    expect(MODEL.reminders.safeParse({ id: ids[1], ...ops[1]!.patch }).success).toBe(true);
  });

  it('edycja: bez nowego przypomnienia, gdy jest; wyłączenie usuwa istniejące', () => {
    const keep = habitSaveOps({ id: ids[0], title: 'Woda', listId: L, draft, remind: true, reminderIds: ['r1'], now: NOW });
    expect(keep.ops).toHaveLength(1);
    expect(Object.keys(keep.ops[0]!.patch).sort()).toEqual(['habit', 'list_id', 'recurrence', 'title']);
    const off = habitSaveOps({ id: ids[0], title: 'Woda', listId: L, draft, remind: false, reminderIds: ['r1'], now: NOW });
    expect(off.ops[1]).toEqual({ table: 'reminders', id: 'r1', patch: { deleted_at: '2026-11-18T19:00:00.000Z' } });
    expect(() => habitSaveOps({ title: ' ', listId: L, draft, remind: false, now: NOW })).toThrow('nazwę');
  });

  it('lista przypomnień: zostają z id, brakujące usunięte, nowe względne i jednorazowe dodane', () => {
    let n = 0;
    const { ops } = habitSaveOps({
      id: ids[0],
      title: 'Woda',
      listId: L,
      draft,
      reminders: [{ id: 'r1', kind: 'relative', offsetMin: 0 }, { kind: 'relative', offsetMin: 15 }, { kind: 'absolute', atDate: '2026-11-25', atTime: '18:00' }],
      reminderIds: ['r1', 'r2'],
      now: NOW,
      newId: () => `00000000-0000-7000-8000-00000000000${++n}`,
    });
    expect(ops.slice(1)).toEqual([
      { table: 'reminders', id: 'r2', patch: { deleted_at: '2026-11-18T19:00:00.000Z' } },
      { table: 'reminders', id: '00000000-0000-7000-8000-000000000001', patch: { task_id: ids[0], kind: 'relative', offset_min: 15, at_date: null, at_time: null } },
      { table: 'reminders', id: '00000000-0000-7000-8000-000000000002', patch: { task_id: ids[0], kind: 'absolute', offset_min: null, at_date: '2026-11-25', at_time: '18:00' } },
    ]);
    for (const o of ops.slice(2)) expect(MODEL.reminders.safeParse({ id: o.id, ...o.patch }).success).toBe(true);
    expect(() => habitSaveOps({ title: 'Woda', listId: L, draft, reminders: [{ kind: 'relative', offsetMin: -5 }], now: NOW })).toThrow('Wyprzedzenie');
  });

  it('nawyki dnia: zaliczone, wolne i cel tygodnia osiągnięty = załatwione', () => {
    const view = (id: string, over: Partial<ViewTask>): ViewTask => ({
      id, workspaceId: 'w', listId: L, parentId: null, kind: 'habit', title: id, status: 'todo', priority: 4, startDate: null, dueDate: null, dueTime: null, durationMin: null,
      recurrence: daily.recurrence, habit: null, completedAt: null, createdAt: NOW, sortKey: '0', boardSortKey: null, tagIds: [], postponeCount: 0, statusChangedAt: null, ...over,
    });
    const tasks = [view('a', {}), view('b', {}), view('c', { habit: { goal: { period: 'week', times: 2 } } }), view('d', { status: 'cancelled' }), view('e', { kind: 'task' })];
    const c = new Map<string, HabitCompletion[]>([
      ['a', [{ date: today, kind: 'done' }]],
      ['c', [{ date: '2026-11-16', kind: 'done' }, { date: '2026-11-17', kind: 'done' }]],
    ]);
    expect(habitsForDay(tasks, c, today, today).map((h) => [h.task.id, h.settled, h.streak.current])).toEqual([
      ['a', true, 1],
      ['b', false, 0],
      ['c', true, 1],
    ]);
  });
});

describe('nawyki w kalendarzu (habitSlots)', () => {
  const view = (id: string, over: Partial<ViewTask>): ViewTask => ({
    id, workspaceId: 'w', listId: 'l', parentId: null, kind: 'habit', title: id, status: 'todo', priority: 4, startDate: null, dueDate: null, dueTime: null, durationMin: null,
    recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=TU', anchor: '2026-11-03' }, habit: { time: '14:00' }, completedAt: null, createdAt: NOW, sortKey: '0', boardSortKey: null, tagIds: [], postponeCount: 0, statusChangedAt: null, ...over,
  });

  it('dni według reguły z porą i stanem; wpis spoza reguły też; bez pory, celu „N razy”, zakończonych i zwykłych zadań', () => {
    const tasks = [
      view('basen', {}),
      view('bez-pory', { habit: {} }),
      view('cel', { habit: { time: '07:00', goal: { period: 'week', times: 2 } }, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } }),
      view('koniec', { status: 'cancelled' }),
      view('zadanie', { kind: 'task' }),
    ];
    const done = new Map<string, HabitCompletion[]>([['basen', [{ date: '2026-11-10', kind: 'done' }, { date: '2026-11-12', kind: 'done' }]]]);
    expect(habitSlots(tasks, done, '2026-11-09', '2026-11-30', today).map((s) => [s.date, s.time, s.state, s.future])).toEqual([
      ['2026-11-10', '14:00', 'done', false],
      ['2026-11-12', '14:00', 'done', false],
      ['2026-11-17', '14:00', 'missed', false],
      ['2026-11-24', '14:00', 'pending', true],
    ]);
    expect(habitSlots(tasks, done, '2026-11-10', '2026-11-10', today)).toEqual([]);
  });
});
