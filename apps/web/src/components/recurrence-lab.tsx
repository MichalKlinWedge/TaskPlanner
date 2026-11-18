"use client";

import {
  describeRecurrence,
  habitRate,
  habitStreak,
  nextDue,
  occurrences,
  type Habit,
  type HabitCompletion,
  type Recurrence,
  type ScheduleRecurrence,
} from "@taskplanner/core";
import { useMemo } from "react";

import habitsFixture from "../../../../fixtures/habits.json";
import recurrenceFixture from "../../../../fixtures/recurrence.json";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

type HabitCase = {
  name: string;
  habit: Habit;
  history: { doneFrom?: string; doneTo?: string; missed?: string[]; skipped: string[]; done?: (string | [string, number])[] };
  expect: { current: number; best: number; rate: { from: string; to: string; done: number; possible: number } };
};

function runChecks(): { checks: Check[]; ms: number } {
  const start = performance.now();
  const checks: Check[] = [];
  for (const c of recurrenceFixture.cases as { name: string; rule: Recurrence; occurrences?: string[]; completions?: { occurrence: string; on: string; next: string }[] }[]) {
    if (c.occurrences) {
      const got = occurrences(c.rule as ScheduleRecurrence, { limit: c.occurrences.length + 1 }).slice(0, /COUNT|UNTIL/.test((c.rule as ScheduleRecurrence).rrule) ? undefined : c.occurrences.length);
      checks.push({ name: `${c.name} (${describeRecurrence(c.rule)})`, ok: JSON.stringify(got) === JSON.stringify(c.occurrences), detail: got.join(", ") });
    }
    for (const done of c.completions ?? []) {
      const next = nextDue(c.rule, { occurrence: done.occurrence, completedOn: done.on });
      checks.push({ name: `${c.name}: ukończone ${done.on}`, ok: next === done.next, detail: `→ ${next}` });
    }
  }
  const { today, cases } = habitsFixture as unknown as { today: string; cases: HabitCase[] };
  for (const c of cases) {
    const h = c.history;
    const history: HabitCompletion[] = h.doneFrom
      ? occurrences(c.habit.recurrence, { from: h.doneFrom, to: h.doneTo, limit: 5000 })
          .filter((d) => !h.missed?.includes(d))
          .map((date) => ({ date, kind: h.skipped.includes(date) ? ("skipped" as const) : ("done" as const) }))
      : [
          ...(h.done ?? []).map((d) => (Array.isArray(d) ? { date: d[0], kind: "done" as const, value: d[1] } : { date: d, kind: "done" as const })),
          ...h.skipped.map((date) => ({ date, kind: "skipped" as const })),
        ];
    const streak = habitStreak(c.habit, history, today);
    const rate = habitRate(c.habit, history, c.expect.rate.from, c.expect.rate.to, today);
    const ok = streak.current === c.expect.current && streak.best === c.expect.best && rate.done === c.expect.rate.done && rate.possible === c.expect.rate.possible;
    checks.push({ name: `Nawyk: ${c.name}`, ok, detail: `passa ${streak.current}, najdłuższa ${streak.best}, ${rate.done}/${rate.possible}` });
  }
  return { checks, ms: performance.now() - start };
}

/** PoC-3: te same przypadki co w Vitest, liczone w silniku JS przeglądarki. */
export function RecurrenceLab() {
  const { checks, ms } = useMemo(() => runChecks(), []);
  const failed = checks.filter((c) => !c.ok).length;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-8 text-sm">
      <h1 className="text-xl font-semibold">PoC-3: cykliczność i nawyki w przeglądarce</h1>
      <p data-testid="summary" className={failed ? "text-red-600" : "text-green-700 dark:text-green-400"}>
        {checks.length - failed} / {checks.length} zgodnych · {ms.toFixed(1)} ms
      </p>
      <ul className="flex flex-col gap-1">
        {checks.map((c) => (
          <li key={c.name} className="flex gap-2">
            <span aria-label={c.ok ? "zgodne" : "niezgodne"}>{c.ok ? "✓" : "✗"}</span>
            <span>
              {c.name} <span className="opacity-60">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
