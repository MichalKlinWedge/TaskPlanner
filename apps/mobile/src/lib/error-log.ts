/**
 * Dziennik błędów na telefonie (Etap 13, D20) — ten sam RPC `report_client_errors` i ta sama logika
 * z `core/errors.ts` co web (`apps/web/src/lib/error-log.ts`). Źródła: globalny handler JS
 * (`ErrorUtils`), nieobsłużone obietnice (śledzenie odrzuceń Hermesa), granica błędów w root layout
 * (`ErrorBoundary` w `app/_layout.tsx`) i synchronizacja (`lib/sync.ts`). Kolejka jest trwała
 * (`expo-sqlite/kv-store`, zapis synchroniczny — błąd krytyczny zamyka aplikację, wpis zostaje
 * i idzie przy następnym starcie). Wysyłka paczką, gdy jest konto i sieć: 5 s po błędzie, przy
 * starcie, po udanej synchronizacji i w zadaniu w tle. Błędy sieci pomija `isTransientError`,
 * własne błędy wysyłki nie są zgłaszane (bez pętli).
 */
import { errorReport, isTransientError, parseErrorQueue, queueError, settleQueue, type ClientErrorReport, type ErrorKind } from '@taskplanner/core';
import * as Application from 'expo-application';
import { Platform } from 'react-native';

import { readJson, serverConfig, sessionUser, writeJson } from './config';
// Cykl z `sync.ts` (który zgłasza błędy synchronizacji) jest bezpieczny: oba używają się dopiero w funkcjach.
import { supabaseClient } from './sync';

const KEY = 'errors.queue';
const FLUSH_DELAY_MS = 5_000;

/** `versionName (versionCode)` z APK, np. `0.1.0 (1)`. */
export const APP_VERSION = `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;

const constants = Platform.constants as { Brand?: string; Model?: string; Release?: string };
const DEVICE = Platform.OS === 'android' ? `Android ${constants.Release ?? Platform.Version}; ${[constants.Brand, constants.Model].filter(Boolean).join(' ')}` : Platform.OS;

let route: string | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> | null = null;
let installed = false;
const listeners = new Set<() => void>();

/** Bieżący ekran (ustawiany z root layout) — trafia do pola `url`. */
export const setErrorRoute = (path: string) => {
  route = path;
};

const readQueue = (): ClientErrorReport[] => parseErrorQueue(readJson<unknown>(KEY, []));

function writeQueue(queue: ClientErrorReport[]) {
  writeJson(KEY, queue);
  listeners.forEach((l) => l());
}

/** Liczba niewysłanych wpisów (Ustawienia → „Błędy aplikacji”). */
export const queuedErrors = () => readQueue().length;

export function onErrorQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function schedule(delay = FLUSH_DELAY_MS) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushErrors();
  }, delay);
}

/** Zgłoszenie błędu (bez rzucania): kolejka od razu, wysyłka po chwili. */
export function reportError(kind: ErrorKind, value: unknown, context?: Record<string, unknown>) {
  if (isTransientError(value)) return;
  try {
    const report = errorReport(kind, value, { platform: 'android', now: new Date(), appVersion: APP_VERSION, url: route, userAgent: DEVICE, context });
    writeQueue(queueError(readQueue(), report));
    if (__DEV__) console.warn('[dziennik błędów]', kind, report.message);
    schedule();
  } catch {
    // Dziennik nie może sam wywrócić aplikacji.
  }
}

/** Wysyłka kolejki paczkami po 20 (limit RPC); jedna wysyłka naraz w procesie. */
export function flushErrors(): Promise<void> {
  if (sending) return sending;
  const run = async () => {
    // Najpierw `await`: przy pustej kolejce `finally` zerowałby `sending` przed przypisaniem obietnicy.
    await Promise.resolve();
    try {
      if (!sessionUser().online || !serverConfig()) return;
      for (let round = 0; round < 10; round++) {
        const batch = readQueue().slice(0, 20);
        if (!batch.length) return;
        const { error } = await supabaseClient().rpc('report_client_errors', { p_items: batch });
        if (error) return;
        writeQueue(settleQueue(readQueue(), batch));
      }
    } catch {
      // Bez sieci / serwer niedostępny — spróbujemy przy następnej okazji.
    } finally {
      sending = null;
    }
  };
  sending = run();
  return sending;
}

interface HermesTracker {
  enablePromiseRejectionTracker?: (options: { allRejections: boolean; onUnhandled: (id: number, rejection: unknown) => void; onHandled: (id: number) => void }) => void;
}

/** Globalne nasłuchy — raz na proces (`index.ts`, przed Expo Routerem; działa też bez ekranu). */
export function installErrorLog() {
  if (installed) return;
  installed = true;
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    reportError('error', error, isFatal ? { fatal: true } : undefined);
    previous(error, isFatal);
  });
  const hermes = (globalThis as { HermesInternal?: HermesTracker }).HermesInternal;
  // Zastępuje śledzenie z React Native (w dev ostrzeżenie w LogBox) — ostrzeżenie zostaje w konsoli.
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => {
      if (__DEV__) console.warn('Nieobsłużone odrzucenie obietnicy', rejection);
      reportError('unhandled', rejection);
    },
    onHandled: () => undefined,
  });
}
