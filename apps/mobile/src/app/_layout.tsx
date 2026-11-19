import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { handleResponse, setupNotifications } from '@/lib/reminders';
import { startOnlineSync } from '@/lib/sync';
import { refreshTodayWidget } from '@/widget/refresh';

/** Udostępnienie z innej aplikacji (Chrome → „Udostępnij”) → ekran szybkiego dodawania. */
function ShareRedirect() {
  const { hasShareIntent } = useShareIntentContext();
  useEffect(() => {
    if (hasShareIntent) router.push('/share');
  }, [hasShareIntent]);
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
        <Stack>
          <Stack.Screen name="index" options={{ title: 'TaskPlanner · PoC-4' }} />
          <Stack.Screen name="today" options={{ title: 'Dziś i widżet' }} />
          <Stack.Screen name="reminders" options={{ title: 'Przypomnienia' }} />
          <Stack.Screen name="share" options={{ title: 'Szybkie dodawanie' }} />
          <Stack.Screen name="calendar" options={{ title: 'Kalendarz (calendar-kit)' }} />
          <Stack.Screen name="timeline" options={{ title: 'Oś dnia (własna)' }} />
          <Stack.Screen name="selftest" options={{ title: 'Samosprawdzenie (Hermes)' }} />
          <Stack.Screen name="settings" options={{ title: 'Serwer i konto' }} />
        </Stack>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}
