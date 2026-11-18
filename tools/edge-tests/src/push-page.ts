/**
 * `npm run push-page --workspace tools/edge-tests` — strona próbna Web Push na http://localhost:54592
 * (kryterium PoC-6: „push dociera do zamkniętej karty”). Wymaga lokalnego Supabase, `npm run dev:user`
 * i funkcji (`npm run serve --workspace tools/edge-tests`).
 *
 * 1. Otwórz stronę w Chrome, „Włącz powiadomienia” → subskrypcja zapisana dla dev@taskplanner.test.
 * 2. Zamknij kartę (przeglądarka zostaje uruchomiona).
 * 3. `curl -X POST "http://localhost:54592/send?delay=0"` → wpis w `push_queue`; `pg_cron` w ciągu minuty
 *    wywołuje `reminders-push`. Service Worker pokazuje powiadomienie i zgłasza odbiór na `/ack`
 *    (z liczbą otwartych okien strony — 0 = karta była zamknięta). Wyniki: `out/push-acks.jsonl`.
 */
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { readEnv } from './setup.ts';

const PORT = 54592;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = fileURLToPath(new URL('../out/', import.meta.url));
mkdirSync(out, { recursive: true });
const env = readEnv(`${root}supabase/functions/.env`);
if (!env.VAPID_PUBLIC_KEY) throw new Error('Brak kluczy VAPID — uruchom `npm run setup --workspace tools/edge-tests`.');
const raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const status = JSON.parse(raw.slice(raw.indexOf('{')));
const db = createClient(status.API_URL, status.SECRET_KEY ?? status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
const dev = users?.users.find((u) => u.email === 'dev@taskplanner.test');
if (!dev) throw new Error('Brak konta dev@taskplanner.test — uruchom `npm run dev:user`.');

const PAGE = `<!doctype html><html lang="pl"><meta charset="utf-8"><title>TaskPlanner — próba push</title>
<body style="font-family:system-ui;max-width:36rem;margin:3rem auto;line-height:1.5">
<h1>Próba Web Push (PoC-6)</h1>
<p>1. Włącz powiadomienia. 2. Zamknij tę kartę. 3. Wyślij próbę (<code>POST /send</code>).</p>
<button id="on" style="font-size:1.1rem;padding:.5rem 1rem">Włącz powiadomienia</button>
<pre id="log"></pre>
<script>
const log = (m) => (document.getElementById('log').textContent += m + '\\n');
const key = '${env.VAPID_PUBLIC_KEY}';
const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
document.getElementById('on').onclick = async () => {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if ((await Notification.requestPermission()) !== 'granted') return log('Brak zgody na powiadomienia.');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) }));
  const r = await fetch('/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
  log(r.ok ? 'Subskrypcja zapisana (' + new URL(sub.endpoint).host + '). Zamknij kartę.' : 'Błąd zapisu: ' + r.status);
};
</script></body></html>`;

const SW = `self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await self.registration.showNotification(data.title || 'TaskPlanner', { body: data.body || '', tag: data.id });
    await fetch('/ack', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: data.id, sentAt: data.sentAt, receivedAt: new Date().toISOString(), openWindows: windows.length }) });
  })());
});
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(self.clients.openWindow('/')); });`;

const body = (req: import('node:http').IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });

createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'service-worker-allowed': '/' });
      return res.end(SW);
    }
    if (req.method === 'POST' && url.pathname === '/subscribe') {
      const sub = JSON.parse(await body(req));
      const { error } = await db.from('push_subscriptions').upsert(
        { user_id: dev.id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_agent: req.headers['user-agent'] ?? null, failures: 0 },
        { onConflict: 'endpoint' });
      if (error) throw error;
      console.log(`subskrypcja: ${new URL(sub.endpoint).host}`);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      const delay = Number(url.searchParams.get('delay') ?? 0);
      const { data, error } = await db.from('push_queue')
        .insert({ user_id: dev.id, title: 'Próba PoC-6', body: `Wysłane ${new Date().toLocaleTimeString('pl-PL')}`, send_at: new Date(Date.now() + delay * 1000).toISOString() })
        .select('id, send_at').single();
      if (error) throw error;
      console.log(`w kolejce: ${data.id} (send_at ${data.send_at})`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    if (req.method === 'POST' && url.pathname === '/ack') {
      const ack = JSON.parse(await body(req));
      const { data: q } = await db.from('push_queue').select('send_at, sent_at').eq('id', ack.id).maybeSingle();
      const row = { ...ack, queuedSendAt: q?.send_at, delayFromSendAtMs: q ? Date.parse(ack.receivedAt) - Date.parse(q.send_at) : null };
      appendFileSync(`${out}push-acks.jsonl`, `${JSON.stringify(row)}\n`);
      console.log(`ODEBRANE: ${JSON.stringify(row)}`);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end(String(error));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Strona próbna: http://localhost:${PORT}`));
