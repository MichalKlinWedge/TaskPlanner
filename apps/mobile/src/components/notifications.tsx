/**
 * Centrum powiadomień na telefonie: dzwonek z licznikiem w nagłówku, dymek przy nowym powiadomieniu (aplikacja na
 * wierzchu), otwieranie celu i sekcja ustawień. Logika (teksty, cele, filtry) w core `notifications.ts`, dane
 * i powiadomienie systemowe w `lib/notifications.ts`; ekran — `app/notifications.tsx`.
 */
import {
  AUTO_REMINDER,
  AUTO_REMINDER_OFFSETS,
  autoReminderOffsetLabel,
  freshNotifications,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_GROUP_LABEL,
  NOTIFICATION_GROUPS,
  NOTIFICATION_KIND_LABEL,
  notificationKindsOf,
  notificationSeenKey,
  notificationText,
  REMINDER_DISPLAY,
  unreadCount,
  toggleMuted,
  visibleNotifications,
  type AppNotification,
  type AutoReminderMode,
  type NotificationChannel,
  type NotificationPrefs,
  type ReminderDisplay,
  type ServerNotificationKind,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { useView } from '@/lib/app-data';
import { dismissSettledPushes, markNotificationsShown, useNotificationsData } from '@/lib/notifications';
import { useBellNotifications } from '@/lib/reminder-bell';
import { mutate } from '@/lib/sync';

import { useTaskActions } from './actions';
import { pickMany, pickOption, pickTime } from './pickers';
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
  reminder: '⏰',
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
  const { list, prefs } = useBellNotifications();
  const count = unreadCount(list, prefs, new Date());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count ? `Powiadomienia: ${count} nieprzeczytanych` : 'Powiadomienia'}
      hitSlop={4}
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
      {NOTIFICATION_GROUPS.map((group) => {
        const kinds = notificationKindsOf(group);
        const on = kinds.filter((k) => !prefs.muted.includes(k));
        return (
          <View key={group}>
            <Pressable
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
            {prefs[group] === 'off' ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${NOTIFICATION_GROUP_LABEL[group].title} — rodzaje: ${on.length} z ${kinds.length}. Zmień`}
                onPress={() =>
                  void pickMany<ServerNotificationKind>(
                    'Rodzaje powiadomień',
                    kinds.map((k) => ({ label: `${NOTIFICATION_ICON[k]} ${NOTIFICATION_KIND_LABEL[k]}`, value: k, selected: !prefs.muted.includes(k) })),
                  ).then((picked) => picked && save({ muted: kinds.reduce<string[]>((m, k) => toggleMuted(m, k, picked.includes(k)), prefs.muted) }))
                }
                style={styles.kinds}
              >
                <Text style={{ color: p.muted, fontSize: 12 }}>Rodzaje: {on.length === kinds.length ? 'wszystkie' : `${on.length} z ${kinds.length}`} ›</Text>
              </Pressable>
            )}
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${NOTIFICATION_GROUP_LABEL.reminders.title}: ${REMINDER_DISPLAY[prefs.reminders]}. Zmień`}
        onPress={() =>
          void pickOption<ReminderDisplay>(
            NOTIFICATION_GROUP_LABEL.reminders.title,
            (['app', 'popup', 'off'] as const).map((v) => ({ label: REMINDER_DISPLAY[v], value: v, selected: prefs.reminders === v })),
          ).then((v) => v && v !== prefs.reminders && save({ reminders: v }))
        }
        style={[styles.row, { borderColor: p.border }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: p.fg, fontWeight: '600' }}>{NOTIFICATION_GROUP_LABEL.reminders.title}</Text>
          <Text style={{ color: p.muted, fontSize: 12 }}>{NOTIFICATION_GROUP_LABEL.reminders.hint}</Text>
        </View>
        <Text style={{ color: p.accent, flexShrink: 1, textAlign: 'right' }}>{REMINDER_DISPLAY[prefs.reminders]}</Text>
      </Pressable>
      <Text style={{ color: p.fg, fontWeight: '600', marginTop: 10 }}>Zadania, które śledzę</Text>
      <Text style={{ color: p.muted, fontSize: 12 }}>
        Poza zadaniami, za które odpowiadasz: ukończenie i zmiana terminu przez kogoś innego oraz automatyczne przypomnienie. Komentarze przychodzą zawsze.
      </Text>
      <View style={styles.switchRow}>
        <Text style={{ color: p.fg, flex: 1 }}>Utworzone przeze mnie (także przypisane innym)</Text>
        <Switch accessibilityLabel="Śledź zadania utworzone przeze mnie" value={prefs.follow.created} onValueChange={(created) => save({ follow: { ...prefs.follow, created } })} />
      </View>
      <View style={styles.switchRow}>
        <Text style={{ color: p.fg, flex: 1 }}>Te, w których jestem uczestnikiem</Text>
        <Switch
          accessibilityLabel="Śledź zadania, w których jestem uczestnikiem"
          value={prefs.follow.participating}
          onValueChange={(participating) => save({ follow: { ...prefs.follow, participating } })}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Automatyczne przypomnienie: ${AUTO_REMINDER[prefs.autoReminder]}. Zmień`}
        onPress={() =>
          void pickOption<AutoReminderMode>(
            'Automatyczne przypomnienie',
            (['shared', 'all', 'off'] as const).map((v) => ({ label: AUTO_REMINDER[v], value: v, selected: prefs.autoReminder === v })),
          ).then((v) => v && v !== prefs.autoReminder && save({ autoReminder: v }))
        }
        style={[styles.row, { borderColor: p.border }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: p.fg, fontWeight: '600' }}>Automatyczne przypomnienie</Text>
          <Text style={{ color: p.muted, fontSize: 12 }}>O zadaniu z datą i godziną, za które odpowiadasz i które śledzisz — bez ustawiania ręcznie</Text>
        </View>
        <Text style={{ color: p.accent }}>{AUTO_REMINDER[prefs.autoReminder]}</Text>
      </Pressable>
      {prefs.autoReminder === 'off' ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Kiedy: ${autoReminderOffsetLabel(prefs.autoReminderOffset)}. Zmień`}
          onPress={() =>
            void pickOption<number>(
              'Kiedy przypomnieć',
              [...new Set([...AUTO_REMINDER_OFFSETS, prefs.autoReminderOffset])].map((m) => ({ label: autoReminderOffsetLabel(m), value: m, selected: prefs.autoReminderOffset === m })),
            ).then((m) => m !== undefined && m !== prefs.autoReminderOffset && save({ autoReminderOffset: m }))
          }
          style={[styles.row, { borderColor: p.border }]}
        >
          <Text style={{ color: p.fg, flex: 1 }}>Kiedy</Text>
          <Text style={{ color: p.accent }}>{autoReminderOffsetLabel(prefs.autoReminderOffset)}</Text>
        </Pressable>
      )}
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
  bell: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
  count: { position: 'absolute', top: 2, right: -4, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
  countText: { color: '#ffffff', fontSize: 10, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  kinds: { paddingVertical: 6, paddingLeft: 8 },
  time: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
});
