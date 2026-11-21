/**
 * Pasek nad listą, gdy synchronizacja wymaga uwagi: pierwsza (stronicowana) synchronizacja,
 * błąd, odrzucone zmiany albo tryb bez konta. W zwykłym stanie nic nie pokazuje — stan jest
 * w kropce nagłówka i w „Ustawieniach”.
 */
import { plural } from '@taskplanner/core';
import { router } from 'expo-router';
import type React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { sessionUser } from '@/lib/config';
import { useSyncStatus } from '@/lib/local-query';

import { UpdateBanner } from './app-update';
import { ScopeInvitesBanner } from './sharing';
import { usePalette } from './ui';

const PAGES = ['strona', 'strony', 'stron'] as const;

export function SyncBanner() {
  const p = usePalette();
  const status = useSyncStatus();
  const user = sessionUser();
  let text: string | null = null;
  let bad = false;
  if (!user.online) text = 'Tryb offline bez konta — dane tylko na telefonie. Zaloguj się w Ustawieniach.';
  else if (status.authLost) {
    text = 'Sesja wygasła — zaloguj się ponownie w Ustawieniach. Dane i zmiany na telefonie zostają.';
    bad = true;
  }  else if (status.syncing && status.firstSync) text = status.pull && !status.pull.done ? `Pierwsza synchronizacja: pobrano ${plural(status.pull.page, PAGES)}…` : 'Pierwsza synchronizacja…';
  else if (status.error) {
    text = `Synchronizacja: ${status.error}. Zmiany czekają na telefonie.`;
    bad = true;
  }
  if (!text) return null;
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push('/settings')} style={[styles.box, { backgroundColor: bad ? `${p.bad}22` : p.selected }]}>
      <Text style={{ color: bad ? p.bad : p.fg, fontSize: 13 }} numberOfLines={3}>
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { marginHorizontal: 12, marginTop: 10, borderRadius: 10, padding: 10 },
});

/** Nad listą: pasek synchronizacji (gdy trzeba) i podtytuł widoku. */
export function ScreenHeader({ subtitle, children }: { subtitle?: string; children?: React.ReactNode }) {
  const p = usePalette();
  return (
    <>
      <SyncBanner />
      <UpdateBanner />
      <ScopeInvitesBanner />
      {subtitle ? <Text style={{ color: p.muted, fontSize: 13, paddingHorizontal: 12, paddingTop: 10 }}>{subtitle}</Text> : null}
      {children}
    </>
  );
}
