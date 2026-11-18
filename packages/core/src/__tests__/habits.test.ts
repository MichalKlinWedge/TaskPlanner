/**
 * PoC-3: passy i regularność nawyków na historiach z `fixtures/habits.json` (wyniki policzone ręcznie).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { addDays } from '../dates.ts';
import { habitDays, habitRate, habitStreak, type Habit, type HabitCompletion } from '../habits.ts';
import { occurrences } from '../recurrence.ts';

interface Case {
  name: string;
  habit: Habit;
  history:
    | { doneFrom: string; doneTo: string; missed: string[]; skipped: string[] }
    | { done: (string | [string, number])[]; skipped: string[] };
  expect: { current: number; best: number; rate: { from: string; to: string; done: number; possible: number } };
}

const { today, cases } = JSON.parse(readFileSync(new URL('../../../../fixtures/habits.json', import.meta.url), 'utf8')) as { today: string; cases: Case[] };

/** Historia z opisu fixture → lista ukończeń. */
function completions(c: Case): HabitCompletion[] {
  const h = c.history;
  if ('doneFrom' in h) {
    const out: HabitCompletion[] = [];
    for (const date of occurrences(c.habit.recurrence, { from: h.doneFrom, to: h.doneTo, limit: 5000 })) {
      if (h.missed.includes(date)) continue;
      out.push({ date, kind: h.skipped.includes(date) ? 'skipped' : 'done' });
    }
    return out;
  }
  return [
    ...h.done.map((d) => (Array.isArray(d) ? { date: d[0], kind: 'done' as const, value: d[1] } : { date: d, kind: 'done' as const })),
    ...h.skipped.map((date) => ({ date, kind: 'skipped' as const })),
  ];
}

describe('PoC-3: nawyki — historie policzone ręcznie', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const history = completions(c);
    const streak = habitStreak(c.habit, history, today);
    expect({ current: streak.current, best: streak.best }).toEqual({ current: c.expect.current, best: c.expect.best });
    const { done, possible } = habitRate(c.habit, history, c.expect.rate.from, c.expect.rate.to, today);
    expect({ done, possible }).toEqual({ done: c.expect.rate.done, possible: c.expect.rate.possible });
  });

  it('stany dni do mapy cieplnej', () => {
    const c = cases.find((x) => x.name.startsWith('cel ilościowy'))!;
    const days = habitDays(c.habit, completions(c), '2026-11-11', '2026-11-19', today);
    // 12.11: 5 z 8 → częściowo; dziś 3 z 8 → też częściowo (postęp widać), jutro → poza zakresem.
    expect(days.map((d) => d.state)).toEqual(['done', 'partial', 'done', 'done', 'skipped', 'done', 'done', 'partial', 'off']);
  });

  it('weekend przy dniach roboczych to „off”, nie „missed”', () => {
    const c = cases.find((x) => x.name.startsWith('dni robocze'))!;
    const days = habitDays(c.habit, completions(c), '2026-11-06', addDays('2026-11-06', 3), today);
    expect(days.map((d) => d.state)).toEqual(['missed', 'off', 'off', 'done']);
  });
});
