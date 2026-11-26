/**
 * Ekran „Powiadomienia” (jak `#/notifications` na webie): lista z podziałem na dni, filtry stanu, rodzaju
 * i przestrzeni, „Oznacz jako przeczytane”, dotknięcie = przeczytane + cel (zadanie, przestrzenie, ustawienia),
 * ✕ = usunięcie z listy (też na innych urządzeniach). Dane z lokalnej bazy — działa offline.
 */
import {
  dismissOps,
  filterNotifications,
  NOTIFICATION_GROUP_SHORT,
  NOTIFICATION_GROUPS,
  notificationDays,
  notificationText,
  notificationTime,
  notificationWorkspaces,
  type AppNotification,
  type NotificationFilter,
} from '@taskplanner/core';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { NOTIFICATION_ICON, openNotificationRoute } from '@/components/notifications';
import { pickOption } from '@/components/pickers';
import { Button, Chip, P, Screen, usePalette } from '@/components/ui';
import { useAppData } from '@/lib/app-data';
import { markNotificationsRead, markNotificationsShown, notificationRoute, useNotificationsData } from '@/lib/notifications';
import { mutateMany } from '@/lib/sync';

export default function NotificationsScreen() {
  const p = usePalette();
  const data = useAppData();
  const { list, prefs, timeZone, loaded } = useNotificationsData();
  const [filter, setFilter] = useState<NotificationFilter>({ only: 'all', group: null, workspaceId: null });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Widziane na liście nie wrócą jako powiadomienie systemowe.
  useEffect(() => {
    if (loaded) markNotificationsShown(list);
  }, [list, loaded]);

  const shown = filterNotifications(list, prefs, now, filter);
  const unread = filterNotifications(list, prefs, now, { ...filter, only: 'unread' });
  const spaces = notificationWorkspaces(list).map((w) => ({ id: w.id, name: data.workspaces.find((x) => x.id === w.id)?.name ?? (w.name || 'Przestrzeń') }));
  const space = spaces.find((w) => w.id === filter.workspaceId);
  const groups = NOTIFICATION_GROUPS.filter((g) => prefs[g] !== 'off');

  const open = (n: AppNotification) => {
    void markNotificationsRead([n]).catch(() => undefined);
    openNotificationRoute(notificationRoute(n));
  };

  return (
    <Screen>
      <View style={styles.filters}>
        {(['all', 'unread'] as const).map((v) => (
          <Chip key={v} label={v === 'unread' ? `Nieprzeczytane${unread.length ? ` (${unread.length})` : ''}` : 'Wszystkie'} selected={filter.only === v} onPress={() => setFilter({ ...filter, only: v })} />
        ))}
      </View>
      <View style={styles.filters}>
        <Chip label="Każdy rodzaj" selected={!filter.group} onPress={() => setFilter({ ...filter, group: null })} />
        {groups.map((g) => (
          <Chip key={g} label={NOTIFICATION_GROUP_SHORT[g]} selected={filter.group === g} onPress={() => setFilter({ ...filter, group: g })} />
        ))}
        {spaces.length ? (
          <Chip
            label={space ? `▾ ${space.name}` : '▾ Wszystkie przestrzenie'}
            selected={!!space}
            onPress={() =>
              void pickOption<string>('Przestrzeń', [
                { label: 'Wszystkie przestrzenie', value: '', selected: !space },
                ...spaces.map((w) => ({ label: w.name, value: w.id, selected: w.id === filter.workspaceId })),
              ]).then((id) => id !== undefined && setFilter({ ...filter, workspaceId: id || null }))
            }
          />
        ) : null}
      </View>
      {unread.length ? <Button kind="secondary" title={`Oznacz jako przeczytane (${unread.length})`} onPress={() => void markNotificationsRead(unread).catch(() => undefined)} /> : null}
      {!loaded ? null : shown.length ? (
        notificationDays(shown, now, timeZone).map((day) => (
          <View key={day.label} style={{ marginTop: 12 }}>
            <Text style={[styles.day, { color: p.muted }]}>{day.label}</Text>
            <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
              {day.items.map((n, i) => {
                const { text, detail } = notificationText(n);
                return (
                  <View key={n.id} style={[styles.item, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border }]}>
                    <Text style={styles.icon}>{NOTIFICATION_ICON[n.kind]}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={`${n.readAt ? '' : 'Nieprzeczytane. '}${text}`} onPress={() => open(n)} style={{ flex: 1 }}>
                      <Text style={{ color: n.readAt ? p.muted : p.fg, fontWeight: n.readAt ? '400' : '600' }}>{text}</Text>
                      {detail ? (
                        <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={2}>
                          {detail}
                        </Text>
                      ) : null}
                      <Text style={{ color: p.muted, fontSize: 11, marginTop: 2 }}>{notificationTime(n.at, now, timeZone)}</Text>
                    </Pressable>
                    {n.readAt ? null : <View style={[styles.dot, { backgroundColor: p.accent }]} />}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Usuń z listy"
                      hitSlop={10}
                      onPress={() => void mutateMany(dismissOps([n], new Date())).catch(() => undefined)}
                    >
                      <Text style={{ color: p.muted, fontSize: 14 }}>✕</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </View>
        ))
      ) : (
        <P muted>{filter.only === 'unread' ? 'Wszystko przeczytane.' : 'Brak powiadomień.'}</P>
      )}
      <P muted>Powiadomienia starsze niż 90 dni znikają same. Które zdarzenia trafiają tutaj i do zasobnika — Konto → Powiadomienia.</P>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  day: { fontSize: 12, fontWeight: '600', marginBottom: 4, marginLeft: 4 },
  card: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  icon: { width: 22, textAlign: 'center', fontSize: 15, marginTop: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
});
