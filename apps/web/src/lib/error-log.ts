"use client";

/**
 * Dziennik błędów w przeglądarce (Etap 13, D20): błędy z `window.onerror`, nieobsłużone obietnice,
 * granice błędów React (`app/error.tsx`, `app/global-error.tsx`) i synchronizacja (`lib/local-store.ts`)
 * trafiają do kolejki w `localStorage` (`core` `queueError` — ten sam błąd tylko zwiększa licznik),
 * a ta idzie paczką do `report_client_errors`, gdy jest sieć i zalogowany użytkownik. Błędy sieci
 * pomija `isTransientError`. Własne błędy wysyłki nie są zgłaszane (bez pętli).
 */
import { errorReport, parseErrorQueue, queueError, settleQueue, isTransientError, type ClientErrorReport, type ErrorKind } from "@taskplanner/core";

import { supabaseBrowser } from "./supabase-browser";

const KEY = "tp-error-queue";
const FLUSH_DELAY_MS = 5_000;
/** Skrót commita z Vercela (zmienna systemowa), lokalnie `dev`. */
export const APP_VERSION = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || (process.env.NODE_ENV === "production" ? "local" : "dev");

let installed = false;
let userId: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let memory: ClientErrorReport[] = [];

function readQueue(): ClientErrorReport[] {
  try {
    return parseErrorQueue(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return memory;
  }
}

function writeQueue(queue: ClientErrorReport[]) {
  memory = queue;
  try {
    if (queue.length) localStorage.setItem(KEY, JSON.stringify(queue));
    else localStorage.removeItem(KEY);
  } catch {
    // Pamięć przeglądarki niedostępna (tryb prywatny, limit) — kolejka zostaje w pamięci karty.
  }
}

function schedule(delay = FLUSH_DELAY_MS) {
  if (timer || typeof window === "undefined") return;
  timer = setTimeout(() => {
    timer = null;
    void flushErrors();
  }, delay);
}

/** Liczba niewysłanych wpisów (Ustawienia → „Błędy aplikacji”). */
export const queuedErrors = () => (typeof window === "undefined" ? 0 : readQueue().length);

/** Zgłoszenie błędu (bez rzucania): kolejka teraz, wysyłka po chwili. */
export function reportError(kind: ErrorKind, value: unknown, context?: Record<string, unknown>) {
  if (typeof window === "undefined" || isTransientError(value)) return;
  try {
    const report = errorReport(kind, value, {
      platform: "web",
      now: new Date(),
      appVersion: APP_VERSION,
      url: `${location.pathname}${location.hash}`,
      userAgent: navigator.userAgent,
      context,
    });
    writeQueue(queueError(readQueue(), report));
    if (process.env.NODE_ENV !== "production") console.warn("[dziennik błędów]", kind, report.message);
    schedule();
  } catch {
    // Dziennik nie może sam wywrócić aplikacji.
  }
}

/** Wysyłka kolejki — jedna karta naraz (Web Locks), reszta zostaje na następny raz. */
export async function flushErrors(): Promise<void> {
  if (!userId || !navigator.onLine || !readQueue().length) return;
  const send = async () => {
    const batch = readQueue().slice(0, 20);
    if (!batch.length) return;
    const { error } = await supabaseBrowser().rpc("report_client_errors", { p_items: batch });
    if (error) return;
    writeQueue(settleQueue(readQueue(), batch));
    if (readQueue().length) schedule(1_000);
  };
  try {
    if (navigator.locks) await navigator.locks.request("tp-error-flush", { ifAvailable: true }, (lock) => (lock ? send() : undefined));
    else await send();
  } catch {
    // Bez sieci / serwer niedostępny — spróbujemy przy następnym błędzie albo po powrocie sieci.
  }
}

/** Zalogowany użytkownik (wysyłka tylko z kontem); `null` po wylogowaniu. */
export function setErrorUser(id: string | null) {
  userId = id;
  if (id) schedule(1_000);
}

/** Globalne nasłuchy — raz na kartę (`AppRoot`). */
export function installErrorLog() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    // Błąd wczytania zasobu (<img>, <script>) nie ma `error` — to nie wyjątek aplikacji.
    if (!event.error && !event.message) return;
    reportError("error", event.error ?? event.message, event.filename ? { source: event.filename, line: event.lineno, column: event.colno } : undefined);
  });
  window.addEventListener("unhandledrejection", (event) => reportError("unhandled", event.reason));
  window.addEventListener("online", () => schedule(1_000));
}
