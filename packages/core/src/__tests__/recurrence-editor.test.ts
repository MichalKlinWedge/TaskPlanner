/**
 * Edytor reguły (M7): formularz ↔ reguła tam i z powrotem, walidacja, szablony, podgląd dat.
 */
import { describe, expect, it } from 'vitest';

import { describeRecurrence, type Recurrence } from '../recurrence.ts';
import { draftError, draftFromRecurrence, previewDates, recurrenceFromDraft, recurrenceTemplates } from '../recurrence-editor.ts';

const ANCHOR = '2026-11-18'; // środa, 3. w miesiącu

describe('recurrenceFromDraft', () => {
  it('domyślny formularz: co tydzień w dzień kotwicy', () => {
    const rec = recurrenceFromDraft(draftFromRecurrence(null, ANCHOR), ANCHOR);
    expect(rec).toEqual({ mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=WE', anchor: ANCHOR });
    expect(describeRecurrence(rec)).toBe('w każdą środę');
  });

  it('kotwica przesuwa się na pierwsze pasujące wystąpienie', () => {
    const draft = { ...draftFromRecurrence(null, ANCHOR), days: ['FR' as const] };
    expect(recurrenceFromDraft(draft, ANCHOR)).toMatchObject({ anchor: '2026-11-20' });
  });

  it.each<[string, Recurrence]>([
    ['co 2 tygodnie we wtorek i czwartek do 31.12', { mode: 'schedule', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231', anchor: '2026-11-19' }],
    ['ostatni dzień roboczy', { mode: 'schedule', rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', anchor: '2026-11-30' }],
    ['drugi wtorek, 5 razy', { mode: 'schedule', rrule: 'FREQ=MONTHLY;BYDAY=2TU;COUNT=5', anchor: '2026-12-08' }],
    ['15. i ostatni', { mode: 'schedule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=15,-1', anchor: '2026-11-30' }],
    ['co roku 1 marca', { mode: 'schedule', rrule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1', anchor: '2027-03-01' }],
    ['3 dni po ukończeniu', { mode: 'after_completion', every: { unit: 'day', n: 3 } }],
  ])('tam i z powrotem: %s', (_, rec) => {
    const anchor = rec.mode === 'schedule' ? rec.anchor : ANCHOR;
    expect(recurrenceFromDraft(draftFromRecurrence(rec, anchor), anchor)).toEqual(rec);
  });

  it('walidacja po polsku', () => {
    const base = draftFromRecurrence(null, ANCHOR);
    expect(draftError({ ...base, days: [] })).toMatch(/dzień tygodnia/);
    expect(draftError({ ...base, interval: 0 })).toMatch(/Co ile/);
    expect(draftError({ ...base, unit: 'year', month: 2, monthDay: 30 })).toMatch(/nie istnieje/);
    expect(draftError({ ...base, unit: 'year', month: 2, monthDay: 29 })).toBeNull();
    expect(draftError({ ...base, end: { kind: 'count', n: 0 } })).toMatch(/powtórzeń/);
    expect(() => recurrenceFromDraft({ ...base, days: [] }, ANCHOR)).toThrow();
  });
});

describe('szablony i podgląd', () => {
  it('każdy szablon daje poprawną regułę z opisem', () => {
    for (const t of recurrenceTemplates(ANCHOR)) {
      const rec = recurrenceFromDraft(t.draft, ANCHOR);
      expect(describeRecurrence(rec).length, t.id).toBeGreaterThan(3);
      expect(previewDates(rec, ANCHOR)).toHaveLength(5);
    }
  });

  it('podgląd 5 dat: harmonogram i po ukończeniu', () => {
    expect(previewDates({ mode: 'schedule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1', anchor: '2026-11-30' }, ANCHOR)).toEqual([
      '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31',
    ]);
    expect(previewDates({ mode: 'after_completion', every: { unit: 'week', n: 2 } }, ANCHOR, 3)).toEqual(['2026-11-18', '2026-12-02', '2026-12-16']);
  });
});
