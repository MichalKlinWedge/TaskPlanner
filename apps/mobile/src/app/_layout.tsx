import { inviteTokenFrom, isTransientError } from '@taskplanner/core';
import * as Haptics from 'expo-haptics';
import { NavigationBar } from 'expo-navigation-bar';
import * as Notifications from 'expo-notifications';
import { router, Stack, usePathname, useSegments, type ErrorBoundaryProps } from 'expo-router';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { AppState, ScrollView, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { TaskActionsProvider, useTaskActions } from '@/components/actions';
import { NotificationToasts, openNotificationRoute } from '@/components/notifications';
import { PickerHost } from '@/components/pickers';
import { ReminderPopup } from '@/components/reminder-popup';
import { Button, usePalette } from '@/components/ui';

import { handleAlarmActions } from '@/lib/alarm-actions';
import { onAppData, type AppData } from '@/lib/app-data';
import { registerBackgroundSync } from '@/lib/background-sync';
import { sessionUser } from '@/lib/config';
import { startDevice } from '@/lib/device';
import { flushErrors, reportError, setErrorRoute } from '@/lib/error-log';
import { startCapture } from '@/lib/files';
import { startFocusWork, syncFocusNotifications } from '@/lib/focus';
import { markNotificationReadById, showNotificationPushes } from '@/lib/notifications';
import { loadProfile, onboardingGateHeld, onOnboardingGateRelease } from '@/lib/profile';
import { handleResponse, setupNotifications } from '@/lib/reminders';
import { scheduleReminders } from '@/lib/scheduler';
import { acceptLinkInvite } from '@/lib/sharing';
import { localEngine, onSessionChange, onSynced, startOnlineSync } from '@/lib/sync';
import { applySavedTheme, applyTheme } from '@/lib/theme';
import { refreshWidgets } from '@/widget/refresh';

applySavedTheme();

/** Głęboki link (skrót aplikacji, powiadomienie) do ekranu nad zakładkami — pod spodem zawsze zakładki. */
export const unstable_settings = { anchor: '(tabs)' };

/**
 * Granica błędów renderowania całej aplikacji (Expo Router: eksport `ErrorBoundary` z root layout) —
 * błąd idzie do dziennika (`render`), ekran pozwala spróbować ponownie.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const p = usePalette();
  useEffect(() => reportError('render', error, { boundary: 'root' }), [error]);
  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={{ padding: 24, paddingTop: 64, gap: 12 }}>
      <Text style={{ color: p.fg, fontSize: 20, fontWeight: '700' }}>Coś poszło nie tak</Text>
      <Text style={{ color: p.muted }}>Błąd zapisano w dzienniku aplikacji. Dane są bezpieczne w lokalnej bazie.</Text>
      <Text style={{ color: p.bad, fontFamily: 'monospace', fontSize: 12 }}>{error.message}</Text>
      <Button title="Spróbuj ponownie" onPress={() => void retry()} />
    </ScrollView>
  );
}

/** Bieżący ekran do wpisów dziennika błędów. */
function ErrorRoute() {
  const path = usePathname();
  useEffect(() => setErrorRoute(path), [path]);
  return null;
}

/** Udostępnienie z innej aplikacji (Chrome → „Udostępnij”) → ekran szybkiego dodawania. */
function ShareRedirect() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const invite = inviteTokenFrom((hasShareIntent && shareIntent.webUrl) || '');
  const segments = useSegments();
  // Tylko odczyt w efekcie: wyjście z ekranu bez dodania nie może go otworzyć ponownie.
  const onShare = useRef(false);
  useEffect(() => {
    onShare.current = segments[0] === 'share';
  }, [segments]);
  useEffect(() => {
    // Ekran już otwarty pokazuje nowe udostępnienie sam — kolejny na stosie wracałby „Wstecz” do starego.
    if (!hasShareIntent || onShare.current) return;
    // Otwarte okno (np. szybkie dodawanie jako arkusz) zasłoniłoby ekran udostępniania.
    if (router.canDismiss()) router.dismissAll();
    // Udostępniony link zaproszenia to zaproszenie, nie zadanie.
    if (invite) {
      resetShareIntent();
      router.push({ pathname: '/invite', params: { invite } });
    } else router.push('/share');
  }, [hasShareIntent, invite, resetShareIntent]);
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
      void refreshWidgets(data).catch(() => undefined);
    };
    const offData = onAppData((data) => {
      if (!data.loaded) return;
      applyTheme(data.settings.theme);
      if (AppState.currentState !== 'active') return run(data);
      if (pending) clearTimeout(pending.timer);
      pending = { data, timer: setTimeout(() => run(data), 1500) };
    });
    const sub = AppState.addEventListener('change', (next) => {
      // Uprawnienia mogły się zmienić w ustawieniach systemu.
      if (next === 'active') void handleAlarmActions().then(() => scheduleReminders());
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
    void ready.then(handleAlarmActions).then(() => scheduleReminders());
    // Timer skupienia (po kanałach powiadomień): powiadomienia, koniec etapu w chwili końca, porzucone wpisy.
    void ready.then(() => {
      if (alive) stopFocus = startFocusWork(() => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined));
    });
    registerBackgroundSync().catch((error) => console.warn('synchronizacja w tle', error));
    startOnlineSync().catch((error) => console.warn('synchronizacja', error));
    refreshWidgets().catch(() => undefined);
    // Wpisy z poprzedniego uruchomienia (np. błąd krytyczny) i po każdej udanej synchronizacji.
    void flushErrors();
    startCapture();
    const offSynced = onSynced(() => {
      void flushErrors();
      // Aplikacja w tle (proces jeszcze żyje): nowe powiadomienia do zasobnika; na wierzchu — dymek.
      if (AppState.currentState !== 'active') void showNotificationPushes().catch(() => undefined);
    });
    // Telefon na liście urządzeń; wyłączone przypomnienia (tu albo na webie) i skończony przegląd działają od razu.
    const stopDevice = startDevice(() => {
      void scheduleReminders();
      void syncFocusNotifications();
    });
    // Akcja z powiadomienia, gdy aplikacja jest na wierzchu (w tle obsługuje ją zadanie z index.ts).
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      void handleResponse(response, 'foreground');
    });
    return () => {
      alive = false;
      sub.remove();
      offSynced();
      stopDevice();
      stopFocus?.();
    };
  }, []);
}

