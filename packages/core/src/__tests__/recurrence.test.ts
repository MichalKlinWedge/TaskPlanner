/**
 * PoC-3: przypadki `fixtures/recurrence.json` (SPECYFIKACJA §7.2) i porównanie z rrule.js na
 * losowych regułach z obsługiwanego podzbioru — rrule.js jest tylko wyrocznią w testach.
 */
import { readFileSync } from 'node:fs';

import { datetime, RRule as OracleRule } from 'rrule';
import { describe, expect, it } from 'vitest';

import { parseQuickAdd } from '../quick-add.ts';
import { describeRecurrence, formatRrule, nextDue, occurrences, parseRrule, type Recurrence, type ScheduleRecurrence } from '../recurrence.ts';

interface Case {
  name: string;
  text?: string;
  rule: Recurrence;
  occurrences?: string[];
  completions?: { occurrence: string; on: string; next: string }[];
}

const { cases } = JSON.parse(readFileSync(new URL('../../../../fixtures/recurrence.json', import.meta.url), 'utf8')) as { cases: Case[] };

describe('PoC-3: przypadki z fixtures/recurrence.json', () => {
  for (const c of cases) {
    if (c.occurrences) {
      it(`${c.name} — wystąpienia`, () => {
        const rule = c.rule as ScheduleRecurrence;
        // O jedno więcej niż w oczekiwaniach: seria z COUNT/UNTIL nie może dać kolejnego.
        const got = occurrences(rule, { limit: c.occurrences!.length + 1 });
        const finite = /COUNT|UNTIL/.test(rule.rrule);
        expect(finite ? got : got.slice(0, c.occurrences!.length)).toEqual(c.occurrences);
      });
    }
    for (const done of c.completions ?? []) {
      it(`${c.name} — ukończone ${done.on} → ${done.next}`, () => {
        expect(nextDue(c.rule, { occurrence: done.occurrence, completedOn: done.on })).toBe(done.next);
      });
    }
  }
});

