"use client";

/**
 * Rejestracja Service Workera (`public/sw.js`) i trwała pamięć przeglądarki (M20). Tylko w buildzie
 * produkcyjnym — w `next dev` SW przeszkadzałby w odświeżaniu kodu.
 */

export interface OfflineStatus {
  /** SW kontroluje stronę — start bez sieci działa. */
  serviceWorker: "active" | "installing" | "unsupported" | "dev";
  /** `navigator.storage.persist()` — przeglądarka nie wyczyści lokalnej bazy przy braku miejsca. */
  persisted: boolean | null;
  /**
   * Nowy Service Worker (nowe `VERSION` w `sw.js`) przejął stronę, która już działała pod
   * poprzednim — ta karta ma jeszcze stary kod; odświeżenie wczyta nowy (Ustawienia → „Wersja aplikacji”).
   */
  updated: boolean;
}

let status: OfflineStatus = { serviceWorker: "installing", persisted: null, updated: false };
const listeners = new Set<() => void>();
const update = (patch: Partial<OfflineStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
};

export const offlineStatus = () => status;
export const subscribeOffline = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

let started = false;

export function startOfflineSupport() {
  if (started || typeof window === "undefined") return;
  started = true;

  if (navigator.storage?.persist) {
    void navigator.storage
      .persisted()
      .then((already) => (already ? true : navigator.storage.persist()))
      .then((persisted) => update({ persisted }))
      .catch(() => update({ persisted: false }));
  }

  if (process.env.NODE_ENV !== "production") return update({ serviceWorker: "dev" });
  if (!("serviceWorker" in navigator)) return update({ serviceWorker: "unsupported" });

  void navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      // Pliki wczytane przed przejęciem kontroli przez SW (pierwsza wizyta) — też do pamięci.
      registration.active?.postMessage({ type: "cache-urls", urls: loadedUrls() });
      update({ serviceWorker: navigator.serviceWorker.controller ? "active" : "installing" });
    })
    .catch(() => update({ serviceWorker: "unsupported" }));
  // Nowy SW (pierwsza wizyta albo nowe `VERSION` w `sw.js`) zaczyna z pustą pamięcią plików, a ta
  // strona wczytała już swoje skrypty przez poprzedniego — bez ponownej listy start offline by nie
  // działał do następnego wejścia z siecią.
  // Strona miała już kontrolera = to nie pierwsza instalacja, tylko aktualizacja SW.
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    navigator.serviceWorker.controller?.postMessage({ type: "cache-urls", urls: loadedUrls() });
    update({ serviceWorker: "active", ...(hadController && { updated: true }) });
  });
}

const loadedUrls = () => performance.getEntriesByType("resource").map((e) => e.name);

/** Pliki, które SW trzyma w pamięci (`isStatic` w `sw.js`) — reszta idzie z sieci albo z bazy. */
const offlineFile = (url: URL) => url.origin === location.origin && /^\/(_next\/static|sqlite-wasm|icons)\//.test(url.pathname);

export interface OfflineCheck {
  total: number;
  missing: string[];
}

/**
 * Czy start bez sieci ma wszystko: strona główna, SQLite WASM i każdy plik powłoki, który ta strona
 * wczytała, są w pamięci SW. Sprawdza tylko to, co już wczytano — widoki są w jednym
 * pakiecie, a oś czasu dociąga się w wolnej chwili po starcie (`shell.tsx`).
 */
export async function checkOfflineCache(): Promise<OfflineCheck | null> {
  if (typeof caches === "undefined" || !navigator.serviceWorker?.controller) return null;
  const urls = [...new Set(loadedUrls())].map((href) => new URL(href)).filter(offlineFile);
  const required = ["/", "/sqlite-wasm/index.mjs", "/sqlite-wasm/sqlite3.wasm", ...urls.map((u) => u.pathname + u.search)];
  const missing: string[] = [];
  for (const path of new Set(required)) if (!(await caches.match(path))) missing.push(path);
  return { total: new Set(required).size, missing };
}
