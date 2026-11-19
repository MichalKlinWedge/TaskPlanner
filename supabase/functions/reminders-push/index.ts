/**
 * `reminders-push` — Web Push (VAPID, aes128gcm) z `pg_cron` co minutę (SPECYFIKACJA M8 web, PoC-6).
 *
 * Pobiera należne wpisy `push_queue` (`claim_push_queue`: `skip locked`, bez podwójnej wysyłki), wysyła
 * na wszystkie subskrypcje użytkownika i zapisuje wynik. Ukończone / usunięte zadanie — bez powiadomienia
 * (status sprawdzany w chwili wysyłki). Subskrypcja 404/410 jest usuwana. W MVP-4 kolejkę zasila
 * `core/reminders.ts` (`reminderFireTimes`) z dziennikiem wysyłek per urządzenie.
 *
 * Sekrety: `VAPID_KEYS` (JSON z `exportVapidKeys`, `npm run vapid --workspace tools/edge-tests`),
 * `VAPID_SUBJECT` (`mailto:` albo `https:`), `CRON_SECRET`.
 */
import * as webpush from '@negrel/webpush';

import { admin, env, HttpError, json, optionalEnv, requireCron, serve } from '../_shared/runtime.ts';

interface QueueRow {
  id: string;
  user_id: string;
  task_id: string | null;
  title: string;
  body: string | null;
  url: string | null;
  attempts: number;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failures: number;
}

let server: webpush.ApplicationServer | null = null;

async function appServer(): Promise<webpush.ApplicationServer> {
  if (!server) {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(env('VAPID_KEYS')), { extractable: false });
    server = await webpush.ApplicationServer.new({ contactInformation: env('VAPID_SUBJECT'), vapidKeys });
  }
  return server;
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Tylko POST');
  requireCron(req);
  const started = Date.now();
  const db = admin();
  const { data: due, error } = await db.rpc('claim_push_queue', { p_limit: 200 });
  if (error) throw error;
  const items = (due ?? []) as QueueRow[];
  if (!items.length) return json({ items: 0, ms: Date.now() - started });

  const users = [...new Set(items.map((i) => i.user_id))];
  const { data: subs, error: subsError } = await db.from('push_subscriptions').select('*').in('user_id', users);
  if (subsError) throw subsError;
  const taskIds = items.map((i) => i.task_id).filter((id): id is string => !!id);
  const { data: tasks } = taskIds.length
    ? await db.from('tasks').select('id, status, deleted_at').in('id', taskIds)
    : { data: [] as { id: string; status: string; deleted_at: string | null }[] };
  const closed = new Set((tasks ?? []).filter((t) => t.deleted_at || t.status === 'done' || t.status === 'cancelled').map((t) => t.id));

  const as = await appServer();
  const allowHttp = optionalEnv('PUSH_ALLOW_HTTP') === '1';
  const gone = new Set<string>();
  const failed = new Map<string, number>();
  const succeeded = new Set<string>();
  const summary = { items: items.length, sent: 0, skipped: 0, retry: 0, gone: 0 };

  await Promise.all(items.map(async (item) => {
    const finish = (patch: Record<string, unknown>) => db.from('push_queue').update(patch).eq('id', item.id);
    if (item.task_id && closed.has(item.task_id)) {
      summary.skipped++;
      return finish({ sent_at: new Date().toISOString(), delivered: 0, error: 'zadanie zamknięte' });
    }
    const targets = ((subs ?? []) as SubscriptionRow[]).filter((s) => s.user_id === item.user_id && (allowHttp || s.endpoint.startsWith('https://')));
    if (!targets.length) {
      summary.skipped++;
      return finish({ sent_at: new Date().toISOString(), delivered: 0, error: 'brak subskrypcji' });
    }
    const payload = JSON.stringify({ id: item.id, title: item.title, body: item.body, url: item.url, taskId: item.task_id, sentAt: new Date().toISOString() });
    let delivered = 0;
    const errors: string[] = [];
    let transient = false;
    for (const sub of targets) {
      try {
        await as.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })
          .pushTextMessage(payload, { ttl: 600, urgency: webpush.Urgency.High, topic: item.id.replaceAll('-', '').slice(0, 32) });
        delivered++;
        succeeded.add(sub.id);
      } catch (e) {
        const status = e instanceof webpush.PushMessageError ? e.response.status : 0;
        if (status === 404 || status === 410) gone.add(sub.id);
        else {
          transient = true;
          failed.set(sub.id, sub.failures + 1);
        }
        errors.push(`${status || 'sieć'}: ${(e as Error).message}`.slice(0, 200));
      }
    }
    // Nic nie doszło z przyczyn przejściowych → ponowienie w następnej minucie (najwyżej 5 prób).
    if (!delivered && transient && item.attempts < 5) {
      summary.retry++;
      return finish({ claimed_at: null, error: errors.join('; ') });
    }
    summary.sent += delivered ? 1 : 0;
    return finish({ sent_at: new Date().toISOString(), delivered, error: errors.length ? errors.join('; ') : null });
  }));

  if (gone.size) {
    summary.gone = gone.size;
    await db.from('push_subscriptions').delete().in('id', [...gone]);
  }
  for (const [id, failures] of failed) await db.from('push_subscriptions').update({ failures }).eq('id', id);
  if (succeeded.size) await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failures: 0 }).in('id', [...succeeded]);
  return json({ ...summary, ms: Date.now() - started });
});
