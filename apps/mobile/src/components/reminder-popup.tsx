/**
 * Okno przypomnienia na środku ekranu telefonu (jak `reminder-popup.tsx` na webie): tryb „W dzwonku i okno na środku
 * ekranu” w Ustawieniach → Powiadomienia (`NotificationPrefs.reminders = 'popup'`, wspólne z webem). Wybite
 * przypomnienie z dzwonka (core `reminderPopups`: nieprzeczytane, ≤ 15 min, okno niezamknięte) z „Ukończ”,
 * „Przypomnij za 15 min / 30 min / 1 h”, „Otwórz zadanie” i „Zamknij” (wstecz — wpis zostaje w dzwonku). Akcje jak
 * w dzwonku (`lib/reminder-bell.ts`); stan zamkniętych okien — kv-store tego telefonu.
 */
import { notificationText, notificationTime, REMINDER_SNOOZE_OPTIONS, reminderPopups, reminderSnoozeLabel, type AppNotification } from '@taskplanner/core';
import { useEffect, useState } from 'react';
import { AppState, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppData } from '@/lib/app-data';
import { notificationRoute } from '@/lib/notifications';
import { bellReminderDone, closeBellPopups, markBellRead, snoozeBellReminder, useBellNotifications, useReminderBellState } from '@/lib/reminder-bell';

import { useTaskActions } from './actions';
import { openNotificationRoute } from './notifications';
import { usePalette } from './ui';

export function ReminderPopup() {
  const p = usePalette();
  const data = useAppData();
  const { run, notify } = useTaskActions();
  const { list, prefs, timeZone } = useBellNotifications();
  const bell = useReminderBellState();
  const [now, setNow] = useState(() => new Date());
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Co 10 s: wpis ma czas wybicia, więc okno pokaże się najwyżej tyle po nim.
    const timer = setInterval(() => setNow(new Date()), 10_000);
    const sub = AppState.addEventListener('change', (state) => {
      setActive(state === 'active');
      if (state === 'active') setNow(new Date());
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);

  const queue = active && data.userId ? reminderPopups(list, prefs, bell, now) : [];
  const n = queue[0];
  if (!n) return null;

  const title = typeof n.data.title === 'string' ? n.data.title : 'Zadanie';
  const { detail } = notificationText(n);
  const step = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((e: unknown) => {
        notify(e instanceof Error ? e.message : String(e));
        closeBellPopups([n]);
      })
      .finally(() => setBusy(false));
  };
  const done = (item: AppNotification) =>
    step(async () => {
      const result = await bellReminderDone(item, data);
      if ('note' in result) {
        notify(result.note);
        closeBellPopups([item]);
        if (result.taskId) openNotificationRoute(notificationRoute(item));
        return;
      }
      await run(result.ops, { text: result.text, undo: result.undo });
      await markBellRead([item]);
    });
  const snooze = (item: AppNotification, minutes: number) =>
    step(async () => {
      const time = await snoozeBellReminder(item, data, minutes);
      if (time) notify(`„${title}” — przypomnę o ${time}`);
      else {
        notify(`„${title}” jest już zamknięte albo usunięte.`);
        closeBellPopups([item]);
      }
    });
  const openTask = () => {
    void markBellRead([n]).catch(() => undefined);
    openNotificationRoute(notificationRoute(n));
  };

  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={() => closeBellPopups([n])}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]} accessibilityViewIsModal accessibilityRole="alert" testID="reminder-popup">
          <View style={styles.head}>
            <Text style={{ color: p.muted, fontSize: 12, flex: 1 }}>⏰ Przypomnienie · {notificationTime(n.at, now, timeZone)}</Text>
            {queue.length > 1 ? <Text style={{ color: p.muted, fontSize: 12 }}>1 z {queue.length}</Text> : null}
          </View>
          <Text style={[styles.title, { color: p.fg }]}>{title}</Text>
          {detail ? <Text style={{ color: p.muted, fontSize: 13, marginTop: 2 }}>{detail}</Text> : null}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Ukończ „${title}”`}
              disabled={busy}
              onPress={() => done(n)}
              style={({ pressed }) => [styles.primary, { backgroundColor: p.accent, opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
            >
              <Text style={[styles.primaryText, { color: p.onAccent }]}>✓ Ukończ</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={openTask} style={[styles.chip, { borderColor: p.border }]}>
              <Text style={{ color: p.fg }}>Otwórz zadanie</Text>
            </Pressable>
          </View>
          <View style={styles.row} accessibilityLabel="Przypomnij ponownie">
            <Text style={{ color: p.muted }}>Przypomnij za</Text>
            {REMINDER_SNOOZE_OPTIONS.map((m) => (
              <Pressable
                key={m}
                accessibilityRole="button"
                accessibilityLabel={`Przypomnij za ${reminderSnoozeLabel(m)}`}
                disabled={busy}
                onPress={() => snooze(n, m)}
                style={[styles.chip, { borderColor: p.border, opacity: busy ? 0.5 : 1 }]}
              >
                <Text style={{ color: p.fg }}>{reminderSnoozeLabel(m)}</Text>
              </Pressable>
            ))}
          </View>
          <View style={[styles.footer, { borderColor: p.border }]}>
            {queue.length > 1 ? (
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => closeBellPopups(queue)}>
                <Text style={{ color: p.muted }}>Zamknij wszystkie ({queue.length})</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Zamknij — zostaje w dzwonku" hitSlop={8} onPress={() => closeBellPopups([n])}>
              <Text style={{ color: p.muted }}>Zamknij</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 420, borderWidth: 1, borderRadius: 14, padding: 18 },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  title: { fontSize: 19, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 14 },
  primary: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  primaryText: { color: '#ffffff', fontWeight: '600' },
  chip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 18, marginTop: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
