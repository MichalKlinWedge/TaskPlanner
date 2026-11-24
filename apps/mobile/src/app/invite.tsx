/**
 * Zaproszenie do przestrzeni z linku: `https://<web>/invite?invite=<token>` (App Links, `app.json` +
 * `assetlinks.json` na webie) albo `taskplanner://invite?invite=<token>`. Token czeka w pamięci: zalogowany
 * przyjmuje go od razu, niezalogowany — po zalogowaniu (`InviteLink` w `_layout`).
 */
import { INVITE_PARAM, inviteTokenFrom } from '@taskplanner/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Button, P, Screen, Section } from '@/components/ui';
import { sessionUser } from '@/lib/config';
import { acceptLinkInvite, rememberInviteToken } from '@/lib/sharing';

export default function InviteScreen() {
  const params = useLocalSearchParams<{ invite?: string }>();
  // Ta sama walidacja tokenu co z adresu na webie.
  const token = inviteTokenFrom(`https://invite/?${INVITE_PARAM}=${encodeURIComponent(params.invite ?? '')}`);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const online = sessionUser().online;

  useEffect(() => {
    if (!token) return;
    rememberInviteToken(token);
    if (!online) return;
    let alive = true;
    acceptLinkInvite()
      .then((accepted) => alive && setDone(accepted))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [token, online, attempt]);

  const home = <Button title="Dziś" kind="secondary" onPress={() => router.replace('/')} />;
  return (
    <Screen>
      <Section title="Zaproszenie do przestrzeni">
        {!token ? (
          <P tone="bad">Link zaproszenia jest niepełny — poproś o nowy.</P>
        ) : !online ? (
          <>
            <P>Zaloguj się adresem, na który przyszło zaproszenie — przyjmie się samo po zalogowaniu.</P>
            <Button title="Zaloguj" onPress={() => router.replace('/settings')} />
          </>
        ) : error ? (
          <>
            <P tone="bad">Nie udało się przyjąć zaproszenia: {error}</P>
            <Button
              title="Spróbuj ponownie"
              onPress={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            />
          </>
        ) : done ? (
          <P tone="ok">Dołączono do udostępnionej przestrzeni — jej zadania pobierają się na telefon.</P>
        ) : (
          <ActivityIndicator />
        )}
        {home}
      </Section>
    </Screen>
  );
}
