/**
 * Centrum powiadomień na telefonie (v1.x; web N1–N3). Wiersze `notifications` tworzy serwer i przychodzą zwykłą
 * synchronizacją; tu (bez expo-router — moduł działa też w zadaniach w tle): wspólny stan dla dzwonka / ekranu / dymka (poza Reactem, jak `focus.ts`), zaznaczanie
 * „przeczytane” (outbox — działa offline) i powiadomienie systemowe.
 *
 * Telefon nie ma Web Push: powiadomienie systemowe pokazuje sam po synchronizacji, gdy aplikacja nie jest na
 * wierzchu (`showNotificationPushes` — synchronizacja w tle co kilkanaście minut albo sygnał Realtime, póki proces
 * żyje); na wierzchu wystarcza dymek (`markNotificationsShown`). Klucze pokazanych w kv-store, pierwsze uruchomienie
 * zapamiętuje istniejące bez pokazywania. Przeczytane (też na innym urządzeniu) znikają z zasobnika.
 */
import {
  markReadOps,
  notificationFireKey,
  notificationPush,
  notificationTarget,
  phoneNotificationPushes,
  toNotification,
  type AppNotification,
  type NotificationPrefs,
} from '@taskplanner/core';
import type { SqlRow, SyncEngine } from '@taskplanner/sync';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { parseSettings } from './app-data';
import { readJson, writeJson } from './config';
import { localEngine, mutateMany, onSessionChange } from './sync';

export const NOTIFICATION_CENTER_CHANNEL = 'notification-center';
export const NOTIFICATION_CENTER_CATEGORY = 'notification_center';
export const NOTIFICATION_READ_ACTION = 'notification_read';
const IDENTIFIER_PREFIX = 'n_';
const SHOWN_KEY = 'notifications.shown';
const SHOWN_LIMIT = 500;

/** Dane powiadomienia systemowego: id wiersza i trasa do otwarcia po dotknięciu. */
export interface CenterNotificationData extends Record<string, unknown> {
  notification: string;
  route: string;
}

// ── Dane ─────────────────────────────────────────────────────────────────────────────────────

export interface NotificationsData {
  list: AppNotification[];
  prefs: NotificationPrefs;
  timeZone: string | undefined;
  loaded: boolean;
}

/** Tyle najnowszych wierszy czyta telefon (jak dzwonek na webie). */
const LIMIT = 300;
const EMPTY: NotificationsData = { list: [], prefs: parseSettings({}).notifications, timeZone: undefined, loaded: false };

export async function loadNotifications(engine: SyncEngine): Promise<NotificationsData> {
  const [rows, profile] = await Promise.all([
    engine.db.all<SqlRow>(
      `select id, kind, task_id, workspace_id, actor_id, data, group_key, at, read_at from notifications where deleted_at is null order by at desc limit ${LIMIT}`,
    ),
    engine.db.all<SqlRow>('select settings from profiles where id = ?', [engine.userId]),
  ]);
  const settings = parseSettings(profile[0]?.settings);
  return {
    list: rows.map((r) => toNotification(r as Record<string, unknown>)).filter((n): n is AppNotification => n !== null),
    prefs: settings.notifications,
    timeZone: settings.timeZone,
    loaded: true,
  };
}

let data: NotificationsData = EMPTY;
const listeners = new Set<() => void>();
let started = false;
let unwatch: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;

function reload() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    localEngine()
      .then(loadNotifications)
      .then((next) => {
        data = next;
        listeners.forEach((l) => l());
      })
      .catch((error) => console.warn('powiadomienia', error));
  }, 50);
}

function attach() {
  unwatch?.();
  data = EMPTY;
  listeners.forEach((l) => l());
  localEngine()
    .then((engine) => {
      unwatch = engine.watch(['notifications', 'profiles'], reload);
      reload();
    })
    .catch((error) => console.warn('lokalna baza', error));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    attach();
    onSessionChange(attach);
  }
  return () => listeners.delete(listener);
}

export const useNotificationsData = (): NotificationsData => useSyncExternalStore(subscribe, () => data);

/** Zmiany poza Reactem (sprzątanie zasobnika po przeczytaniu). */
export const onNotificationsData = (listener: (data: NotificationsData) => void): (() => void) => subscribe(() => listener(data));

// ── Zapis ────────────────────────────────────────────────────────────────────────────────────

export const markNotificationsRead = (list: readonly Pick<AppNotification, 'id' | 'readAt'>[]) => {
  const ops = markReadOps(list, new Date());
  return ops.length ? mutateMany(ops) : Promise.resolve();
};

