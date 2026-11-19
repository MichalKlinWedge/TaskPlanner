/**
 * Powrót z logowania: `taskplanner://auth-callback?code=…` (link z maila albo Google). Expo Router
 * otwiera ten ekran z parametrami zapytania; kod wymienia `completeAuth` (raz, choćby powrót
 * przyszedł też przez `openAuthSessionAsync`). Dalej ekran startowy, a bramka w `_layout`
 * pokazuje onboarding, jeśli profil go jeszcze nie ma.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Button, P, Screen, Section } from '@/components/ui';
import { completeAuth } from '@/lib/auth';

export default function AuthCallback() {
  const params = useLocalSearchParams<{ code?: string; error?: string; error_code?: string; error_description?: string }>();
  const [error, setError] = useState<string | null>(null);

  const { code, error: failure, error_code: failureCode, error_description: description } = params;

  useEffect(() => {
    completeAuth({ code, error: failure, error_code: failureCode, error_description: description })
      .then(() => router.replace('/'))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [code, failure, failureCode, description]);

  return (
    <Screen>
      <Section title={error ? 'Nie udało się zalogować' : 'Logowanie…'}>
        {error ? (
          <>
            <P tone="bad">{error}</P>
            <P muted>Link z maila działa raz i przez godzinę; nowy wyślesz z ekranu „Konto i serwer”.</P>
            <Button title="Konto i serwer" onPress={() => router.replace('/settings')} />
          </>
        ) : (
          <ActivityIndicator />
        )}
      </Section>
    </Screen>
  );
}
