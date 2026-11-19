/**
 * PoC-4: przypomnienia lokalne (`expo-notifications`) — seria testowa, akcje „Ukończ” / „Odłóż”
 * przy zamkniętej aplikacji i pomiar opóźnień.
 *
 * Akcje: przyciski z `opensAppToForeground: false`. Gdy aplikacja nie jest na wierzchu, Android
 * uruchamia zadanie z `registerTaskAsync` (bundel bez ekranu); na wierzchu — słuchacz odpowiedzi.
 * W tle (proces żyje) wywołują się oba, więc obsługa jest idempotentna (klucz powiadomienie+akcja).
 *
 * Pomiar: `date` powiadomienia z zasobnika = `postTime` z Androida (chwila pokazania), w treści
 * zapisany planowany czas. Wyniki trzymane w kv-store — przeżywają zamknięcie aplikacji.
 */
import { uuidv7 } from '@taskplanner/core';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { readJson, writeJson } from './config';
import { completeTask, createTask, getTask, postponeToTomorrow, reminderListId } from './tasks';
import { toLocalDate, toLocalTime } from './time';
import { refreshTodayWidget } from '../widget/refresh';

export const NOTIFICATION_TASK = 'taskplanner-notification-response';
export const CHANNEL_ID = 'reminders';
/** Bez „:” i „-” (wymóg `setNotificationCategoryAsync`). */
export const CATEGORY_ID = 'task_reminder';
export const ACTION = { complete: 'complete', snooze: 'snooze10', tomorrow: 'tomorrow' } as const;

export type Delivery = 'bestEffort' | 'alarmClock';

export interface ReminderData extends Record<string, unknown> {
  taskId: string;
  /** Planowany czas (ms). */
  at: number;
  batch?: string;
}

export interface Batch {
  id: string;
  createdAt: number;
  count: number;
  hours: number;
  delivery: Delivery;
  exactAllowed: boolean;
  ids: string[];
  /** Planowane czasy (ms), w kolejności `ids`. */
  ats: number[];
}

export interface DeliveryRecord {
  at: number;
  shownAt: number;
  batch: string;
  via: 'tray' | 'action' | 'foreground';
}

export interface ActionLog {
  at: number;
  action: string;
  taskId: string;
  notificationId: string;
  appState: 'background-task' | 'foreground';
  ok: boolean;
  error?: string;
}

const K = { batches: 'poc4.batches', deliveries: 'poc4.deliveries', actions: 'poc4.actions', handled: 'poc4.handled' } as const;

export const batches = () => readJson<Batch[]>(K.batches, []);
export const deliveries = () => readJson<Record<string, DeliveryRecord>>(K.deliveries, {});
export const actionLog = () => readJson<ActionLog[]>(K.actions, []);

function recordDelivery(id: string, data: Partial<ReminderData> | undefined, shownAt: number, via: DeliveryRecord['via']) {
  if (!data?.batch || typeof data.at !== 'number') return;
  const all = deliveries();
  if (all[id]) return;
  all[id] = { at: data.at, shownAt, batch: data.batch, via };
  writeJson(K.deliveries, all);
}

/** Dane powiadomienia na Androidzie bywają w `data` albo jako tekst w `dataString`. */
function contentData(content: Record<string, unknown> | undefined): Partial<ReminderData> | undefined {
  if (!content) return undefined;
  if (content.data && typeof content.data === 'object') return content.data as Partial<ReminderData>;
  if (typeof content.dataString === 'string') {
    try {
      return JSON.parse(content.dataString) as Partial<ReminderData>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ── Konfiguracja (start aplikacji z ekranem) ─────────────────────────────────────────────────

let configured = false;

export async function setupNotifications() {
  if (Platform.OS !== 'android' || configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      recordDelivery(notification.request.identifier, contentData(notification.request.content as never), notification.date, 'foreground');
      return { shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true };
    },
  });
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Przypomnienia o zadaniach',
    importance: AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 120, 200],
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    { identifier: ACTION.complete, buttonTitle: 'Ukończ', options: { opensAppToForeground: false } },
    { identifier: ACTION.snooze, buttonTitle: 'Odłóż 10 min', options: { opensAppToForeground: false } },
    { identifier: ACTION.tomorrow, buttonTitle: 'Jutro', options: { opensAppToForeground: false } },
  ]);
  if (!(await TaskManager.isTaskRegisteredAsync(NOTIFICATION_TASK))) await Notifications.registerTaskAsync(NOTIFICATION_TASK);
}

