/**
 * Przypomnienia lokalne M8: chwile z `core/reminders.ts` (`reminderFireTimes` — okno 7 dni, najwyżej
 * 50 naraz, strefa z ustawień albo przypięta do zadania) → powiadomienia `expo-notifications`
 * z akcjami „Ukończ” / „Odłóż 10 min” / „Jutro”. Przeplanowanie porównuje z tym, co już zaplanowane
 * (stały identyfikator = przypomnienie + wystąpienie): nic się nie dubluje, zmienione — od nowa.
 *
 * Uruchamiane po zmianie danych (aplikacja na wierzchu), po akcji z powiadomienia i z zadania
 * w tle — także bez ekranu. Powiadomienia odłożone (`s_…`) i serie testowe PoC-4 (`poc4_…`) zostają.
 *
 * W trybie alarmu (`lib/alarm.ts`) te same chwile idą do modułu `task-alarm` zamiast do powiadomień.
 */
import { addDays, alarmEntry, assigneeReminderRules, localDateAt, MAX_SCHEDULED_REMINDERS, reminderBody, reminderFireTimes, reviewFireTimes, toReminderRule, type LocalDate, type ReminderFire, type ReminderTask, type ReviewKind } from '@taskplanner/core';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { alarmSnooze, reminderMode, syncAlarms } from './alarm';
import { readJson, sessionUser, writeJson } from './config';
import { loadTask, type AppData } from './app-data';
import { phoneRemindersOn } from './device';
import { headlessData } from './headless';
import { dismissedReviews } from './review-nudge';
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
/** Pora przeglądu (M16): `v_daily_2026-11-24`. */
const REVIEW_PREFIX = 'v_';

