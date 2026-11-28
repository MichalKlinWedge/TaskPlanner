/**
 * Nagłówek zakładek: przełącznik przestrzeni (M2, „Wszystkie” albo jedna), wyszukiwarka i zębatka ustawień
 * z kropką stanu synchronizacji w rogu (zielona / kółko w trakcie / czerwona po błędzie / szara offline),
 * obok niej ikona dostępnej aktualizacji aplikacji (dotknięcie = Ustawienia → „Aktualizacje”) i dzwonek powiadomień.
 */
import { focusRemaining, focusElapsed, formatTimer } from '@taskplanner/core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { setCurrentWorkspace, useAppData, useWorkspace, type Workspace } from '@/lib/app-data';
import { useAppUpdate } from '@/lib/app-update';
import { sessionUser } from '@/lib/config';
import { isTicking, useFocusData } from '@/lib/focus';
import { useSyncStatus } from '@/lib/local-query';

import { NotificationBell } from './notifications';
import { pickOption } from './pickers';
import { usePalette } from './ui';

/** Nazwa przestrzeni z dopiskiem roli w cudzej przestrzeni — jak przełącznik na webie. */
const workspaceLabel = (w: Pick<Workspace, 'name' | 'role'>) => (w.role === 'viewer' ? `${w.name} (podgląd)` : w.role === 'editor' ? `${w.name} (udostępniona)` : w.name);

export function WorkspaceSwitcher() {
  const p = usePalette();
  const data = useAppData();
  const workspaceId = useWorkspace(data);
  const current = workspaceId ? data.workspaces.find((w) => w.id === workspaceId) : undefined;
  const name = workspaceId ? (current ? workspaceLabel(current) : '—') : 'Wszystkie';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Przestrzeń: ${name}. Zmień`}
      hitSlop={8}
      onPress={() =>
        void pickOption<string>('Przestrzeń', [
          { label: 'Wszystkie', value: '', selected: !workspaceId },
          ...data.workspaces.map((w) => ({ label: workspaceLabel(w), value: w.id, selected: w.id === workspaceId })),
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

/** Ustawienia (konto, synchronizacja, przypomnienia…) — zębatka z kropką stanu synchronizacji w rogu. */
export function SettingsButton() {
  const p = usePalette();
  const status = useSyncStatus();
  const online = sessionUser().online;
  const color = !online || status.offline ? p.muted : status.error ? p.bad : status.lastAt ? p.ok : p.muted;
  const sync = !online ? 'tryb offline bez konta' : status.offline ? 'offline — zmiany czekają na telefonie' : status.syncing ? 'synchronizacja trwa' : status.error ? `błąd synchronizacji: ${status.error}` : 'zsynchronizowano';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Ustawienia; ${sync}`} hitSlop={4} onPress={() => router.push('/settings')} style={styles.gear}>
      {/* U+FE0E — znak tekstowy, nie kolorowe emoji. */}
      <Text style={{ color: p.fg, fontSize: 21, lineHeight: 24 }}>{'⚙︎'}</Text>
      <View style={[styles.badge, { backgroundColor: p.card }]}>
        {status.syncing && !status.offline ? <ActivityIndicator size={10} color={p.accent} /> : <View style={[styles.dot, { backgroundColor: color }]} />}
      </View>
    </Pressable>
  );
}

/** Ikona nowej wersji APK (zostaje też po „Później” na banerze); w trakcie pobierania — procent. */
export function UpdateIcon() {
  const p = usePalette();
  const state = useAppUpdate();
  if (!state.release) return null;
  const progress = state.status === 'downloading' && state.progress !== null ? `${Math.round(state.progress * 100)}%` : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Dostępna aktualizacja ${state.release.version}. Otwórz ustawienia`}
      hitSlop={8}
      onPress={() => router.push('/settings')}
      style={[styles.update, { backgroundColor: p.accent }]}
    >
      <Text style={styles.updateText}>{progress ?? '⬇'}</Text>
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
  if (state.phase === 'idle' || !settings.enabled) return null;
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
      <Pressable accessibilityRole="button" accessibilityLabel="Szukaj" hitSlop={4} onPress={() => router.push('/search')} style={styles.icon}>
        <Text style={{ color: p.fg, fontSize: 19 }}>⌕</Text>
      </Pressable>
      <NotificationBell />
      <UpdateIcon />
      <SettingsButton />
    </View>
  );
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row', alignItems: 'center', gap: 8, marginRight: 8 },
  icon: { minWidth: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
  switcher: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  gear: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', right: -3, bottom: -2, width: 13, height: 13, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5 },
  update: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  updateText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
});
