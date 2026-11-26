/**
 * Web Push powiadomień centrum (v1.x, etap N2): które wiersze `notifications` idą teraz na które urządzenia.
 * Te same urządzenia co przypomnienia (`pushDevices`: przeglądarka z włączonymi przypomnieniami i subskrypcją),
 * reguły w core (`wantsPush` — kanał `push` grupy, minuta po zdarzeniu, najwyżej 15 min, poza ciszą nocną w strefie
 * z ustawień). Akcja „Oznacz jako przeczytane” w powiadomieniu systemowym: adres `…/reminders-push/read` i podpis
 * HMAC id powiadomienia (`notificationReadToken`) — Service Worker nie ma sesji użytkownika.
 * Bez Deno — testowane w Node (`tools/edge-tests`).
 */
import { notificationFireKey, notificationPush, toNotification, wantsPush } from '../../../packages/core/src/notifications.ts';
import { ProfileSettings } from '../../../packages/core/src/schemas/model.ts';
import { pushDevices, type DeviceRow, type PlannedPush, type ProfileRow } from './reminders.ts';

/** Wiersz `notifications` z bazy (service role). */
export interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  task_id: string | null;
  workspace_id: string | null;
  actor_id: string | null;
  data: unknown;
  group_key: string | null;
  at: string;
  read_at: string | null;
  deleted_at: string | null;
}

export function planNotificationPushes(
  { devices, notifications, profiles }: { devices: readonly DeviceRow[]; notifications: readonly NotificationRow[]; profiles: readonly ProfileRow[] },
  { now, allowHttp = false, readUrl }: { now: Date; allowHttp?: boolean; readUrl: string },
): PlannedPush[] {
  const targets = pushDevices(devices, { allowHttp });
  const settings = new Map(profiles.map((p) => [p.id, ProfileSettings.parse(p.settings ?? {})]));
  const plan: PlannedPush[] = [];
  for (const row of notifications) {
    const n = toNotification(row as unknown as Record<string, unknown>);
    if (!n) continue;
    const s = settings.get(row.user_id) ?? ProfileSettings.parse({});
    if (!wantsPush(n, s.notifications, now, s.timeZone)) continue;
    const key = notificationFireKey(n);
    const push = notificationPush(n);
    for (const device of targets) {
      if (device.scope_id !== row.user_id) continue;
      plan.push({
        userId: row.user_id,
        deviceId: device.id,
        fireKey: key,
        taskId: null,
        fireAt: new Date(n.at).toISOString(),
        subscription: device.subscription,
        payload: { key, ...push, notification: n.id, readUrl },
      });
    }
  }
  return plan;
}

const enc = new TextEncoder();
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Podpis akcji „przeczytane”: HMAC-SHA256 z sekretu funkcji nad id powiadomienia (base64url). */
export async function notificationReadToken(secret: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, enc.encode(`notification-read:${id}`)));
}

/** Sprawdzenie podpisu w stałym czasie (długość tokenu jest jawna). */
export async function verifyNotificationReadToken(secret: string, id: unknown, token: unknown): Promise<boolean> {
  if (typeof id !== 'string' || typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  const expected = await notificationReadToken(secret, id);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
