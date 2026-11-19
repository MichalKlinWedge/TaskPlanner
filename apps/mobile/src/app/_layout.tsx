import * as Notifications from 'expo-notifications';
import { router, Stack, useSegments } from 'expo-router';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { TaskActionsProvider } from '@/components/actions';
import { PickerHost } from '@/components/pickers';
import { usePalette } from '@/components/ui';

import { useAppData } from '@/lib/app-data';
import { registerBackgroundSync } from '@/lib/background-sync';
import { sessionUser } from '@/lib/config';
import { loadProfile, onboardingGateHeld, onOnboardingGateRelease } from '@/lib/profile';
import { handleResponse, setupNotifications } from '@/lib/reminders';
import { scheduleReminders } from '@/lib/scheduler';
import { localEngine, onSessionChange, startOnlineSync } from '@/lib/sync';
import { refreshTodayWidget } from '@/widget/refresh';

/** Głęboki link (skrót aplikacji, powiadomienie) do ekranu nad zakładkami — pod spodem zawsze zakładki. */
export const unstable_settings = { anchor: '(tabs)' };

/** Udostępnienie z innej aplikacji (Chrome → „Udostępnij”) → ekran szybkiego dodawania. */
function ShareRedirect() {
  const { hasShareIntent } = useShareIntentContext();
  useEffect(() => {
    if (hasShareIntent) router.push('/share');
  }, [hasShareIntent]);
  return null;
}

/**
 * Bramka onboardingu: zalogowany użytkownik, którego profil (z serwera albo lokalny) nie ma
 * `settings.onboarded`, trafia na kreator. Profil przychodzi z pierwszą synchronizacją, więc
 * sprawdzenie powtarza się po każdej zmianie tabeli `profiles`, po zmianie konta i po zwolnieniu
 * bramki przez ekran powrotu z logowania (`holdOnboardingGate`).
 */
function OnboardingGate() {
  const segments = useSegments();
  const current = useRef(segments[0] as string | undefined);
  useEffect(() => {
    current.current = segments[0];
  }, [segments]);

  useEffect(() => {
    let unwatch: (() => void) | undefined;
    let alive = true;
    let pushedAt = 0;
    const check = async () => {
      const user = sessionUser();
      if (!user.online) return;
      const engine = await localEngine();
      const profile = await loadProfile(engine, user.id);
      if (!alive || !profile || profile.onboarded || onboardingGateHeld()) return;
      // Kilka zmian `profiles` tuż po sobie (strony pierwszej synchronizacji) = jedno przejście.
      if (current.current !== 'onboarding' && current.current !== 'auth-callback' && Date.now() - pushedAt > 2000) {
        pushedAt = Date.now();
        router.push('/onboarding');
      }
    };
    const attach = () => {
      unwatch?.();
      localEngine()
        .then((engine) => {
          if (!alive) return;
          unwatch = engine.watch(['profiles'], () => void check());
          void check();
        })
        .catch(() => undefined);
    };
    attach();
    const offSession = onSessionChange(attach);
    const offRelease = onOnboardingGateRelease(() => void check());
    return () => {
      alive = false;
      unwatch?.();
      offSession();
      offRelease();
    };
  }, []);
  return null;
}

/**
 * Po zmianie danych (zapis na ekranie, synchronizacja) i po powrocie aplikacji na wierzch:
 * przeplanowanie przypomnień M8 i odświeżenie widżetu — seria zmian = jedno przeliczenie.
 */
function BackgroundWork() {
  const data = useAppData();
  useEffect(() => {
    if (!data.loaded) return;
    const timer = setTimeout(() => {
      void scheduleReminders(data);
      void refreshTodayWidget(data).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [data]);
  useEffect(() => {
    // Uprawnienia mogły się zmienić w ustawieniach systemu.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void scheduleReminders();
    });
    return () => sub.remove();
  }, []);
  return null;
}

function useAppStart() {
  useEffect(() => {
    setupNotifications()
      .then(() => scheduleReminders())
      .catch((error) => console.warn('powiadomienia', error));
    registerBackgroundSync().catch((error) => console.warn('synchronizacja w tle', error));
    startOnlineSync().catch((error) => console.warn('synchronizacja', error));
    refreshTodayWidget().catch(() => undefined);
    // Akcja z powiadomienia, gdy aplikacja jest na wierzchu (w tle obsługuje ją zadanie z index.ts).
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      void handleResponse(response, 'foreground');
    });
    return () => sub.remove();
  }, []);
}

export default function RootLayout() {
  useAppStart();
  const p = usePalette();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ShareIntentProvider>
        <TaskActionsProvider>
          <ShareRedirect />
          <OnboardingGate />
          <BackgroundWork />
          <Stack screenOptions={{ headerStyle: { backgroundColor: p.card }, headerTintColor: p.fg, contentStyle: { backgroundColor: p.bg } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'TaskPlanner' }} />
            <Stack.Screen name="task/[id]" options={{ title: 'Zadanie' }} />
            <Stack.Screen name="quick-add" options={{ title: 'Szybkie dodawanie', presentation: 'formSheet', sheetAllowedDetents: 'fitToContents', headerShown: false }} />
            <Stack.Screen name="list/[id]" options={{ title: 'Lista' }} />
            <Stack.Screen name="tag/[id]" options={{ title: 'Tag' }} />
            <Stack.Screen name="filter/[id]" options={{ title: 'Filtr' }} />
            <Stack.Screen name="search" options={{ title: 'Szukaj' }} />
            <Stack.Screen name="trash" options={{ title: 'Kosz' }} />
            <Stack.Screen name="workspaces" options={{ title: 'Przestrzenie i listy' }} />
            <Stack.Screen name="workspace/[id]" options={{ title: 'Przestrzeń' }} />
            <Stack.Screen name="onboarding" options={{ title: 'Witaj w TaskPlanner', headerBackVisible: false, gestureEnabled: false }} />
            <Stack.Screen name="auth-callback" options={{ title: 'Logowanie' }} />
            <Stack.Screen name="settings" options={{ title: 'Konto i synchronizacja' }} />
            <Stack.Screen name="dev" options={{ title: 'Narzędzia PoC' }} />
            <Stack.Screen name="widget" options={{ title: 'Dziś i widżet (PoC-4)' }} />
            <Stack.Screen name="reminders" options={{ title: 'Przypomnienia (PoC-4)' }} />
            <Stack.Screen name="share" options={{ title: 'Udostępnione' }} />
            <Stack.Screen name="calendar" options={{ title: 'Kalendarz (calendar-kit)' }} />
            <Stack.Screen name="timeline" options={{ title: 'Oś dnia (własna)' }} />
            <Stack.Screen name="selftest" options={{ title: 'Samosprawdzenie (Hermes)' }} />
          </Stack>
          <PickerHost />
        </TaskActionsProvider>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}
