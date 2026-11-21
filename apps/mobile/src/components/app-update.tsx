/**
 * Aktualizacja aplikacji (`lib/app-update.ts`): baner nad listami, gdy jest nowsza wersja
 * (sprawdzenie przy starcie i powrocie do aplikacji, najwyżej co kilka godzin), i sekcja
 * „Aktualizacje” w ustawieniach — wersja, „Sprawdź teraz”, pobieranie z postępem, instalacja.
 */
import { formatBytes, type AppRelease } from '@taskplanner/core';
import { useEffect, useRef } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { checkForUpdate, dismissedVersion, dismissUpdate, downloadAndInstall, INSTALLED_VERSION, install, useAppUpdate, type UpdateState } from '@/lib/app-update';
import { devToolsEnabled, setDevToolsEnabled } from '@/lib/config';

import { Button, P, Section, usePalette } from './ui';

/** Sprawdzenie przy montowaniu i po każdym powrocie aplikacji na pierwszy plan (z odstępem z core). */
function useAutoCheck() {
  useEffect(() => {
    void checkForUpdate();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void checkForUpdate();
    });
    return () => sub.remove();
  }, []);
}

const percent = (progress: number | null) => (progress === null ? '' : ` ${Math.round(progress * 100)} %`);

/** Główna akcja dla stanu: pobierz i zainstaluj / zainstaluj pobrany / postęp. */
function primary(state: UpdateState, release: AppRelease): { title: string; onPress: () => void; disabled?: boolean } {
  if (state.status === 'downloading') return { title: `Pobieranie…${percent(state.progress)}`, onPress: () => undefined, disabled: true };
  if (state.status === 'ready') return { title: 'Zainstaluj', onPress: () => void install(release) };
  return { title: `Pobierz i zainstaluj (${formatBytes(release.apk.size)})`, onPress: () => void downloadAndInstall(release) };
}

export function UpdateBanner() {
  const p = usePalette();
  const state = useAppUpdate();
  useAutoCheck();
  const { release } = state;
  if (!release || (dismissedVersion() === release.version && state.status === 'idle')) return null;
  const action = primary(state, release);
  return (
    <View style={[styles.box, { backgroundColor: p.selected }]}>
      <Text style={{ color: p.fg, fontSize: 13 }}>
        Nowa wersja aplikacji: {release.version} (masz {INSTALLED_VERSION ?? '?'}).
      </Text>
      {'error' in state && state.error ? <Text style={{ color: p.bad, fontSize: 12 }}>{state.error}</Text> : null}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={action.disabled} onPress={action.onPress} style={({ pressed }) => [styles.action, { backgroundColor: p.accent, opacity: action.disabled ? 0.6 : pressed ? 0.7 : 1 }]}>
          <Text style={styles.actionText}>{action.title}</Text>
        </Pressable>
        {state.status === 'downloading' ? null : (
          <Pressable accessibilityRole="button" onPress={() => dismissUpdate(release)} style={styles.later}>
            <Text style={{ color: p.muted, fontSize: 13 }}>Później</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'jeszcze nie');

/** Siedem stuknięć numeru wersji w ciągu 3 s przełącza „Narzędzia PoC” (`devToolsEnabled`). */
function useDevToolsTaps(): () => void {
  const taps = useRef<number[]>([]);
  return () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now];
    if (taps.current.length < 7) return;
    taps.current = [];
    const enabled = !devToolsEnabled();
    setDevToolsEnabled(enabled);
    Alert.alert('Narzędzia PoC', enabled ? 'Widoczne w „Przeglądaj” → „Więcej”.' : 'Ukryte.');
  };
}

export function UpdateSection() {
  const state = useAppUpdate();
  const { release } = state;
  const tapVersion = useDevToolsTaps();
  return (
    <Section title="Aktualizacje">
      <P muted onPress={tapVersion}>
        Wersja {INSTALLED_VERSION ?? '?'} · sprawdzono: {when(state.checkedAt)}. Nowe wersje są w GitHub Releases; Android przy instalacji pyta o zgodę (za pierwszym razem także „Instaluj nieznane aplikacje” dla Task Plannera). Dane zostają.
      </P>
      {release ? (
        <>
          <P>
            Dostępna wersja {release.version}
            {release.publishedAt ? ` z ${new Date(release.publishedAt).toLocaleDateString('pl-PL')}` : ''}.
          </P>
          {release.notes ? <P muted>{release.notes}</P> : null}
          <Button {...primary(state, release)} />
        </>
      ) : state.status === 'checking' ? (
        <P muted>Sprawdzanie…</P>
      ) : state.checkedAt ? (
        <P tone="ok">Masz najnowszą wersję.</P>
      ) : null}
      {'error' in state && state.error ? <P tone="bad">{state.error}</P> : null}
      <Button kind="secondary" title="Sprawdź teraz" disabled={state.status === 'checking' || state.status === 'downloading'} onPress={() => void checkForUpdate({ force: true })} />
    </Section>
  );
}

const styles = StyleSheet.create({
  box: { marginHorizontal: 12, marginTop: 10, borderRadius: 10, padding: 10, gap: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  action: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  actionText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },
  later: { paddingVertical: 7 },
});
