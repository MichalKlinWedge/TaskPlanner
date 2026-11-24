/**
 * Service Worker Task Plannera (SPECYFIKACJA M20): powłoka aplikacji offline. Dane i tak są w lokalnej
 * bazie (SQLite w OPFS) — tu chodzi tylko o to, żeby strona, skrypty i SQLite WASM wczytały się bez
 * sieci. Rejestracja tylko w buildzie produkcyjnym (`lib/service-worker.ts`).
 *
 * - Nawigacja: najpierw sieć (nowe wdrożenie od razu), bez sieci albo po `PAGE_TIMEOUT` przy słabej
 *   sieci — zapamiętana strona tej ścieżki, inaczej główna (także skróty z manifestu: `/?quick=1`,
 *   `/#/calendar`).
 * - `/_next/static/*`, `/sqlite-wasm/*`, ikony: najpierw pamięć (pliki z hashem / wersją w nazwie).
 * - Pozostałe pliki tej domeny (manifest, ikony aplikacji): pamięć, w tle odświeżenie.
 * - Inne domeny (Supabase, Google) i zapytania RSC — bez udziału SW.
 *
 * Strona po starcie wysyła listę już wczytanych plików (`cache-urls`) — pierwsza wizyta przed
 * przejęciem kontroli przez SW też zostaje w pamięci. Stare pliki `/_next/static` po wdrożeniach
 * zostają (kilka MB na wdrożenie); czyszczenie przy zmianie `VERSION`.
 *
 * Web Push (M8): przypomnienie z `reminders-push` → powiadomienie systemowe (także przy zamkniętej
 * karcie); otwarta karta dostaje też wiadomość `reminder` (dymek w aplikacji). Klik w powiadomienie
 * otwiera zadanie w istniejącej karcie (`open-task`) albo w nowej (`/?task=<id>`).
 *
 * Nawyk (Etap 8): powiadomienie ma akcję „Zrobione”. SW nie ma dostępu do lokalnej bazy (SQLite w
 * workerze karty-lidera), więc przekazuje odhaczenie otwartej karcie (`habit-done`) albo otwiera nową
 * (`/?habitDone=<id>&date=<dzień>`) — zapis robi aplikacja (`habitEntryOps`). Zadanie tak samo ma „Ukończ”
 * i „Odłóż 10 min” (`reminder-action` / `/?reminderAction=…`, `components/app/reminder-actions.tsx`).
 */
const VERSION = 'v3';
const SHELL = `tp-shell-${VERSION}`;
const STATIC = `tp-static-${VERSION}`;
const PAGE_TIMEOUT = 4000;
const PRECACHE = ['/', '/manifest.webmanifest', '/icon.svg', '/icons/icon-192.png', '/sqlite-wasm/index.mjs', '/sqlite-wasm/sqlite3.wasm'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Pojedynczy brakujący plik nie blokuje instalacji (np. ikona w trakcie zmiany marki).
      await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, STATIC]);
      for (const name of await caches.keys()) if (name.startsWith('tp-') && !keep.has(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

const isStatic = (url) => url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/sqlite-wasm/') || url.pathname.startsWith('/icons/');

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(STATIC)).put(request, response.clone());
  return response;
}

async function networkFirstPage(event) {
  // Pod ścieżką, bez `?code=` z logowania, `?quick=1` ze skrótu i części `#` (strona `/prywatnosc`
  // nie może zastąpić zapamiętanej aplikacji).
  const key = new URL(event.request.url).pathname;
  const network = fetch(event.request).then(async (response) => {
    if (response.ok && response.type === 'basic') await (await caches.open(SHELL)).put(key, response.clone());
    return response;
  });
  // „Wi-Fi bez internetu” nie odpowiada wcale — po czasie strona z pamięci; odpowiedź sieci, gdy
  // przyjdzie, odświeży zapamiętaną stronę na następny start.
  event.waitUntil(network.catch(() => undefined));
  const timeout = new Promise((resolve) => setTimeout(resolve, PAGE_TIMEOUT));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
  } catch {
    // Bez sieci — niżej strona z pamięci.
  }
  return (await caches.match(key)) ?? (await caches.match('/')) ?? network.catch(() => Response.error());
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await fresh) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.get('RSC') || url.searchParams.has('_rsc') || url.pathname.startsWith('/dev/') || url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') return event.respondWith(networkFirstPage(event));
  if (isStatic(url)) return event.respondWith(cacheFirst(request));
  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache-urls') return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC);
      for (const href of event.data.urls) {
        const url = new URL(href, self.location.origin);
        if (url.origin !== self.location.origin || !isStatic(url) || (await cache.match(url.href))) continue;
        await cache.add(url.href).catch(() => undefined);
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data?.text() };
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (data.focus) {
        // Koniec etapu skupienia: karta na wierzchu sama gra dźwięk i pokazuje dymek; ten sam `tag`
        // co powiadomienie z karty w tle — jedno zastępuje drugie.
        if (windows.some((w) => w.focused)) return;
        return void (await self.registration.showNotification(data.title || 'Task Planner', {
          body: data.body || '',
          tag: 'tp-focus',
          icon: '/icons/icon-192.png',
          data: { url: data.url || '/#/focus' },
        }));
      }
      await self.registration.showNotification(data.title || 'Task Planner', {
        body: data.body || '',
        tag: data.key,
        icon: '/icons/icon-192.png',
        data: { url: data.url || '/', taskId: data.taskId, key: data.key, habit: Boolean(data.habit), date: data.date },
        actions: data.habit
          ? [{ action: 'habit-done', title: 'Zrobione' }]
          : data.taskId && data.key
            ? [
                { action: 'done', title: 'Ukończ' },
                { action: 'snooze', title: 'Odłóż 10 min' },
              ]
            : [],
      });
      for (const client of windows) {
        client.postMessage({ type: 'reminder', title: data.title, body: data.body, taskId: data.taskId });
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/', taskId, key, habit, date } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (event.action === 'habit-done' && habit && taskId && date) {
        if (open) return open.postMessage({ type: 'habit-done', taskId, date });
        return void (await self.clients.openWindow(`/?habitDone=${encodeURIComponent(taskId)}&date=${encodeURIComponent(date)}#/today`));
      }
      if ((event.action === 'done' || event.action === 'snooze') && taskId && key) {
        if (open) return open.postMessage({ type: 'reminder-action', action: event.action, taskId, key });
        const params = new URLSearchParams({ reminderAction: event.action, reminderTask: taskId, reminderKey: key });
        return void (await self.clients.openWindow(`/?${params}#/today`));
      }
      if (open) {
        await open.focus();
        if (taskId) open.postMessage({ type: 'open-task', taskId });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