export interface PermissionState {
  notifications: boolean;
  exactAlarms: boolean;
}

export async function permissionState(): Promise<PermissionState> {
  const [n, e] = await Promise.all([Notifications.getPermissionsAsync(), Notifications.getExactAlarmPermissionsAsync()]);
  return { notifications: n.granted, exactAlarms: e.granted };
}

export async function requestNotificationPermission() {
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Otwiera ustawienia systemu („Alarmy i przypomnienia”); Promise kończy się po powrocie. */
export async function requestExactAlarms() {
  return (await Notifications.requestExactAlarmPermissionsAsync()).granted;
}

// ── Seria testowa ────────────────────────────────────────────────────────────────────────────

export async function scheduleBatch({ count, hours, delivery, firstInMin = 2 }: { count: number; hours: number; delivery: Delivery; firstInMin?: number }): Promise<Batch> {
  await setupNotifications();
  const { exactAlarms } = await permissionState();
  const listId = await reminderListId();
  const id = uuidv7().slice(-8);
  const start = Date.now() + firstInMin * 60_000;
  const step = count > 1 ? (hours * 3_600_000) / (count - 1) : 0;
  const ids: string[] = [];
  const ats: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = Math.round((start + i * step) / 1000) * 1000;
    const when = new Date(at);
    const taskId = await createTask({
      list_id: listId,
      title: `Przypomnienie ${i + 1}/${count} (${id})`,
      due_date: toLocalDate(when),
      due_time: toLocalTime(when),
    });
    const identifier = `poc4_${id}_${i}`;
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: `Przypomnienie ${i + 1}/${count}`,
        body: `Planowo ${toLocalTime(when)}:${String(when.getSeconds()).padStart(2, '0')} · seria ${id} · ${delivery}${exactAlarms ? '' : ', bez dokładnych alarmów'}`,
        data: { taskId, at, batch: id } satisfies ReminderData,
        categoryIdentifier: CATEGORY_ID,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL_ID, delivery },
    });
    ids.push(identifier);
    ats.push(at);
  }
  const batch: Batch = { id, createdAt: Date.now(), count, hours, delivery, exactAllowed: exactAlarms, ids, ats };
  writeJson(K.batches, [...batches(), batch]);
  return batch;
}

export async function cancelBatch(batch: Batch) {
  for (const id of batch.ids) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
}

export async function scheduledCount(): Promise<number> {
  return (await Notifications.getAllScheduledNotificationsAsync()).length;
}

/** Zbiera pokazane powiadomienia z zasobnika (zapis czasu pokazania) i usuwa zebrane. */
export async function collectDeliveries(dismiss = true): Promise<number> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  let n = 0;
  for (const notification of presented) {
    const data = contentData(notification.request.content as never);
    if (!data?.batch) continue;
    recordDelivery(notification.request.identifier, data, notification.date, 'tray');
    n++;
    if (dismiss) await Notifications.dismissNotificationAsync(notification.request.identifier).catch(() => undefined);
  }
  return n;
}

export interface BatchStats {
  scheduled: number;
  due: number;
  delivered: number;
  within1: number;
  within10: number;
  medianS: number | null;
  p95S: number | null;
  maxS: number | null;
}

export function batchStats(batch: Batch, now = Date.now()): BatchStats {
  const all = deliveries();
  const delays = batch.ids
    .map((id) => all[id])
    .filter(Boolean)
    .map((d) => (d.shownAt - d.at) / 1000)
    .sort((a, b) => a - b);
  const due = batch.ats.filter((at) => at <= now).length;
  const at = (q: number) => (delays.length ? delays[Math.min(delays.length - 1, Math.floor(q * delays.length))] : null);
  return {
    scheduled: batch.count,
    due,
    delivered: delays.length,
    within1: delays.filter((d) => Math.abs(d) <= 60).length,
    within10: delays.filter((d) => Math.abs(d) <= 600).length,
    medianS: at(0.5),
    p95S: at(0.95),
    maxS: delays.length ? delays[delays.length - 1] : null,
  };
}

