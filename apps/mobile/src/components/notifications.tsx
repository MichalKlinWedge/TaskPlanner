/**
 * Centrum powiadomień na telefonie: dzwonek z licznikiem w nagłówku, dymek przy nowym powiadomieniu (aplikacja na
 * wierzchu), otwieranie celu i sekcja ustawień. Logika (teksty, cele, filtry) w core `notifications.ts`, dane
 * i powiadomienie systemowe w `lib/notifications.ts`; ekran — `app/notifications.tsx`.
 */
import {
  freshNotifications,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_GROUP_LABEL,
  NOTIFICATION_GROUPS,
  notificationSeenKey,
  notificationText,
  unreadCount,
  visibleNotifications,
  type AppNotification,
  type NotificationChannel,
  type NotificationPrefs,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { useView } from '@/lib/app-data';
import { dismissSettledPushes, markNotificationsShown, useNotificationsData } from '@/lib/notifications';
import { mutate } from '@/lib/sync';

import { useTaskActions } from './actions';
import { pickOption, pickTime } from './pickers';
import { P, Section, usePalette } from './ui';

export const NOTIFICATION_ICON: Record<AppNotification['kind'], string> = {
  assigned: '👤',
  comment: '💬',
  participant: '👥',
  completed: '✅',
  due_changed: '📅',
  invite: '✉️',
  owner_offer: '🔑',
  member_joined: '➕',
  member_left: '➖',
  member_removed: '🚪',
  role_changed: '🎚️',
  delivery_failed: '📤',
  connection_error: '🔌',
  calendar_error: '📆',
  ai_error: '✨',
  storage_quota: '📦',
};

/** Trasa z `notificationRoute` (lib) → nawigacja. */
export function openNotificationRoute(route: string) {
  const task = /^\/task\/([0-9a-f-]{36})$/i.exec(route);
  if (task) router.push({ pathname: '/task/[id]', params: { id: task[1]! } });
  else if (route === '/workspaces') router.push('/workspaces');
  else if (route === '/settings') router.push('/settings');
  else if (route === '/') router.navigate('/');
  else router.push('/notifications');
}

/** Dzwonek w nagłówku zakładek: licznik nieprzeczytanych, dotknięcie — ekran „Powiadomienia”. */
export function NotificationBell() {
  const p = usePalette();
  const { list, prefs } = useNotificationsData();
  const count = unreadCount(list, prefs, new Date());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count ? `Powiadomienia: ${count} nieprzeczytanych` : 'Powiadomienia'}
      hitSlop={8}
      onPress={() => router.push('/notifications')}
      style={styles.bell}
    >
      <Text style={{ color: p.fg, fontSize: 17 }}>🔔</Text>
      {count ? (
        <View style={[styles.count, { backgroundColor: p.bad }]}>
          <Text style={styles.countText}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Aplikacja na wierzchu: dymek przy nowym powiadomieniu (to, co pokazał dymek, nie wróci jako powiadomienie
 * systemowe) i sprzątanie zasobnika po przeczytaniu — także na innym urządzeniu. Istniejące przy starcie — bez dymka.
 */
export function NotificationToasts() {
  const { list, prefs, loaded } = useNotificationsData();
  const { notify } = useTaskActions();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    void dismissSettledPushes(list);
    const now = new Date();
    if (seen.current === null) {
      seen.current = new Set(list.map(notificationSeenKey));
      return;
    }
    const fresh = visibleNotifications(freshNotifications(list, seen.current, now), prefs, now, 'unread');
    for (const n of list) seen.current.add(notificationSeenKey(n));
    if (!fresh.length || AppState.currentState !== 'active') return;
    markNotificationsShown(fresh);
    if (!prefs.toast) return;
    const first = notificationText(fresh[0]!).text;
    notify(fresh.length > 1 ? `🔔 ${first} (i ${fresh.length - 1} więcej)` : `🔔 ${first}`);
  }, [list, prefs, loaded, notify]);
  return null;
}

/** Ustawienia → „Powiadomienia”: kanał każdej grupy, dymek, cisza nocna. */
export function NotificationsSection() {
  const p = usePalette();
  const { data } = useView();
  const [error, setError] = useState<string | null>(null);
  if (!data.userId) return null;
  const prefs = data.settings.notifications;
  // Pełne ustawienia z tej samej migawki — `settings` to jedno pole LWW.
  const save = (patch: Partial<NotificationPrefs>) => {
    setError(null);
    void mutate('profiles', data.userId, { settings: { ...data.settings, notifications: { ...prefs, ...patch } } }).catch((e: unknown) => setError(String(e)));
  };
  const channels: NotificationChannel[] = ['push', 'app', 'off'];
  const label = (c: NotificationChannel) => (c === 'push' ? 'W aplikacji i w zasobniku' : NOTIFICATION_CHANNEL[c]);
  return (
    <Section title="Powiadomienia">
      <P muted>
        Dzwonek 🔔 w nagłówku: zdarzenia z udostępnionych przestrzeni (to, co zrobili inni) i problemy z integracjami, kalendarzem, kluczem AI czy miejscem na załączniki. Ustawienia
        wspólne z komputerem.
      </P>
      {NOTIFICATION_GROUPS.map((group) => (
        <Pressable
          key={group}
          accessibilityRole="button"
          accessibilityLabel={`${NOTIFICATION_GROUP_LABEL[group].title}: ${label(prefs[group])}. Zmień`}
          onPress={() =>
            void pickOption<NotificationChannel>(
              NOTIFICATION_GROUP_LABEL[group].title,
              channels.map((c) => ({ label: label(c), value: c, selected: prefs[group] === c })),
            ).then((c) => c && c !== prefs[group] && save({ [group]: c }))
          }
          style={[styles.row, { borderColor: p.border }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: p.fg, fontWeight: '600' }}>{NOTIFICATION_GROUP_LABEL[group].title}</Text>
            <Text style={{ color: p.muted, fontSize: 12 }}>{NOTIFICATION_GROUP_LABEL[group].hint}</Text>
          </View>
          <Text style={{ color: p.accent }}>{label(prefs[group])}</Text>
        </Pressable>
      ))}
      <View style={styles.switchRow}>
        <Text style={{ color: p.fg, flex: 1 }}>Dymek przy nowym powiadomieniu, gdy aplikacja jest otwarta</Text>
        <Switch accessibilityLabel="Dymek przy nowym powiadomieniu" value={prefs.toast} onValueChange={(toast) => save({ toast })} />
      </View>
      <View style={styles.switchRow}>
        <Text style={{ color: p.fg, flex: 1 }}>Cisza nocna (bez powiadomień w zasobniku)</Text>
        <Switch accessibilityLabel="Cisza nocna" value={prefs.quiet.enabled} onValueChange={(enabled) => save({ quiet: { ...prefs.quiet, enabled } })} />
      </View>
      {prefs.quiet.enabled ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {(['from', 'to'] as const).map((edge) => (
            <Pressable
              key={edge}
              accessibilityRole="button"
              accessibilityLabel={`${edge === 'from' ? 'Początek' : 'Koniec'} ciszy nocnej: ${prefs.quiet[edge]}. Zmień`}
              onPress={() =>
                void pickTime({ title: edge === 'from' ? 'Początek ciszy nocnej' : 'Koniec ciszy nocnej', value: prefs.quiet[edge] }).then(
                  (time) => time && save({ quiet: { ...prefs.quiet, [edge]: time } }),
                )
              }
              style={[styles.time, { borderColor: p.border }]}
            >
              <Text style={{ color: p.fg }}>
                {edge === 'from' ? 'od' : 'do'} {prefs.quiet[edge]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <P muted>
        „W aplikacji i w zasobniku” — na telefonie powiadomienie systemowe pojawia się po synchronizacji w tle (zwykle co kilkanaście minut) albo od razu, gdy aplikacja działa
        w tle; na komputerze to push minutę po zdarzeniu. Wymaga zgody na powiadomienia (Przypomnienia).
      </P>
      {error ? <P tone="bad">{error}</P> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  bell: { width: 24, height: 26, alignItems: 'center', justifyContent: 'center' },
  count: { position: 'absolute', top: -4, right: -8, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
  countText: { color: '#ffffff', fontSize: 10, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  time: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
});
