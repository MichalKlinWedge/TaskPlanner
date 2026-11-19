/**
 * Plan wysyłek Web Push (`supabase/functions/_shared/reminders.ts`): okno, strefa z profilu,
 * tylko wybrane urządzenia przeglądarki, autor przypomnienia, zamknięte zadania.
 */
import { describe, expect, it } from 'vitest';

import { planPushes, pushDevices, type DeviceRow, type ReminderRow } from '../../../supabase/functions/_shared/reminders.ts';

const U = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });
const device = (id: string, patch: Partial<DeviceRow> = {}): DeviceRow => ({
  id, scope_id: U, platform: 'web', reminder_channel: 'enabled', push_subscription: sub(Number(id.at(-1))), deleted_at: null, ...patch,
});
const task = { id: 't1', kind: 'task', status: 'todo', title: 'Zapłacić rachunek', due_date: '2026-11-19', due_time: '10:00', recurrence: null, time_zone: null, deleted_at: null };
const reminder = (patch: Partial<ReminderRow> = {}): ReminderRow => ({
  id: 'r1', task_id: 't1', kind: 'relative', offset_min: 30, at_date: null, at_time: null, created_by: U, tasks: task, ...patch,
});
const profiles = [{ id: U, settings: { timeZone: 'Europe/Warsaw', defaultReminderTime: '08:00' } }];
// 10:00 w Warszawie (UTC+1) − 30 min = 08:30 UTC.
const AT = '2026-11-19T08:30:00.000Z';

describe('pushDevices', () => {
  it('tylko przeglądarka z włączonymi przypomnieniami i ważną subskrypcją https', () => {
    const ids = pushDevices([
      device('d1'),
      device('d2', { reminder_channel: 'disabled' }),
      device('d3', { platform: 'android' }),
      device('d4', { push_subscription: null }),
      device('d5', { deleted_at: AT }),
      device('d6', { push_subscription: { endpoint: 'http://localhost/6', keys: { p256dh: 'p', auth: 'a' } } }),
    ]).map((d) => d.id);
    expect(ids).toEqual(['d1']);
    expect(pushDevices([device('d6', { push_subscription: { endpoint: 'http://localhost/6', keys: { p256dh: 'p', auth: 'a' } } })], { allowHttp: true })).toHaveLength(1);
  });
});

describe('planPushes', () => {
  it('przypomnienie w oknie → jedna wysyłka na każde wybrane urządzenie, strefa z profilu', () => {
    const plan = planPushes({ devices: [device('d1'), device('d2'), device('d3', { reminder_channel: 'disabled' })], reminders: [reminder()], profiles }, { now: AT });
    expect(plan.map((p) => [p.deviceId, p.fireKey, p.fireAt])).toEqual([
      ['d1', 'r1:2026-11-19', AT],
      ['d2', 'r1:2026-11-19', AT],
    ]);
    expect(plan[0]!.payload).toEqual({ key: 'r1:2026-11-19', title: 'Zapłacić rachunek', body: 'Za 30 min (10:00)', url: '/?task=t1', taskId: 't1' });
  });

  it('okno: do 10 min spóźnienia, 30 s naprzód', () => {
    const at = (iso: string) => planPushes({ devices: [device('d1')], reminders: [reminder()], profiles }, { now: iso }).length;
    expect(at('2026-11-19T08:29:31Z')).toBe(1);
    expect(at('2026-11-19T08:29:00Z')).toBe(0);
    expect(at('2026-11-19T08:39:59Z')).toBe(1);
    expect(at('2026-11-19T08:40:01Z')).toBe(0);
  });

  it('zadanie bez godziny — domyślna godzina z profilu; seria — kolejne wystąpienie', () => {
    const noTime = reminder({ offset_min: 0, tasks: { ...task, due_time: null } });
    expect(planPushes({ devices: [device('d1')], reminders: [noTime], profiles }, { now: '2026-11-19T07:00:00Z' })).toHaveLength(1);
    const series = reminder({ tasks: { ...task, due_date: '2026-11-18', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } } });
    expect(planPushes({ devices: [device('d1')], reminders: [series], profiles }, { now: AT })[0]!.fireKey).toBe('r1:2026-11-19');
  });

  it('bez wysyłki: zamknięte lub usunięte zadanie, przypomnienie innego użytkownika', () => {
    const none = (r: ReminderRow) => planPushes({ devices: [device('d1')], reminders: [r], profiles }, { now: AT });
    expect(none(reminder({ tasks: { ...task, status: 'done' } }))).toEqual([]);
    expect(none(reminder({ tasks: { ...task, deleted_at: AT } }))).toEqual([]);
    expect(none(reminder({ created_by: OTHER }))).toEqual([]);
  });
});
