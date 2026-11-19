import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { router, Stack, useSegments } from 'expo-router';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { TaskActionsProvider } from '@/components/actions';
import { PickerHost } from '@/components/pickers';
import { usePalette } from '@/components/ui';

import { onAppData, type AppData } from '@/lib/app-data';
import { registerBackgroundSync } from '@/lib/background-sync';
import { sessionUser } from '@/lib/config';
import { startFocusWork } from '@/lib/focus';
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
  const segments = useSegments();
  // Tylko odczyt w efekcie: wyjście z ekranu bez dodania nie może go otworzyć ponownie.
  const onShare = useRef(false);
  useEffect(() => {
    onShare.current = segments[0] === 'share';
  }, [segments]);
  useEffect(() => {
    // Ekran już otwarty pokazuje nowe udostępnienie sam — kolejny na stosie wracałby „Wstecz” do starego.
    if (hasShareIntent && !onShare.current) router.push('/share');
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
/**
 * Przeplanowanie przypomnień i widżet po zmianie danych (debounce 1,5 s). Timery JS i render Reacta
 * stoją, gdy aplikacja jest w tle, więc nasłuch jest poza Reactem, zmiana wczytana w tle idzie od
 * razu, a przy wyjściu z aplikacji — zaległa. Inaczej przypomnienie zadania dodanego tuż przed
 * wyjściem czekałoby do następnego otwarcia.
 */
function BackgroundWork() {
  useEffect(() => {
    let pending: { data: AppData; timer: ReturnType<typeof setTimeout> } | null = null;
    const run = (data: AppData) => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
      void scheduleReminders(data);
      void refreshTodayWidget(data).catch(() => undefined);
    };
    const offData = onAppData((data) => {
      if (!data.loaded) return;
      if (AppState.currentState !== 'active') return run(data);
      if (pending) clearTimeout(pending.timer);
      pending = { data, timer: setTimeout(() => run(data), 1500) };
    });
    const sub = AppState.addEventListener('change', (next) => {
      // Uprawnienia mogły się zmienić w ustawieniach systemu.
      if (next === 'active') void scheduleReminders();
      else if (pending) run(pending.data);
    });
    return () => {
      offData();
      sub.remove();
      if (pending) clearTimeout(pending.timer);
    };
  }, []);
  return null;
}

function useAppStart() {
  useEffect(() => {
    let alive = true;
    let stopFocus: (() => void) | undefined;
    const ready = setupNotifications().catch((error) => console.warn('powiadomienia', error));
    void ready.then(() => scheduleReminders());
    // Timer skupienia (po kanałach powiadomień): powiadomienia, koniec etapu w chwili końca, porzucone wpisy.
    void ready.then(() => {
      if (alive) stopFocus = startFocusWork(() => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined));
    });
    registerBackgroundSync().catch((error) => console.warn('synchronizacja w tle', error));
    startOnlineSync().catch((error) => console.warn('synchronizacja', error));
    refreshTodayWidget().catch(() => undefined);
    // Akcja z powiadomienia, gdy aplikacja jest na wierzchu (w tle obsługuje ją zadanie z index.ts).
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      void handleResponse(response, 'foreground');
    });
    return () => {
      alive = false;
      sub.remove();
      stopFocus?.();
    };
  }, []);
}

/** Dotknięcie powiadomienia (nie przycisku): timer → ekran skupienia, nawyk → „Nawyki”, zadanie → szczegóły. */
function NotificationTap() {
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const key = `${response.notification.request.identifier}:${response.notification.date}`;
    if (handled.current === key) return;
    handled.current = key;
    const data = (response.notification.request.content.data ?? {}) as { focus?: boolean; taskId?: string; habit?: boolean; batch?: string };
    if (data.focus) router.push('/focus');
    else if (data.habit) router.push('/habits');
    else if (data.taskId && !data.batch) router.push({ pathname: '/task/[id]', params: { id: data.taskId } });
  }, [response]);
  return null;
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
          <NotificationTap />
          <Stack screenOptions={{ headerStyle: { backgroundColor: p.card }, headerTintColor: p.fg, contentStyle: { backgroundColor: p.bg } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'TaskPlanner' }} />
            <Stack.Screen name="task/[id]" options={{ title: 'Zadanie' }} />
            <Stack.Screen name="focus" options={{ title: 'Skupienie' }} />
            <Stack.Screen name="habits" options={{ title: 'Nawyki' }} />
            <Stack.Screen name="habit/[id]" options={{ title: 'Nawyk' }} />
            <Stack.Screen name="habit-form" options={{ title: 'Nawyk' }} />
            <Stack.Screen name="board" options={{ title: 'Tablica' }} />
            <Stack.Screen name="review/daily" options={{ title: 'Przegląd dnia' }} />
            <Stack.Screen name="review/weekly" options={{ title: 'Przegląd tygodnia' }} />
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