/** Zaproszenie z linku otwartego przed zalogowaniem: przyjęte po zalogowaniu (i po powrocie do aplikacji, gdy nie było sieci). */
function InviteLink() {
  const { notify } = useTaskActions();
  useEffect(() => {
    const accept = () =>
      void acceptLinkInvite()
        .then((accepted) => accepted && notify('Dołączono do udostępnionej przestrzeni — jej zadania pobierają się na telefon.'))
        .catch((e: unknown) => !isTransientError(e) && notify(`Nie udało się przyjąć zaproszenia z linku: ${e instanceof Error ? e.message : String(e)}`));
    const offSession = onSessionChange(accept);
    const sub = AppState.addEventListener('change', (next) => next === 'active' && accept());
    // Start z linku obsługuje ekran `/invite`; tu zaległy token z poprzedniego uruchomienia.
    accept();
    return () => {
      offSession();
      sub.remove();
    };
  }, [notify]);
  return null;
}

/** Dotknięcie powiadomienia (nie przycisku): timer → ekran skupienia, nawyk → „Cykliczne”, zadanie → szczegóły, centrum powiadomień → przeczytane + cel. */
function NotificationTap() {
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const key = `${response.notification.request.identifier}:${response.notification.date}`;
    if (handled.current === key) return;
    handled.current = key;
    const data = (response.notification.request.content.data ?? {}) as { focus?: boolean; review?: 'daily' | 'weekly'; taskId?: string; habit?: boolean; batch?: string; notification?: string; route?: string };
    if (data.notification) {
      void markNotificationReadById(data.notification).catch(() => undefined);
      openNotificationRoute(data.route ?? '/notifications');
    } else if (data.focus) router.push('/focus');
    else if (data.review) router.push(data.review === 'weekly' ? '/review/weekly' : '/review/daily');
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
          <ErrorRoute />
          <ShareRedirect />
          <OnboardingGate />
          <BackgroundWork />
          <NotificationTap />
          <NotificationToasts />
          <ReminderPopup />
          <InviteLink />
          {/* Systemowy pasek nawigacji schowany; przesunięcie od dolnej krawędzi pokazuje go na chwilę. */}
          <NavigationBar hidden />
          <Stack screenOptions={{ headerStyle: { backgroundColor: p.card }, headerTintColor: p.fg, contentStyle: { backgroundColor: p.bg } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Task Planner' }} />
            <Stack.Screen name="task/[id]" options={{ title: 'Zadanie' }} />
            <Stack.Screen name="focus" options={{ title: 'Skupienie' }} />
            <Stack.Screen name="habits" options={{ title: 'Cykliczne' }} />
            <Stack.Screen name="habit/[id]" options={{ title: 'Cykliczne' }} />
            <Stack.Screen name="habit-form" options={{ title: 'Cykliczne' }} />
            <Stack.Screen name="board" options={{ title: 'Tablica' }} />
            <Stack.Screen name="calendar" options={{ title: 'Kalendarz' }} />
            <Stack.Screen name="overdue" options={{ title: 'Zaległe' }} />
            <Stack.Screen name="review/daily" options={{ title: 'Przegląd dnia' }} />
            <Stack.Screen name="review/weekly" options={{ title: 'Przegląd tygodnia' }} />
            <Stack.Screen name="quick-add" options={{ title: 'Szybkie dodawanie', presentation: 'formSheet', sheetAllowedDetents: 'fitToContents', headerShown: false }} />
            <Stack.Screen name="list/[id]" options={{ title: 'Lista' }} />
            <Stack.Screen name="tag/[id]" options={{ title: 'Tag' }} />
            <Stack.Screen name="filter/[id]" options={{ title: 'Filtr' }} />
            <Stack.Screen name="search" options={{ title: 'Szukaj' }} />
            <Stack.Screen name="notifications" options={{ title: 'Powiadomienia' }} />
            <Stack.Screen name="trash" options={{ title: 'Kosz' }} />
            <Stack.Screen name="workspaces" options={{ title: 'Przestrzenie i listy' }} />
            <Stack.Screen name="workspace/[id]" options={{ title: 'Przestrzeń' }} />
            <Stack.Screen name="collaborators" options={{ title: 'Współpracownicy' }} />
            <Stack.Screen name="onboarding" options={{ title: 'Witaj w Task Planner', headerBackVisible: false, gestureEnabled: false }} />
            <Stack.Screen name="auth-callback" options={{ title: 'Logowanie' }} />
            <Stack.Screen name="settings" options={{ title: 'Konto i synchronizacja' }} />
            <Stack.Screen name="dev" options={{ title: 'Narzędzia PoC' }} />
            <Stack.Screen name="widget" options={{ title: 'Dziś i widżet (PoC-4)' }} />
            <Stack.Screen name="reminders" options={{ title: 'Przypomnienia (PoC-4)' }} />
            <Stack.Screen name="invite" options={{ title: 'Zaproszenie' }} />
            <Stack.Screen name="share" options={{ title: 'Udostępnione' }} />
            <Stack.Screen name="selftest" options={{ title: 'Samosprawdzenie (Hermes)' }} />
          </Stack>
          <PickerHost />
        </TaskActionsProvider>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}
