/**
 * Wskaźnik synchronizacji: zmiany czekające w outboxie, odrzucone, ostatnia synchronizacja albo
 * błąd, postęp pierwszej (stronicowanej) synchronizacji. Dotknięcie = „Synchronizuj teraz”.
 */
import { plural } from '@taskplanner/core';
import { SYNCED_TABLES } from '@taskplanner/sync';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { sessionUser } from '@/lib/config';
import { useLocalQuery, useSyncStatus } from '@/lib/local-query';
import { syncNow } from '@/lib/sync';

import { usePalette } from './ui';

const CHANGES = ['zmiana', 'zmiany', 'zmian'] as const;
const PAGES = ['strona', 'strony', 'stron'] as const;

const clock = (ms: number) => new Date(ms).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function SyncIndicator() {
  const p = usePalette();
  const status = useSyncStatus();
  const user = sessionUser();
  const [busy, setBusy] = useState(false);
  const counts = useLocalQuery(
    [...SYNCED_TABLES],
    async (engine) => ({ pending: await engine.pendingCount(), rejected: (await engine.rejectedOps()).length }),
    [status.syncing, status.lastAt],
  );

  const pending = counts?.pending ?? 0;
  const rejected = counts?.rejected ?? 0;
  let line: string;
  let tone: 'ok' | 'bad' | 'muted' = 'muted';
  if (!user.online) line = `Tryb offline bez konta · ${pending ? `${plural(pending, CHANGES)} tylko na telefonie` : 'dane tylko na telefonie'}`;
  else if (status.syncing && status.firstSync && status.pull && !status.pull.done) line = `Pierwsza synchronizacja: pobrano ${plural(status.pull.page, PAGES)}…`;
  else if (status.syncing) line = status.firstSync ? 'Pierwsza synchronizacja…' : 'Synchronizacja…';
  else if (status.error) {
    line = `Błąd synchronizacji: ${status.error}`;
    tone = 'bad';
  } else if (status.lastAt) {
    line = `Zsynchronizowano o ${clock(status.lastAt)}`;
    tone = 'ok';
  } else line = 'Jeszcze bez synchronizacji';

  const details = [pending ? `${plural(pending, CHANGES)} do wysłania` : user.online ? 'wszystko wysłane' : null, rejected ? `odrzucone: ${rejected}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Synchronizuj teraz"
      disabled={!user.online || busy}
      onPress={() => {
        setBusy(true);
        syncNow()
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
      style={({ pressed }) => [styles.box, { borderColor: p.border, backgroundColor: p.card, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.dot, { backgroundColor: tone === 'ok' ? p.ok : tone === 'bad' ? p.bad : p.muted }]} />
      <View style={styles.text}>
        <Text style={[styles.line, { color: tone === 'bad' ? p.bad : p.fg }]} numberOfLines={3}>
          {line}
        </Text>
        {details ? <Text style={[styles.details, { color: p.muted }]}>{details}</Text> : null}
      </View>
      {status.syncing || busy ? <ActivityIndicator size="small" color={p.accent} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { flex: 1, gap: 2 },
  line: { fontSize: 14 },
  details: { fontSize: 12 },
});
