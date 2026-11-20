/**
 * Nagłówek zakładek: przełącznik przestrzeni (M2, „Wszystkie” albo jedna), wyszukiwarka i kropka
 * stanu synchronizacji (zielona / szara w trakcie / czerwona po błędzie; dotknięcie = Ustawienia).
 */
import { focusRemaining, focusElapsed, formatTimer } from '@taskplanner/core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { setCurrentWorkspace, useAppData, useWorkspace } from '@/lib/app-data';
import { sessionUser } from '@/lib/config';
import { isTicking, useFocusData } from '@/lib/focus';
import { useSyncStatus } from '@/lib/local-query';

import { pickOption } from './pickers';
import { usePalette } from './ui';

export function WorkspaceSwitcher() {
  const p = usePalette();
  const data = useAppData();
  const workspaceId = useWorkspace(data);
  const name = workspaceId ? (data.workspaces.find((w) => w.id === workspaceId)?.name ?? '—') : 'Wszystkie';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Przestrzeń: ${name}. Zmień`}
      hitSlop={8}
      onPress={() =>
        void pickOption<string>('Przestrzeń', [
          { label: 'Wszystkie', value: '', selected: !workspaceId },
          ...data.workspaces.map((w) => ({ label: w.name, value: w.id, selected: w.id === workspaceId })),
        ]).then((id) => id !== undefined && setCurrentWorkspace(id || null))
      }
      style={[styles.switcher, { borderColor: p.border }]}
    >
      <Text style={{ color: p.fg, fontSize: 13, maxWidth: 110 }} numberOfLines={1}>
        {name}
      </Text>
      <Text style={{ color: p.muted, fontSize: 10 }}>▼</Text>
    </Pressable>
  );
}

export function SyncDot() {
  const p = usePalette();
  const status = useSyncStatus();
  const online = sessionUser().online;
  const color = !online ? p.muted : status.error ? p.bad : status.lastAt ? p.ok : p.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={!online ? 'Tryb offline bez konta' : status.syncing ? 'Synchronizacja trwa' : status.error ? `Błąd synchronizacji: ${status.error}` : 'Zsynchronizowano'}
      hitSlop={10}
      onPress={() => router.push('/settings')}
      style={styles.dotWrap}
    >
      {status.syncing ? <ActivityIndicator size="small" color={p.accent} /> : <View style={[styles.dot, { backgroundColor: color }]} />}
    </Pressable>
  );
}

/** Wskaźnik timera skupienia (też uruchomionego na innym urządzeniu); dotknięcie — ekran skupienia. */
export function FocusChip() {
  const p = usePalette();
  const { state, settings } = useFocusData();
  const ticking = isTicking(state);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (state.phase === 'idle') return null;
  const at = new Date(now);
  const text = state.phase === 'ready' ? '☕ koniec' : formatTimer(focusRemaining(state, at, settings) ?? focusElapsed(state, at));
  const color = state.phase === 'focus' || state.phase === 'stopwatch' ? p.accent : p.ok;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Timer skupienia: ${text}. Otwórz`} hitSlop={8} onPress={() => router.push('/focus')} style={[styles.switcher, { borderColor: color }]}>
      <Text style={{ color, fontSize: 13, fontVariant: ['tabular-nums'] }}>
        {state.paused ? '❚❚ ' : '⏱ '}
        {text}
      </Text>
    </Pressable>
  );
}

export function HeaderRight() {
  const p = usePalette();
  return (
    <View style={styles.right}>
      <FocusChip />
      <WorkspaceSwitcher />
      <Pressable accessibilityRole="button" accessibilityLabel="Szukaj" hitSlop={10} onPress={() => router.push('/search')}>
        <Text style={{ color: p.fg, fontSize: 19 }}>⌕</Text>
      </Pressable>
      <SyncDot />
    </View>
  );
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row', alignItems: 'center', gap: 14, marginRight: 12 },
  switcher: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  dotWrap: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