export function resetMeasurements() {
  writeJson(K.batches, []);
  writeJson(K.deliveries, {});
  writeJson(K.actions, []);
  writeJson(K.handled, []);
}

// ── Akcje z powiadomienia ────────────────────────────────────────────────────────────────────

const inFlight = new Set<string>();

function logAction(entry: ActionLog) {
  writeJson(K.actions, [...actionLog().slice(-199), entry]);
}

/** Wspólna obsługa odpowiedzi: zadanie w tle i słuchacz na wierzchu. */
export async function handleResponse(response: Notifications.NotificationResponse | Record<string, unknown>, appState: ActionLog['appState']) {
  const r = response as { actionIdentifier?: string; notification?: { date?: number; request?: { identifier?: string; content?: Record<string, unknown> } } };
  const action = r.actionIdentifier;
  if (!action || action === Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const notificationId = r.notification?.request?.identifier ?? '';
  const data = contentData(r.notification?.request?.content);
  const key = `${notificationId}:${action}`;
  const handled = readJson<string[]>(K.handled, []);
  if (inFlight.has(key) || handled.includes(key)) return;
  inFlight.add(key);
  const entry: ActionLog = { at: Date.now(), action, taskId: data?.taskId ?? '', notificationId, appState, ok: true };
  try {
    if (data) recordDelivery(notificationId, data, r.notification?.date ?? Date.now(), 'action');
    if (!data?.taskId) throw new Error('brak taskId w powiadomieniu');
    if (action === ACTION.complete) await completeTask(data.taskId);
    else if (action === ACTION.tomorrow) await postponeToTomorrow(data.taskId);
    else if (action === ACTION.snooze) {
      const task = await getTask(data.taskId);
      const at = Date.now() + 10 * 60_000;
      await Notifications.scheduleNotificationAsync({
        identifier: `${notificationId}_s`,
        content: { title: `Odłożone: ${task?.title ?? 'zadanie'}`, body: `Ponownie o ${toLocalTime(new Date(at))}`, data: { taskId: data.taskId, at }, categoryIdentifier: CATEGORY_ID },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL_ID },
      });
    }
    if (notificationId)
      await Notifications.dismissNotificationAsync(notificationId).catch((e: unknown) => {
        entry.error = `dismiss: ${e instanceof Error ? e.message : String(e)}`;
      });
    writeJson(K.handled, [...handled.slice(-499), key]);
    await refreshTodayWidget().catch(() => undefined);
  } catch (error) {
    entry.ok = false;
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    inFlight.delete(key);
    logAction(entry);
  }
}

/** Raport do wklejenia w `docs/POC_WYNIKI.md`. */
export function report(): string {
  const lines = ['PoC-4 przypomnienia — raport z telefonu', `Wygenerowano: ${new Date().toISOString()}`, ''];
  for (const batch of batches()) {
    const s = batchStats(batch);
    lines.push(
      `Seria ${batch.id}: ${batch.count} w ${batch.hours} h, delivery=${batch.delivery}, dokładne alarmy=${batch.exactAllowed ? 'tak' : 'nie'}, start ${new Date(batch.createdAt).toISOString()}`,
      `  pokazane ${s.delivered}/${s.due} (z ${s.scheduled} zaplanowanych); ±1 min: ${s.within1} (${s.delivered ? Math.round((100 * s.within1) / s.delivered) : 0} %); ≤10 min: ${s.within10}; mediana ${s.medianS?.toFixed(0)} s; p95 ${s.p95S?.toFixed(0)} s; maks. ${s.maxS?.toFixed(0)} s`,
    );
  }
  const actions = actionLog();
  lines.push('', `Akcje: ${actions.length} (błędy: ${actions.filter((a) => !a.ok).length})`);
  for (const a of actions.slice(-20)) lines.push(`  ${new Date(a.at).toISOString()} ${a.action} ${a.appState} ${a.ok ? 'OK' : `BŁĄD ${a.error}`}`);
  return lines.join('\n');
}
