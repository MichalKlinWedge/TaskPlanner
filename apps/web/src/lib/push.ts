"use client";

/**
 * Przypomnienia w przeglądarce (M8 web): ta przeglądarka jako wiersz `devices` z subskrypcją Web Push.
 * Wiersz idzie zwykłą synchronizacją (`mutate` → `push_changes`), a serwer (`reminders-push`) wysyła
 * przypomnienia na urządzenia z `reminder_channel = 'enabled'` — wybór urządzeń w ustawieniach.
 * Klucz publiczny VAPID podaje funkcja (`GET …/reminders-push/key`), więc web nie ma osobnej zmiennej.
 * Push wymaga Service Workera, a ten działa tylko w buildzie produkcyjnym (`lib/service-worker.ts`).
 */
import { uuidv7 } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";

export type PushSupport = "ok" | "dev" | "unsupported" | "denied";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (process.env.NODE_ENV !== "production") return "dev";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission === "denied" ? "denied" : "ok";
}

/** Id tej przeglądarki dla danego użytkownika (jeden wiersz `devices` na przeglądarkę). */
export function browserDeviceId(userId: string): string {
  const key = `tp-device:${userId}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = uuidv7();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return uuidv7();
  }
}

/** „Chrome na Windows” — nazwa urządzenia na liście w ustawieniach. */
export function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Przeglądarka";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Androidzie" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linuksie" : null;
  return os ? `${browser} na ${os}` : browser;
}

const bytes = (base64url: string) => Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function vapidKey(): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL.");
  const res = await fetch(`${url.replace(/\/$/, "")}/functions/v1/reminders-push/key`);
  if (!res.ok) throw new Error(`Serwer przypomnień niedostępny (${res.status}).`);
  const { publicKey } = (await res.json()) as { publicKey?: string };
  if (!publicKey) throw new Error("Serwer nie podał klucza push.");
  return publicKey;
}

/** Zgoda, subskrypcja i wiersz urządzenia z włączonymi przypomnieniami. */
export async function enableBrowserReminders(store: TabStore, userId: string): Promise<void> {
  const support = pushSupport();
  if (support === "dev") throw new Error("Powiadomienia push działają w wersji produkcyjnej (Service Worker).");
  if (support !== "ok") throw new Error(support === "denied" ? "Powiadomienia są zablokowane w ustawieniach przeglądarki." : "Ta przeglądarka nie obsługuje powiadomień push.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Bez zgody na powiadomienia przypomnienia nie przyjdą.");
  const registration = await navigator.serviceWorker.ready;
  const key = await vapidKey();
  let subscription = await registration.pushManager.getSubscription();
  // Subskrypcja z innym kluczem (np. po zmianie serwera) — nowa.
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && btoa(String.fromCharCode(...new Uint8Array(current))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== key) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  await store.mutate("devices", browserDeviceId(userId), {
    name: browserName(),
    platform: "web",
    reminder_channel: "enabled",
    push_subscription: subscription.toJSON(),
  });
}

/** Wyłączenie przypomnień na urządzeniu (tym albo innym z listy). */
export const setDeviceReminders = (store: TabStore, deviceId: string, enabled: boolean) =>
  store.mutate("devices", deviceId, { reminder_channel: enabled ? "enabled" : "disabled" });

/** Urządzenie znika z listy (np. stara przeglądarka); telefon / przeglądarka doda się znowu przy włączeniu. */
export const forgetDevice = (store: TabStore, deviceId: string) => store.mutate("devices", deviceId, { deleted_at: new Date().toISOString() });
