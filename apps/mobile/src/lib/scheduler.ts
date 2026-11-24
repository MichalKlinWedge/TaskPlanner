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

import { readJson, sessionUser, writeJson } from './config';
import { loadTask, type AppData } from './app-data';
import { phoneRemindersOn } from './device';
import { headlessData } from './headless';
import { localEngine } from './sync';

/**
 * Kanał z jawnym dźwiękiem. Dźwięku i ważności kanału Androida nie da się zmienić po jego
 * utworzeniu (a użytkownik mógł go wyciszyć), więc zmiana = nowy identyfikator; stare kanały
 * usuwa `setupNotifications`, a przeplanowanie przenosi zaplanowane na nowy.
 */
export const CHANNEL_ID = 'reminders-sound';
export const LEGACY_CHANNEL_IDS = ['reminders'];
/** Bez „:” i „-” (wymóg `setNotificationCategoryAsync`). */
export const CATEGORY_ID = 'task_reminder';
/** Przypomnienie nawyku (Etap 8): „Zrobione” zapisuje wpis dnia bez otwierania aplikacji. */
export const HABIT_CATEGORY_ID = 'habit_reminder';
export const ACTION = { complete: 'complete', snooze: 'snooze10', tomorrow: 'tomorrow', habitDone: 'habit_done' } as const;
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
  /** Przypomnienie nawyku (akcja „Zrobione” na dzień `occurrenceDate`). */
  habit?: boolean;
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
    const [on, rules, zones] = await Promise.all([
      phoneRemindersOn(engine),
      engine.db.all<{ id: string; task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
        // Przypomnienie dostaje jego autor (jak `reminders-push`) — we wspólnej przestrzeni nie dzwonią cudze.
        'select id, task_id, kind, offset_min, at_date, at_time from reminders where deleted_at is null and (created_by is null or created_by = ?)',
        [sessionUser().id],
      ),
      engine.db.all<{ id: string; time_zone: string }>('select id, time_zone from tasks where time_zone is not null and deleted_at is null'),
    ]);
    const zoneOf = new Map(zones.map((z) => [z.id, z.time_zone]));
    const tasks: ReminderTask[] = data.tasks.map((t) => ({ ...t, timeZone: zoneOf.get(t.id) ?? null }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const { timeZone, defaultReminderTime } = data.settings;
    // Wpisy nawyków: dzień już zaliczony, wolny albo okres z osiągniętym celem nie przypomina.
    // Kanał wyłączony dla tego telefonu (tu albo na webie) — pusta lista, więc zaplanowane znikają.
    const fires = reminderFireTimes(tasks, on ? rules.map(toReminderRule) : [], {
      from: new Date(now),
      timeZone,
      defaultTime: defaultReminderTime,
      limit: MAX_SCHEDULED_REMINDERS,
      habitCompletions: data.habitCompletions,
    });

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
      const sameChannel = (existing?.trigger as { channelId?: string | null } | undefined)?.channelId === CHANNEL_ID;
      if (existing && sameChannel && old?.data?.at === at && old.title === content.title && old.body === content.body && !!old.data?.habit === (task.kind === 'habit')) continue;
      if (existing) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: {
          ...content,
          data: { taskId: task.id, at, occurrenceDate: fire.occurrenceDate, dueAt: fire.dueAt, ...(task.kind === 'habit' && { habit: true }) } satisfies ReminderData,
          categoryIdentifier: task.kind === 'habit' ? HABIT_CATEGORY_ID : CATEGORY_ID,
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
    if (__DEV__) console.info('przypomnienia', given ? 'z danych ekranu' : 'z bazy', JSON.stringify(result));
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
  const { task } = await loadTask(await localEngine(), data.taskId);
  const content = task ? reminderBody(task, { occurrenceDate: data.occurrenceDate ?? null, dueAt: data.dueAt ?? null }, new Date(at)) : { title: 'Przypomnienie', body: 'Odłożone' };
  await Notifications.scheduleNotificationAsync({
    identifier: notificationId.startsWith(SNOOZE_PREFIX) ? notificationId : SNOOZE_PREFIX + notificationId,
    content: { ...content, data: { ...data, at }, categoryIdentifier: CATEGORY_ID },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL_ID },
  });
}
