/**
 * `reminders-push` — Web Push (VAPID, aes128gcm) z `pg_cron` co minutę (SPECYFIKACJA M8 web).
 *
 * Liczy należne przypomnienia z bazy tak samo jak telefon (`_shared/reminders.ts` → `core/reminders.ts`):
 * urządzenia `devices` (przeglądarka, `reminder_channel = 'enabled'`, `push_subscription`), przypomnienia
 * ich właścicieli i ustawienia profilu (strefa, domyślna godzina). Każdą wysyłkę najpierw zajmuje w
 * dzienniku `reminder_deliveries` (`claim_reminder_deliveries` — jedno urządzenie i wystąpienie raz, także
 * przy równoległych uruchomieniach), potem wysyła i zapisuje wynik. Subskrypcja 404/410 jest czyszczona
 * (`clear_push_subscription`), błąd przejściowy — ponowienie w następnej minucie (najwyżej 5 prób).
 * Nawyki (Etap 8): wpisy `task_completions` z ostatnich dni — bez przypomnienia o dniu już zaliczonym.
 *
 * `GET …/reminders-push/key` — klucz publiczny VAPID dla przeglądarki.
 *
 * Sekrety: `VAPID_KEYS` (JSON z `exportVapidKeys`), `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` (`mailto:` albo `https:`), `CRON_SECRET`.
 */
import * as webpush from '@negrel/webpush';

import { planPushes, pushDevices, type CompletionRow, type DeviceRow, type PlannedPush, type ProfileRow, type ReminderRow } from '../_shared/reminders.ts';
import { admin, env, HttpError, json, optionalEnv, requireCron, route, serve } from '../_shared/runtime.ts';

let server: webpush.ApplicationServer | null = null;

async function appServer(): Promise<webpush.ApplicationServer> {
  if (!server) {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(env('VAPID_KEYS')), { extractable: false });
    server = await webpush.ApplicationServer.new({ contactInformation: env('VAPID_SUBJECT'), vapidKeys });
  }
  return server;
}

/** `Topic` (≤ 32 znaki base64url): ta sama wysyłka zastępuje niedostarczoną kopię, różne dni się nie mieszają. */
const pushTopic = (fireKey: string) => {
  const [reminder = '', day = ''] = fireKey.split(':');
  return `${reminder.replaceAll('-', '').slice(0, 24)}${day.replaceAll('-', '')}`.slice(0, 32);
};

const TASK_COLUMNS = 'id, kind, status, title, due_date, due_time, recurrence, habit, time_zone, deleted_at';

serve(async (req, url) => {
  // Klucz publiczny VAPID dla przeglądarki (`pushManager.subscribe`) — jawny, bez logowania.
  if (req.method === 'GET' && route(url, 'reminders-push') === 'key') return json({ publicKey: env('VAPID_PUBLIC_KEY') });
  if (req.method !== 'POST') throw new HttpError(405, 'Tylko POST');
  requireCron(req);
  const started = Date.now();
  const now = new Date();
  const db = admin();
  const allowHttp = optionalEnv('PUSH_ALLOW_HTTP') === '1';

  const { data: deviceRows, error: devError } = await db
    .from('devices')
    .select('id, scope_id, platform, reminder_channel, push_subscription, deleted_at')
    .eq('platform', 'web')
    .eq('reminder_channel', 'enabled')
    .is('deleted_at', null)
    .not('push_subscription', 'is', null);
  if (devError) throw devError;
  const devices = pushDevices((deviceRows ?? []) as DeviceRow[], { allowHttp });
  if (!devices.length) return json({ devices: 0, sent: 0, ms: Date.now() - started });
  const users = [...new Set(devices.map((d) => d.scope_id))];

  const [{ data: reminderRows, error: remError }, { data: profileRows, error: profError }] = await Promise.all([
    db
      .from('reminders')
      .select(`id, task_id, kind, offset_min, at_date, at_time, created_by, tasks!inner(${TASK_COLUMNS})`)
      .in('created_by', users)
      .is('deleted_at', null)
      .is('tasks.deleted_at', null)
      .not('tasks.status', 'in', '(done,cancelled)'),
    db.from('profiles').select('id, settings').in('id', users),
  ]);
  if (remError) throw remError;
  if (profError) throw profError;
  const reminders = (reminderRows ?? []) as unknown as ReminderRow[];

  // Nawyki: wpisy od początku bieżącego tygodnia / miesiąca (cel „N razy”) w każdej strefie — z zapasem dnia.
  const habitIds = [...new Set(reminders.filter((r) => r.tasks?.kind === 'habit').map((r) => r.task_id))];
  let completions: CompletionRow[] = [];
  if (habitIds.length) {
    const dayBefore = new Date(now.getTime() - 86_400_000);
    const week = new Date(now.getTime() - 8 * 86_400_000).toISOString().slice(0, 10);
    const month = `${dayBefore.toISOString().slice(0, 8)}01`;
    const since = month < week ? month : week;
    const { data, error } = await db
      .from('task_completions')
      .select('task_id, occurrence_date, kind, value')
      .in('task_id', habitIds)
      .gte('occurrence_date', since)
      .is('deleted_at', null);
    if (error) throw error;
    completions = (data ?? []) as CompletionRow[];
  }

  const plan = planPushes(
    { devices, reminders, profiles: (profileRows ?? []) as ProfileRow[], completions },
    { now, allowHttp },
  );
  const summary = { devices: devices.length, due: plan.length, claimed: 0, sent: 0, retry: 0, gone: 0, failed: 0 };
  if (!plan.length) return json({ ...summary, ms: Date.now() - started });

  const { data: claimed, error: claimError } = await db.rpc('claim_reminder_deliveries', {
    p_items: plan.map((p) => ({ user_id: p.userId, device_id: p.deviceId, fire_key: p.fireKey, task_id: p.taskId, fire_at: p.fireAt })),
  });
  if (claimError) throw claimError;
  const mine = new Map(((claimed ?? []) as { id: number; device_id: string; fire_key: string; attempts: number }[]).map((c) => [`${c.device_id}|${c.fire_key}`, c]));
  summary.claimed = mine.size;

  const as = await appServer();
  await Promise.all(plan.map(async (item: PlannedPush) => {
    const row = mine.get(`${item.deviceId}|${item.fireKey}`);
    if (!row) return;
    const finish = (patch: Record<string, unknown>) => db.from('reminder_deliveries').update(patch).eq('id', row.id);
    try {
      await as
        .subscribe({ endpoint: item.subscription.endpoint, keys: item.subscription.keys })
        .pushTextMessage(JSON.stringify({ ...item.payload, sentAt: new Date().toISOString() }), {
          ttl: 600,
          urgency: webpush.Urgency.High,
          topic: pushTopic(item.fireKey),
        });
      summary.sent++;
      await finish({ status: 'sent', sent_at: new Date().toISOString(), error: null });
    } catch (e) {
      const status = e instanceof webpush.PushMessageError ? e.response.status : 0;
      const error = `${status || 'sieć'}: ${(e as Error).message}`.slice(0, 300);
      if (status === 404 || status === 410) {
        summary.gone++;
        await db.rpc('clear_push_subscription', { p_device: item.deviceId, p_endpoint: item.subscription.endpoint });
        await finish({ status: 'skipped', error });
      } else if (row.attempts < 5) {
        summary.retry++;
        await finish({ status: 'failed', error });
      } else {
        summary.failed++;
        await finish({ status: 'skipped', error });
      }
    }
  }));
  return json({ ...summary, ms: Date.now() - started });
});
