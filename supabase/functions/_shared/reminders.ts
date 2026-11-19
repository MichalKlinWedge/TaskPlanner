/**
 * Plan wysyłek Web Push (`reminders-push`, SPECYFIKACJA M8 web): z wierszy bazy liczy przypomnienia
 * należne w oknie `[now − lookback, now + lead)` tak samo jak telefon (`core/reminders.ts`), w strefie
 * i z domyślną godziną z ustawień profilu, i rozdziela je na urządzenia użytkownika, które mają włączone
 * przypomnienia i subskrypcję push. Przypomnienie dostaje autor wiersza `reminders` (`created_by`).
 * Bez Deno — testowane w Node (`tools/edge-tests`).
 */
import { reminderBody, reminderFireTimes, toReminderRule, type ReminderTask } from '../../../packages/core/src/reminders.ts';
import { Recurrence } from '../../../packages/core/src/recurrence.ts';
import { ProfileSettings, PushSubscriptionJson } from '../../../packages/core/src/schemas/model.ts';

/** Okno: spóźnione do 10 min (przerwa crona, ponowienie) i do 30 s naprzód (cron startuje chwilę przed). */
export const LOOKBACK_MS = 10 * 60_000;
export const LEAD_MS = 30_000;

export interface DeviceRow {
  id: string;
  scope_id: string;
  platform: string;
  reminder_channel: string;
  push_subscription: unknown;
  deleted_at: string | null;
}

export interface ReminderRow {
  id: string;
  task_id: string;
  kind: string;
  offset_min: number | null;
  at_date: string | null;
  at_time: string | null;
  created_by: string | null;
  tasks: {
    id: string;
    kind: string;
    status: string;
    title: string;
    due_date: string | null;
    due_time: string | null;
    recurrence: unknown;
    time_zone: string | null;
    deleted_at: string | null;
  } | null;
}

export interface ProfileRow {
  id: string;
  settings: unknown;
}

export interface PlannedPush {
  userId: string;
  deviceId: string;
  fireKey: string;
  taskId: string;
  fireAt: string;
  subscription: PushSubscriptionJson;
  payload: { key: string; title: string; body: string; url: string; taskId: string };
}

/** Urządzenia, które dostają Web Push: przeglądarka z włączonymi przypomnieniami i ważną subskrypcją. */
export function pushDevices(devices: readonly DeviceRow[], { allowHttp = false } = {}): (DeviceRow & { subscription: PushSubscriptionJson })[] {
  const out: (DeviceRow & { subscription: PushSubscriptionJson })[] = [];
  for (const d of devices) {
    if (d.deleted_at || d.platform !== 'web' || d.reminder_channel !== 'enabled') continue;
    const sub = PushSubscriptionJson.safeParse(d.push_subscription);
    if (!sub.success || !(allowHttp || sub.data.endpoint.startsWith('https://'))) continue;
    out.push({ ...d, subscription: sub.data });
  }
  return out;
}

export function planPushes(
  { devices, reminders, profiles }: { devices: readonly DeviceRow[]; reminders: readonly ReminderRow[]; profiles: readonly ProfileRow[] },
  { now, allowHttp = false }: { now: Date | string; allowHttp?: boolean },
): PlannedPush[] {
  const at = new Date(now).getTime();
  const targets = pushDevices(devices, { allowHttp });
  const byUser = new Map<string, typeof targets>();
  for (const d of targets) byUser.set(d.scope_id, [...(byUser.get(d.scope_id) ?? []), d]);
  const settings = new Map(profiles.map((p) => [p.id, ProfileSettings.parse(p.settings ?? {})]));

  const plan: PlannedPush[] = [];
  for (const [userId, userDevices] of byUser) {
    const rows = reminders.filter((r) => r.created_by === userId && r.tasks && !r.tasks.deleted_at);
    if (!rows.length) continue;
    const s = settings.get(userId) ?? ProfileSettings.parse({});
    const tasks = new Map<string, ReminderTask>();
    for (const r of rows) {
      const t = r.tasks!;
      const rec = t.recurrence ? Recurrence.safeParse(t.recurrence) : null;
      tasks.set(t.id, {
        id: t.id,
        kind: t.kind as ReminderTask['kind'],
        status: t.status as ReminderTask['status'],
        title: t.title,
        dueDate: t.due_date as ReminderTask['dueDate'],
        dueTime: t.due_time ? (t.due_time.slice(0, 5) as ReminderTask['dueTime']) : null,
        recurrence: rec?.success ? rec.data : null,
        timeZone: t.time_zone,
      });
    }
    const fires = reminderFireTimes([...tasks.values()], rows.map(toReminderRule), {
      from: new Date(at - LOOKBACK_MS),
      to: new Date(at + LEAD_MS),
      timeZone: s.timeZone,
      defaultTime: s.defaultReminderTime,
    });
    for (const fire of fires) {
      const task = tasks.get(fire.taskId)!;
      const text = reminderBody(task, fire, now, task.timeZone ?? s.timeZone);
      for (const device of userDevices) {
        plan.push({
          userId,
          deviceId: device.id,
          fireKey: fire.key,
          taskId: fire.taskId,
          fireAt: fire.fireAt,
          subscription: device.subscription,
          payload: { key: fire.key, ...text, url: `/?task=${fire.taskId}`, taskId: fire.taskId },
        });
      }
    }
  }
  return plan;
}
