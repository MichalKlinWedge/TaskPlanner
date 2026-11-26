/**
 * Web Push powiadomień centrum (`supabase/functions/_shared/notification-push.ts`, etap N2): kanał `push`,
 * urządzenia odbiorcy, klucz wysyłki, podpis akcji „Oznacz jako przeczytane”.
 */
import { describe, expect, it } from 'vitest';

import { notificationReadToken, planNotificationPushes, verifyNotificationReadToken, type NotificationRow } from '../../../supabase/functions/_shared/notification-push.ts';
import type { DeviceRow } from '../../../supabase/functions/_shared/reminders.ts';

const U = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const N1 = '01900000-0000-7000-8000-000000000001';
const T = '01900000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-11-19T10:00:00Z');
const READ = 'https://example.supabase.co/functions/v1/reminders-push/read';
const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });
const device = (id: string, patch: Partial<DeviceRow> = {}): DeviceRow => ({
  id, scope_id: U, platform: 'web', reminder_channel: 'enabled', push_subscription: sub(Number(id.at(-1))), deleted_at: null, ...patch,
});
const note = (patch: Partial<NotificationRow> = {}): NotificationRow => ({
  id: N1, user_id: U, kind: 'comment', task_id: T, workspace_id: null, actor_id: OTHER, data: { actor: 'Jan', title: 'Raport', excerpt: 'Hej', count: 2 },
  group_key: `comment:${T}`, at: '2026-11-19T09:58:00+00:00', read_at: null, deleted_at: null, ...patch,
});
const profiles = (notifications: unknown, timeZone = 'Europe/Warsaw') => [{ id: U, settings: { timeZone, notifications } }];

describe('planNotificationPushes', () => {
  it('kanał push → wysyłka na urządzenia odbiorcy z treścią z core i adresem akcji', () => {
    const plan = planNotificationPushes(
      { devices: [device('d1'), device('d2'), device('d3', { scope_id: OTHER }), device('d4', { reminder_channel: 'disabled' })], notifications: [note()], profiles: profiles({ tasks: 'push' }) },
      { now: NOW, readUrl: READ },
    );
    expect(plan.map((p) => p.deviceId)).toEqual(['d1', 'd2']);
    expect(plan[0]).toMatchObject({
      userId: U,
      fireKey: `n:${N1}:${Date.parse('2026-11-19T09:58:00Z')}`,
      taskId: null,
      payload: { title: '2 nowe komentarze w „Raport”', body: 'Ostatni — Jan: Hej', url: `/?task=${T}`, taskId: T, tag: `tp-n:comment:${T}`, notification: N1, readUrl: READ },
    });
  });

  it('bez push: kanał „w aplikacji”, przeczytane, za świeże, cisza nocna', () => {
    const plan = (rows: NotificationRow[], settings: unknown) => planNotificationPushes({ devices: [device('d1')], notifications: rows, profiles: profiles(settings) }, { now: NOW, readUrl: READ });
    expect(plan([note()], {})).toEqual([]);
    expect(plan([note({ read_at: '2026-11-19T09:59:00Z' })], { tasks: 'push' })).toEqual([]);
    expect(plan([note({ at: '2026-11-19T09:59:30Z' })], { tasks: 'push' })).toEqual([]);
    // 11:00 w Warszawie.
    expect(plan([note()], { tasks: 'push', quiet: { enabled: true, from: '10:30', to: '12:00' } })).toEqual([]);
    expect(plan([note({ kind: 'nieznany' })], { tasks: 'push' })).toEqual([]);
  });
});

describe('podpis „przeczytane”', () => {
  it('ten sam sekret i id → zgodny; inny id, sekret albo śmieci → nie', async () => {
    const token = await notificationReadToken('sekret', N1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyNotificationReadToken('sekret', N1, token)).toBe(true);
    expect(await verifyNotificationReadToken('inny', N1, token)).toBe(false);
    expect(await verifyNotificationReadToken('sekret', T, token)).toBe(false);
    expect(await verifyNotificationReadToken('sekret', 'nie-uuid', token)).toBe(false);
    expect(await verifyNotificationReadToken('sekret', N1, 42)).toBe(false);
  });
});