/** Dane powiadomienia o przeglądzie — dotknięcie otwiera przegląd. */
export interface ReviewNotificationData extends Record<string, unknown> {
  review: ReviewKind;
  at: number;
}

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
    const userId = sessionUser().id;
    // Udostępnione przestrzenie: odpowiedzialny dostaje też automatyczne przypomnienie w chwili terminu.
    const shared = new Set(data.workspaces.filter((w) => w.members > 1).map((w) => w.id));
    const [on, rules, zones, creators, mine] = await Promise.all([
      phoneRemindersOn(engine),
      engine.db.all<{ id: string; task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
        // Przypomnienie dostaje jego autor (jak `reminders-push`) — we wspólnej przestrzeni nie dzwonią cudze.
        'select id, task_id, kind, offset_min, at_date, at_time from reminders where deleted_at is null and (created_by is null or created_by = ?)',
        [userId],
      ),
      engine.db.all<{ id: string; time_zone: string }>('select id, time_zone from tasks where time_zone is not null and deleted_at is null'),
      shared.size
        ? engine.db.all<{ id: string; created_by: string | null }>('select id, created_by from tasks where due_date is not null and due_time is not null and deleted_at is null')
        : [],
      shared.size ? engine.db.all<{ scope_id: string; collaborator_id: string }>('select scope_id, collaborator_id from scope_collaborators where user_id = ?', [userId]) : [],
    ]);
    const createdBy = new Map(creators.map((t) => [t.id, t.created_by]));
    const myEntries = new Set(mine.map((c) => `${c.scope_id}|${c.collaborator_id}`));
    const assigned = assigneeReminderRules(data.tasks, {
      userId,
      shared,
      createdBy: (id) => createdBy.get(id),
      accountOf: (workspaceId, id) => (myEntries.has(`${workspaceId}|${id}`) ? userId : null),
    });
    const zoneOf = new Map(zones.map((z) => [z.id, z.time_zone]));
    const tasks: ReminderTask[] = data.tasks.map((t) => ({ ...t, timeZone: zoneOf.get(t.id) ?? null }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const { timeZone, defaultReminderTime } = data.settings;
    // Wpisy nawyków: dzień już zaliczony, wolny albo okres z osiągniętym celem nie przypomina.
    // Kanał wyłączony dla tego telefonu (tu albo na webie) — pusta lista, więc zaplanowane znikają.
    const fires = reminderFireTimes(tasks, on ? [...rules.map(toReminderRule), ...assigned] : [], {
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
    const alarmMode = reminderMode() === 'alarm';
    const alarms = syncAlarms(alarmMode ? await alarmEntries(fires, byId, timeZone) : [], byId, data.habitCompletions, on);
    added += alarms.added;
    removed += alarms.removed;
    for (const fire of alarmMode ? [] : fires) {
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
    await scheduleReviews(scheduled, on ? data : null, new Date(now));
    const result: ScheduleResult = { at: now, scheduled: fires.length, added, removed, next: fires[0] ? new Date(fires[0].fireAt).getTime() : null, exact: exact.granted };
    writeJson(LAST_KEY, result);
    if (__DEV__) console.info('przypomnienia', given ? 'z danych ekranu' : 'z bazy', JSON.stringify(result));
    return result;
  } catch (error) {
    const result: ScheduleResult = { at: now, scheduled: 0, added: 0, removed: 0, next: null, exact: false, error: error instanceof Error ? error.message : String(error) };
    writeJson(LAST_KEY, result);
    return result;
  }
}

/** Wpisy alarmów z opisami zadań (opisów nie ma w danych widoków). */
async function alarmEntries(fires: readonly ReminderFire[], byId: ReadonlyMap<string, ReminderTask>, timeZone: string | undefined) {
  const ids = [...new Set(fires.map((f) => f.taskId))];
  const engine = await localEngine();
  const rows = ids.length
    ? await engine.db.all<{ id: string; description_md: string | null }>(`select id, description_md from tasks where id in (${ids.map(() => '?').join(',')})`, ids)
    : [];
  const descriptions = new Map(rows.map((r) => [r.id, r.description_md]));
  const snoozeMin = alarmSnooze();
  return fires.map((fire) => alarmEntry(identifier(fire.key), byId.get(fire.taskId)!, fire, { description: descriptions.get(fire.taskId), snoozeMin, timeZone }));
}

/**
 * Powiadomienia o porze przeglądu na 7 dni (dzień z ukończonym albo odłożonym „Nie dziś” przeglądem bez
 * powiadomienia); `data = null` — wyłączone na tym telefonie.
 */
async function scheduleReviews(scheduled: Notifications.NotificationRequest[], data: AppData | null, now: Date) {
  const existing = new Map(scheduled.filter((n) => n.identifier.startsWith(REVIEW_PREFIX)).map((n) => [n.identifier, n]));
  const wanted = new Set<string>();
  if (data && (data.settings.dailyReview.enabled || data.settings.weeklyReview.enabled)) {
    const { timeZone } = data.settings;
    const today = localDateAt(now, timeZone);
    const engine = await localEngine();
    const rows = await engine.db.all<{ kind: ReviewKind; finished_at: string }>(
      'select kind, finished_at from review_sessions where deleted_at is null and finished_at is not null and finished_at >= ?',
      [addDays(today, -2)],
    );
    const last: Partial<Record<ReviewKind, LocalDate>> = { ...dismissedReviews() };
    for (const r of rows) if (localDateAt(r.finished_at, timeZone) === today) last[r.kind] = today;
    for (const fire of reviewFireTimes(data.settings, now, { timeZone, last })) {
      const id = `${REVIEW_PREFIX}${fire.kind}_${fire.date}`;
      const at = fire.at.getTime();
      wanted.add(id);
      const old = existing.get(id);
      if ((old?.content.data as Partial<ReviewNotificationData> | null | undefined)?.at === at) continue;
      if (old) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: {
          title: fire.kind === 'weekly' ? 'Pora na przegląd tygodnia' : 'Pora na przegląd dnia',
          body: 'Kilka minut na uporządkowanie zadań.',
          data: { review: fire.kind, at } satisfies ReviewNotificationData,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL_ID },
      });
    }
  }
  for (const id of existing.keys()) if (!wanted.has(id)) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
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
