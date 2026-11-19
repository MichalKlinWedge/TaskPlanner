/**
 * Przypomnienia lokalne M8: chwile z `core/reminders.ts` (`reminderFireTimes` — okno 7 dni, najwyżej
 * 50 naraz, strefa z ustawień albo przypięta do zadania) → powiadomienia `expo-notifications`
 * z akcjami „Ukończ” / „Odłóż 10 min” / „Jutro”. Przeplanowanie porównuje z tym, co już zaplanowane
 * (stały identyfikator = przypomnienie + wystąpienie): nic się nie dubluje, zmienione — od nowa.
 *
 * Uruchamiane po zmianie danych (aplikacja na wierzchu), po akcji z powiadomienia i z zadania
 * w tle — także bez ekranu. Powiadomienia odłożone (`s_…`) i serie testowe PoC-4 (`poc4_…`) zostają.
 */
import { MAX_SCHEDULED_REMINDERS, reminderBody, reminderFireTimes, toReminderRule, type LocalDate, type ReminderTask } from '@taskplanner/core';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { readJson, writeJson } from './config';
import type { AppData } from './app-data';
import { headlessData } from './headless';
import { localEngine } from './sync';

export const CHANNEL_ID = 'reminders';
/** Bez „:” i „-” (wymóg `setNotificationCategoryAsync`). */
export const CATEGORY_ID = 'task_reminder';
export const ACTION = { complete: 'complete', snooze: 'snooze10', tomorrow: 'tomorrow' } as const;
/** Zaplanowane przez ten moduł; inne prefiksy (odłożone, PoC-4) nie są ruszane. */
const PREFIX = 'r_';
export const SNOOZE_PREFIX = 's_';

/** Dane powiadomienia (także odłożonego). */
export interface ReminderData extends Record<string, unknown> {
  taskId: string;
  /** Planowana chwila (ms). */
  at: number;
  occurrenceDate?: LocalDate | null;
  dueAt?: string | null;
  /** Seria testowa PoC-4. */
  batch?: string;
}

export interface ScheduleResult {
  at: number;
  scheduled: number;
  added: number;
  removed: number;
  /** Najbliższe przypomnienie (ms). */
  next: number | null;
  exact: boolean;
  error?: string;
}

const LAST_KEY = 'reminders.lastSchedule';
export const lastSchedule = () => readJson<ScheduleResult | null>(LAST_KEY, null);

const identifier = (key: string) => PREFIX + key.replace(/[^A-Za-z0-9_-]/g, '_');

let running: Promise<ScheduleResult | null> | null = null;
let again = false;

let latest: AppData | undefined;

/**
 * Przeplanowanie; równoległe wywołania łączą się (jedno w toku + jedno po nim). `data` — już
 * wczytane dane widoków (ekran), bez nich odczyt z bazy (zadanie w tle, akcja z powiadomienia).
 */
export function scheduleReminders(data?: AppData): Promise<ScheduleResult | null> {
  latest = data;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: ScheduleResult | null = null;
    do {
      again = false;
      const given = latest;
      latest = undefined;
      result = await scheduleOnce(given);
    } while (again);
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

async function scheduleOnce(given?: AppData): Promise<ScheduleResult | null> {
  if (Platform.OS !== 'android') return null;
  const now = Date.now();
  try {
    const [perm, exact] = await Promise.all([Notifications.getPermissionsAsync(), Notifications.getExactAlarmPermissionsAsync()]);
    if (!perm.granted) return null;
    const data = given ?? (await headlessData());
    const engine = await localEngine();
    const [rules, zones] = await Promise.all([
      engine.db.all<{ id: string; task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
        'select id, task_id, kind, offset_min, at_date, at_time from reminders where deleted_at is null',
      ),
      engine.db.all<{ id: string; time_zone: string }>('select id, time_zone from tasks where time_zone is not null and deleted_at is null'),
    ]);
    const zoneOf = new Map(zones.map((z) => [z.id, z.time_zone]));
    const tasks: ReminderTask[] = data.tasks.map((t) => ({ ...t, timeZone: zoneOf.get(t.id) ?? null }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const { timeZone, defaultReminderTime } = data.settings;
    const fires = reminderFireTimes(tasks, rules.map(toReminderRule), { from: new Date(now), timeZone, defaultTime: defaultReminderTime, limit: MAX_SCHEDULED_REMINDERS });

    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const ours = new Map(scheduled.filter((n) => n.identifier.startsWith(PREFIX)).map((n) => [n.identifier, n]));
    const wanted = new Set<string>();
    let added = 0;
    let removed = 0;
    for (const fire of fires) {
      const task = byId.get(fire.taskId)!;
      const id = identifier(fire.key);
      wanted.add(id);
      const at = new Date(fire.fireAt).getTime();
      const content = reminderBody(task, fire, fire.fireAt, task.timeZone ?? timeZone);
      const existing = ours.get(id);
      const old = existing?.content as { title?: string | null; body?: string | null; data?: Partial<ReminderData> } | undefined;
      if (existing && old?.data?.at === at && old.title === content.title && old.body === content.body) continue;
      if (existing) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: {
          ...content,
          data: { taskId: task.id, at, occurrenceDate: fire.occurrenceDate, dueAt: fire.dueAt } satisfies ReminderData,
          categoryIdentifier: CATEGORY_ID,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL_ID },
      });
      added++;
    }
    // Odłożone powiadomienie zamkniętego (albo usuniętego) zadania nie ma już po co przyjść.
    for (const n of scheduled) {
      if (!n.identifier.startsWith(SNOOZE_PREFIX)) continue;
      const taskId = (n.content.data as Partial<ReminderData> | null)?.taskId;
      const task = taskId ? byId.get(taskId) : undefined;
      if (task && task.status !== 'done' && task.status !== 'cancelled') continue;
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => undefined);
      removed++;
    }
    for (const id of ours.keys()) {
      if (wanted.has(id)) continue;
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
      removed++;
    }
    const result: ScheduleResult = { at: now, scheduled: wanted.size, added, removed, next: fires[0] ? new Date(fires[0].fireAt).getTime() : null, exact: exact.granted };
    writeJson(LAST_KEY, result);
    return result;
  } catch (error) {
    const result: ScheduleResult = { at: now, scheduled: 0, added: 0, removed: 0, next: null, exact: false, error: error instanceof Error ? error.message : String(error) };
    writeJson(LAST_KEY, result);
    return result;
  }
}

/** Odłożenie powiadomienia o 10 min (stały identyfikator — powtórzona akcja go nie dubluje). */
export async function snoozeNotification(notificationId: string, data: ReminderData, minutes = 10) {
  const at = Date.now() + minutes * 60_000;
  const task = (await headlessData()).tasks.find((t) => t.id === data.taskId);
  const content = task ? reminderBody(task, { occurrenceDate: data.occurrenceDate ?? null, dueAt: data.dueAt ?? null }, new Date(at)) : { title: 'Przypomnienie', body: 'Odłożone' };
  await Notifications.scheduleNotificationAsync({
    identifier: notificationId.startsWith(SNOOZE_PREFIX) ? notificationId : SNOOZE_PREFIX + notificationId,
    content: { ...content, data: { ...data, at }, categoryIdentifier: CATEGORY_ID },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL_ID },
  });
}
