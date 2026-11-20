/**
 * Synchronizacja w tle (`expo-background-task`, na Androidzie WorkManager): co ≥ 15 min, gdy jest
 * sieć, system budzi bundel bez ekranu — wysyłka outboxu, pobranie zmian, przeplanowanie
 * przypomnień (zmiany z webu) i odświeżenie widżetu. Wynik ostatniego przebiegu w kv-store
 * (wskaźnik w „Konto i synchronizacja”).
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { refreshTodayWidget } from '../widget/refresh';
import { readJson, serverConfig, sessionUser, writeJson } from './config';
import { flushErrors, reportError } from './error-log';
import { fillLinkPreviews, flushFiles } from './files';
import { scheduleReminders } from './scheduler';
import { syncNow } from './sync';

export const BACKGROUND_SYNC_TASK = 'taskplanner-background-sync';
/** Minuty; mniej niż 15 Android i tak nie pozwala. */
export const BACKGROUND_SYNC_MINUTES = 15;

export interface BackgroundRun {
  at: number;
  ok: boolean;
  ms: number;
  /** `false` — bez konta / serwera (tylko przypomnienia i widżet). */
  synced: boolean;
  error?: string;
}

const RUNS_KEY = 'sync.background';
export const backgroundRuns = () => readJson<BackgroundRun[]>(RUNS_KEY, []);

/** Jeden przebieg (z zadania w tle albo ręcznie z ustawień). */
export async function runBackgroundSync(): Promise<BackgroundRun> {
  const start = Date.now();
  const run: BackgroundRun = { at: start, ok: true, ms: 0, synced: false };
  try {
    if (sessionUser().online && serverConfig()) {
      await syncNow();
      run.synced = true;
      // Pliki i podglądy linków po synchronizacji (zadania już na serwerze).
      await flushFiles();
      await fillLinkPreviews();
    }
  } catch (error) {
    run.ok = false;
    run.error = error instanceof Error ? error.message : String(error);
    reportError('sync', error, { background: true });
  }
  await flushErrors();
  await scheduleReminders().catch(() => undefined);
  await refreshTodayWidget().catch(() => undefined);
  run.ms = Date.now() - start;
  writeJson(RUNS_KEY, [...backgroundRuns().slice(-49), run]);
  return run;
}

/** Definicja w zasięgu modułu (`background/register.ts`, przed Expo Routerem). */
export function defineBackgroundSync() {
  TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
    const run = await runBackgroundSync();
    return run.ok ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  });
}

/** Rejestracja przy starcie aplikacji z ekranem (raz; WorkManager pamięta ją po restarcie). */
export async function registerBackgroundSync() {
  if (Platform.OS !== 'android') return;
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
  if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) return;
  await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: BACKGROUND_SYNC_MINUTES });
}

export interface BackgroundState {
  available: boolean;
  registered: boolean;
}

export async function backgroundState(): Promise<BackgroundState> {
  if (Platform.OS !== 'android') return { available: false, registered: false };
  const [status, registered] = await Promise.all([BackgroundTask.getStatusAsync(), TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)]);
  return { available: status === BackgroundTask.BackgroundTaskStatus.Available, registered };
}
