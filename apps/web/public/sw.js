/**
 * Service Worker TaskPlannera (SPECYFIKACJA M20): powłoka aplikacji offline. Dane i tak są w lokalnej
 * bazie (SQLite w OPFS) — tu chodzi tylko o to, żeby strona, skrypty i SQLite WASM wczytały się bez
 * sieci. Rejestracja tylko w buildzie produkcyjnym (`lib/service-worker.ts`).
 *
 * - Nawigacja: najpierw sieć (nowe wdrożenie od razu), bez sieci — zapamiętana strona główna.
 * - `/_next/static/*`, `/sqlite-wasm/*`, ikony: najpierw pamięć (pliki z hashem / wersją w nazwie).
 * - Pozostałe pliki tej domeny (manifest, ikony aplikacji): pamięć, w tle odświeżenie.
 * - Inne domeny (Supabase, Google) i zapytania RSC — bez udziału SW.
 *
 * Strona po starcie wysyła listę już wczytanych plików (`cache-urls`) — pierwsza wizyta przed
 * przejęciem kontroli przez SW też zostaje w pamięci. Stare pliki `/_next/static` po wdrożeniach
 * zostają (kilka MB na wdrożenie); czyszczenie przy zmianie `VERSION`.
 */
const VERSION = 'v1';
const SHELL = `tp-shell-${VERSION}`;
const STATIC = `tp-static-${VERSION}`;
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

async function networkFirstPage(request) {
  try {
    const response = await fetch(request);
    // Pod kluczem „/”, niezależnie od `?code=` z logowania i części `#`.
    if (response.ok && response.type === 'basic') (await caches.open(SHELL)).put('/', response.clone());
    return response;
  } catch {
    return (await caches.match('/')) ?? Response.error();
  }
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
  if (request.mode === 'navigate') return event.respondWith(networkFirstPage(request));
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