/** „Oznacz jako przeczytane” z zasobnika (zadanie w tle albo słuchacz) — po id, bez czytania wiersza. */
export const markNotificationReadById = (id: string) => markNotificationsRead([{ id, readAt: null }]);

// ── Otwarcie ─────────────────────────────────────────────────────────────────────────────────

/** Trasa celu na telefonie: zadanie, przestrzenie, ustawienia (integracje, kalendarze, AI, wysyłki), pasek zaproszeń. */
export function notificationRoute(n: Pick<AppNotification, 'kind' | 'taskId' | 'workspaceId'>): string {
  const target = notificationTarget(n);
  switch (target.kind) {
    case 'task':
      return `/task/${target.taskId}`;
    case 'workspace':
      return '/workspaces';
    case 'invites':
      return '/';
    case 'deliveries':
    case 'settings':
      return '/settings';
    case 'none':
      return '/notifications';
  }
}

// ── Powiadomienie systemowe ──────────────────────────────────────────────────────────────────

/** Kanał i akcja (start aplikacji z ekranem, razem z kanałem przypomnień). */
export async function setupNotificationCenter() {
  await Notifications.setNotificationChannelAsync(NOTIFICATION_CENTER_CHANNEL, {
    name: 'Powiadomienia z przestrzeni i integracji',
    description: 'Przypisania, komentarze, zmiany terminów, udostępnianie i problemy z integracjami (ustawienia: Konto → Powiadomienia).',
    importance: AndroidImportance.DEFAULT,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
  });
  await Notifications.setNotificationCategoryAsync(NOTIFICATION_CENTER_CATEGORY, [
    { identifier: NOTIFICATION_READ_ACTION, buttonTitle: 'Oznacz jako przeczytane', options: { opensAppToForeground: false } },
  ]);
}

const shownKeys = () => readJson<string[] | null>(SHOWN_KEY, null);
const saveShown = (keys: readonly string[]) => writeJson(SHOWN_KEY, keys.slice(-SHOWN_LIMIT));

/** Wyświetlone w aplikacji (dymek, ekran) — nie wracają potem jako powiadomienie systemowe. */
export function markNotificationsShown(list: readonly AppNotification[]) {
  const stored = shownKeys();
  const keys = stored ?? [];
  const known = new Set(keys);
  const added = list.map(notificationFireKey).filter((k) => !known.has(k));
  if (added.length || stored === null) saveShown([...keys, ...added]);
}

/** Powiadomienia systemowe przeczytanych / usuniętych wierszy znikają z zasobnika (bez expo-router — działa w tle). */
export async function dismissSettledPushes(list: readonly AppNotification[]) {
  const unread = new Set(list.filter((n) => !n.readAt).map((n) => n.id));
  const presented = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  for (const p of presented) {
    const id = (p.request.content.data as Partial<CenterNotificationData> | undefined)?.notification;
    if (typeof id === 'string' && !unread.has(id)) await Notifications.dismissNotificationAsync(p.request.identifier).catch(() => undefined);
  }
}

/** Po synchronizacji, gdy aplikacja nie jest na wierzchu: nowe nieprzeczytane z kanałem „push” → zasobnik. */
export async function showNotificationPushes(): Promise<number> {
  if (Platform.OS !== 'android') return 0;
  const engine = await localEngine();
  if (!engine.userId) return 0;
  const { list, prefs, timeZone } = await loadNotifications(engine);
  await dismissSettledPushes(list);
  const keys = shownKeys();
  // Pierwsze uruchomienie (nowa wersja, nowe konto) — bez zalewu starszymi wpisami.
  if (keys === null) {
    saveShown(list.map(notificationFireKey));
    return 0;
  }
  const fresh = phoneNotificationPushes(list, prefs, new Set(keys), new Date(), timeZone);
  if (!fresh.length) return 0;
  if (!(await Notifications.getPermissionsAsync()).granted) return 0;
  for (const n of fresh) {
    const push = notificationPush(n);
    await Notifications.scheduleNotificationAsync({
      // Ta sama grupa (np. seria komentarzy) zastępuje poprzednie powiadomienie w zasobniku.
      identifier: IDENTIFIER_PREFIX + push.tag.replace(/^tp-n:/, ''),
      content: {
        title: push.title,
        body: push.body || undefined,
        data: { notification: n.id, route: notificationRoute(n) } satisfies CenterNotificationData,
        categoryIdentifier: NOTIFICATION_CENTER_CATEGORY,
      },
      trigger: { channelId: NOTIFICATION_CENTER_CHANNEL },
    });
  }
  saveShown([...keys, ...fresh.map(notificationFireKey)]);
  return fresh.length;
}
