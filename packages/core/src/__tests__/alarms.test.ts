/** Alarm na telefonie: tekst opisu, treść planszy, kiedy odłożony alarm jest nieaktualny, różnica planu. */
import { describe, expect, it } from 'vitest';

import { alarmEntry, alarmPlan, alarmStillDue, descriptionText, type AlarmEntry } from '../alarms.ts';
import type { ReminderTask } from '../reminders.ts';

const task = (over: Partial<ReminderTask> = {}): ReminderTask => ({ id: 't1', kind: 'task', status: 'todo', title: 'Lekarz', dueDate: '2026-11-24', dueTime: '10:00', recurrence: null, ...over });
const fire = { fireAt: '2026-11-24T08:45:00.000Z', occurrenceDate: '2026-11-24' as const, dueAt: '2026-11-24T09:00:00.000Z' };
const entry = (over: Partial<AlarmEntry> = {}): AlarmEntry => ({ ...alarmEntry('r_1', task(), fire, { snoozeMin: 15, timeZone: 'Europe/Warsaw' }), ...over });

describe('descriptionText', () => {
  it('Markdown bez znaczników, listy i pola wyboru', () => {
    expect(descriptionText('## Zabrać\n\n- **wyniki**\n- [ ] dowód\n- [x] [mapa](https://x.pl)')).toBe('Zabrać\n\n• wyniki\n☐ dowód\n☑ mapa');
  });
  it('pusty opis i limit długości', () => {
    expect(descriptionText(null)).toBe('');
    expect(descriptionText('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('alarmEntry', () => {
  it('treść z przypomnienia, po odłożeniu bez względnego czasu', () => {
    expect(entry()).toMatchObject({ title: 'Lekarz', body: 'Za 15 min (10:00)', snoozedBody: 'Odłożone · termin 24 listopada 10:00', at: Date.parse(fire.fireAt), habit: false });
    expect(alarmEntry('r', task({ dueDate: null }), { ...fire, occurrenceDate: null, dueAt: null }, { snoozeMin: 5 }).snoozedBody).toBe('Odłożone');
  });
});

describe('alarmStillDue', () => {
  it('zamknięte, usunięte i przełożone zadanie nie dzwoni', () => {
    expect(alarmStillDue(entry(), task())).toBe(true);
    expect(alarmStillDue(entry(), undefined)).toBe(false);
    expect(alarmStillDue(entry(), task({ status: 'done' }))).toBe(false);
    expect(alarmStillDue(entry(), task({ dueDate: '2026-11-25' }))).toBe(false);
  });
  it('nawyk: dzień już odhaczony', () => {
    const habit = task({ kind: 'habit', dueDate: null, recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' }, habit: {} });
    expect(alarmStillDue(entry({ habit: true }), habit, new Map())).toBe(true);
    expect(alarmStillDue(entry({ habit: true }), habit, new Map([['t1', [{ date: '2026-11-24', kind: 'done' as const }]]]))).toBe(false);
  });
});

describe('alarmPlan', () => {
  const now = Date.parse('2026-11-24T08:00:00Z');
  const yes = () => true;
  it('bez zmian nic nie planuje; zmieniony — od nowa; zbędny — odwołany', () => {
    expect(alarmPlan([entry()], { scheduled: [entry()], ringing: [] }, now, yes)).toEqual({ set: [], cancel: [], dismiss: [] });
    expect(alarmPlan([entry({ description: 'nowy' })], { scheduled: [entry()], ringing: [] }, now, yes).set).toHaveLength(1);
    expect(alarmPlan([], { scheduled: [entry()], ringing: [] }, now, yes).cancel).toEqual(['r_1']);
  });
  it('odłożony i właśnie mijający zostają, dopóki aktualne', () => {
    const scheduled = [entry({ id: 's_1', snoozed: true, at: now + 60_000 }), entry({ id: 'r_2', at: now - 1000 })];
    expect(alarmPlan([], { scheduled, ringing: [] }, now, yes).cancel).toEqual([]);
    expect(alarmPlan([], { scheduled, ringing: [entry({ id: 'r_3' })] }, now, () => false)).toEqual({ set: [], cancel: ['s_1', 'r_2'], dismiss: ['r_3'] });
  });
});