describe('opis po polsku', () => {
  const expected: Record<string, string> = {
    'co drugi wtorek': 'co drugi wtorek',
    'drugi wtorek miesiąca': 'drugi wtorek miesiąca',
    'ostatni dzień miesiąca': 'ostatniego dnia miesiąca',
    'ostatni dzień roboczy miesiąca': 'ostatniego dnia roboczego miesiąca',
    '15. i ostatni dzień miesiąca': '15. i ostatniego dnia miesiąca',
    'dni robocze': 'w dni robocze',
    'koniec po 3 wystąpieniach': 'codziennie, 3 razy',
    'koniec po dacie': 'w każdą środę, do 2.12.2026',
    '29 lutego co roku': 'co roku 29 lutego',
    '3 dni po ukończeniu — ukończone z opóźnieniem i przed terminem': 'co 3 dni po ukończeniu',
  };
  it.each(Object.entries(expected))('%s → „%s”', (name, text) => {
    expect(describeRecurrence(cases.find((c) => c.name === name)!.rule)).toBe(text);
  });

  it('tam i z powrotem: opis i tekst z fixtures przez szybkie dodawanie dają tę samą regułę', () => {
    const ctx = { now: '2026-11-18T12:00', workspaces: [], lists: [], tags: [] };
    const checked: string[] = [];
    for (const c of cases) {
      for (const text of new Set([c.text, describeRecurrence(c.rule)].filter((t): t is string => !!t))) {
        const parsed = parseQuickAdd(`Zadanie ${text}`, ctx).fields.recurrence;
        if (/, \d+ razy|, do /.test(text)) continue; // koniec serii ustawia się w edytorze reguły, nie w szybkim dodawaniu
        expect(parsed, text).toBeDefined();
        if (c.rule.mode === 'after_completion') expect(parsed).toEqual(c.rule);
        else {
          // Ta sama reguła = te same daty od tej samej kotwicy (dzień z kotwicy i jawny BYMONTHDAY są równoważne).
          expect(parsed?.mode).toBe('schedule');
          const fromParsed = occurrences({ ...c.rule, rrule: (parsed as ScheduleRecurrence).rrule }, { limit: 12 });
          expect(fromParsed, text).toEqual(occurrences(c.rule, { limit: 12 }));
        }
        checked.push(text);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(10);
  });
});

describe('porównanie z rrule.js (losowe reguły z podzbioru)', () => {
  // Prosty generator z ziarnem — ten sam zestaw przy każdym uruchomieniu.
  let seed = 20261118;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const some = <T>(items: readonly T[], max: number): T[] => [...new Set(Array.from({ length: 1 + Math.floor(random() * max) }, () => pick(items)))];
  const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

  function randomRule(): string {
    const freq = pick(['DAILY', 'WEEKLY', 'MONTHLY', 'MONTHLY', 'YEARLY'] as const);
    const parts = [`FREQ=${freq}`];
    if (random() < 0.5) parts.push(`INTERVAL=${1 + Math.floor(random() * 3)}`);
    if (freq === 'YEARLY' || random() < 0.15) parts.push(`BYMONTH=${some([1, 2, 3, 6, 9, 11, 12], 2).join(',')}`);
    if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const mode = pick(['monthday', 'nth', 'days', 'none'] as const);
      if (mode === 'monthday') parts.push(`BYMONTHDAY=${some([1, 5, 15, 28, 29, 30, 31, -1, -2], 2).join(',')}`);
      if (mode === 'nth') parts.push(`BYDAY=${some(['1MO', '2TU', '3WE', '-1FR', '4TH', '-1SU', '5SA'], 2).join(',')}`);
      if (mode === 'days') {
        parts.push(`BYDAY=${some(DAYS, 5).join(',')}`);
        if (random() < 0.5) parts.push(`BYSETPOS=${pick([1, -1, 2])}`);
      }
    } else if (freq === 'WEEKLY') {
      if (random() < 0.8) parts.push(`BYDAY=${some(DAYS, 4).join(',')}`);
    } else if (random() < 0.3) parts.push(`BYDAY=${some(DAYS, 3).join(',')}`);
    if (random() < 0.15) parts.push(`COUNT=${1 + Math.floor(random() * 10)}`);
    return parts.join(';');
  }

  it('500 reguł × 40 wystąpień — te same daty', () => {
    const mismatches: string[] = [];
    for (let i = 0; i < 500; i++) {
      const rrule = randomRule();
      const anchor = `${2024 + Math.floor(random() * 6)}-${String(1 + Math.floor(random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`;
      if (random() < 0.1) continue;
      const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
      const oracle = new OracleRule({ ...OracleRule.parseString(rrule), dtstart: datetime(y, m, d), wkst: OracleRule.MO })
        .all((_date, n) => n < 40)
        .map((date) => date.toISOString().slice(0, 10));
      const ours = occurrences({ mode: 'schedule', rrule, anchor }, { limit: 40 });
      if (JSON.stringify(ours) !== JSON.stringify(oracle)) mismatches.push(`${rrule} @ ${anchor}\n  nasze:   ${ours.slice(0, 6).join(' ')}\n  rrule.js: ${oracle.slice(0, 6).join(' ')}`);
    }
    expect(mismatches.slice(0, 5).join('\n')).toBe('');
  });

  it('format RRULE tam i z powrotem', () => {
    for (const rrule of ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261202']) {
      expect(formatRrule(parseRrule(rrule))).toBe(rrule.includes('BYMONTH=') ? rrule : rrule);
    }
  });

  it('reguły spoza podzbioru są odrzucane', () => {
    for (const rrule of ['FREQ=HOURLY', 'FREQ=WEEKLY;BYDAY=2TU', 'FREQ=YEARLY;BYDAY=20MO', 'FREQ=DAILY;BYHOUR=9', 'FREQ=DAILY;COUNT=2;UNTIL=20270101', 'BYDAY=MO']) {
      expect(() => parseRrule(rrule), rrule).toThrow();
    }
  });

  it('wydajność: rok wystąpień codziennej reguły < 20 ms', () => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) occurrences({ mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-01-01' }, { limit: 1000 });
    const ms = (performance.now() - start) / 10;
    console.log(`1000 wystąpień: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });
});
