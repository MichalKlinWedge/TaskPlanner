import * as Notifications from 'expo-notifications';
import { router, Stack, useSegments } from 'expo-router';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { sessionUser } from '@/lib/config';
import { loadProfile, onboardingGateHeld, onOnboardingGateRelease } from '@/lib/profile';
import { handleResponse, setupNotifications } from '@/lib/reminders';
import { localEngine, onSessionChange, startOnlineSync } from '@/lib/sync';
import { refreshTodayWidget } from '@/widget/refresh';

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

function useAppStart() {
  useEffect(() => {
    setupNotifications().catch((error) => console.warn('powiadomienia', error));
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
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ShareIntentProvider>
        <ShareRedirect />
        <OnboardingGate />
        <Stack>
          <Stack.Screen name="index" options={{ title: 'TaskPlanner' }} />
          <Stack.Screen name="workspaces" options={{ title: 'Przestrzenie i listy' }} />
          <Stack.Screen name="workspace/[id]" options={{ title: 'Przestrzeń' }} />
          <Stack.Screen name="onboarding" options={{ title: 'Witaj w TaskPlanner', headerBackVisible: false, gestureEnabled: false }} />
          <Stack.Screen name="auth-callback" options={{ title: 'Logowanie' }} />
          <Stack.Screen name="today" options={{ title: 'Dziś i widżet' }} />
          <Stack.Screen name="reminders" options={{ title: 'Przypomnienia' }} />
          <Stack.Screen name="share" options={{ title: 'Szybkie dodawanie' }} />
          <Stack.Screen name="calendar" options={{ title: 'Kalendarz (calendar-kit)' }} />
          <Stack.Screen name="timeline" options={{ title: 'Oś dnia (własna)' }} />
          <Stack.Screen name="selftest" options={{ title: 'Samosprawdzenie (Hermes)' }} />
          <Stack.Screen name="settings" options={{ title: 'Konto i serwer' }} />
        </Stack>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}
