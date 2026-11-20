import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { BackgroundStatus } from '@/components/background-status';
import { ErrorsSection } from '@/components/errors-section';
import { SyncIndicator } from '@/components/sync-indicator';
import { Button, Field, P, Row, Screen, Section } from '@/components/ui';
import { sendMagicLink, signInWithGoogle, signOut, verifyEmailCode } from '@/lib/auth';
import { saveServerConfig, serverConfig, sessionUser } from '@/lib/config';
import { useSyncStatus } from '@/lib/local-query';
import { onSessionChange, type PullPerf } from '@/lib/sync';

const seconds = (ms: number) => `${(ms / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;

/** Pomiar ostatniego pobrania: czas zapytania `pull_changes` kontra zapis do lokalnej bazy. */
function PullPerfInfo({ perf }: { perf: PullPerf }) {
  const when = new Date(perf.at).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <P muted mono>
      {`Ostatnie pobranie (${when}): ${perf.rows} wierszy, ${perf.pages} str., razem ${seconds(perf.totalMs)}
` +
        `zapytanie pull_changes ${seconds(perf.fetchMs)} · zapis SQLite ${seconds(perf.writeMs)} (scalenie ${seconds(perf.mergeMs ?? 0)}) · kolejka ${seconds(perf.waitMs ?? 0)}
` +
        `najwolniejsza strona: ${seconds(perf.slowest.fetchMs)} + ${seconds(perf.slowest.writeMs)}`}
    </P>
  );
}

export default function Settings() {
  const config = serverConfig();
  const [url, setUrl] = useState(config?.url ?? 'http://127.0.0.1:54521');
  const [key, setKey] = useState(config?.key ?? '');
  const [email, setEmail] = useState(sessionUser().email ?? '');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState(sessionUser());
  const [info, setInfo] = useState<string | null>(null);
  const { pullPerf, authLost } = useSyncStatus();
  const relogin = user.online && authLost;

  // Logowanie może się skończyć poza tym ekranem (link z maila → ekran `auth-callback`).
  useEffect(() => onSessionChange(() => setUser(sessionUser())), []);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setInfo(null);
    try {
      const message = await work();
      if (message) setInfo(message);
    } catch (error) {
      setInfo(`Błąd: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      setUser(sessionUser());
    }
  };

  const saveServer = () => {
    if (url !== config?.url || key !== config?.key) saveServerConfig({ url, key });
  };
  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());

  // Logowanie: tryb bez konta i ponowne logowanie po utracie sesji (to samo konto — bez czyszczenia danych, `signedIn`).
  const loginForm = (
    <>
      <Field label="E-mail" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" />
      <Button
        disabled={busy || !validEmail}
        title={sentTo ? 'Wyślij link ponownie' : 'Wyślij link logowania'}
        onPress={() =>
          void run(async () => {
            saveServer();
            await sendMagicLink(email);
            setSentTo(email.trim());
            return `Wysłano link na ${email.trim()}. Otwórz go na tym telefonie albo wpisz kod z maila.`;
          })
        }
      />
      {sentTo ? (
        <>
          <Field label="Kod z maila" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" maxLength={10} />
          <Button
            disabled={busy || code.trim().length < 6}
            title="Zaloguj kodem"
            kind="secondary"
            onPress={() =>
              void run(async () => {
                await verifyEmailCode(sentTo, code);
                setCode('');
                router.replace('/');
                return 'Zalogowano.';
              })
            }
          />
        </>
      ) : null}
      <Button
        disabled={busy}
        title="Zaloguj przez Google"
        kind="secondary"
        onPress={() =>
          void run(async () => {
            saveServer();
            const signed = await signInWithGoogle();
            if (!signed) return 'Logowanie Google przerwane.';
            router.replace('/');
            return 'Zalogowano.';
          })
        }
      />
    </>
  );

  return (
    <Screen>
      <Section title={user.online ? `Zalogowano: ${user.email ?? '—'}` : 'Tryb offline (bez konta)'}>
        {relogin ? (
          <>
            <P tone="bad">
              Sesja wygasła — serwer nie przyjmuje zmian z telefonu. Zaloguj się ponownie kontem {user.email ?? 'tym samym co dotąd'}: dane i niewysłane zmiany na telefonie zostają. Inne konto
              zaczyna od czystych danych (zmiany stąd przepadną).
            </P>
            {loginForm}
          </>
        ) : null}
        {user.online ? (
          <>
            <SyncIndicator />
            {pullPerf ? <PullPerfInfo perf={pullPerf} /> : null}
            <Row>
              <Button disabled={busy} title="Przestrzenie i listy" kind="secondary" onPress={() => router.push('/workspaces')} />
              <Button
                disabled={busy}
                kind="danger"
                title="Wyloguj (czyści dane lokalne)"
                onPress={() =>
                  Alert.alert('Wylogować?', 'Dane na telefonie zostaną usunięte; niewysłane zmiany przepadną.', [
                    { text: 'Anuluj', style: 'cancel' },
                    { text: 'Wyloguj', style: 'destructive', onPress: () => void run(async () => (await signOut(), 'Wylogowano.')) },
                  ])
                }
              />
            </Row>
          </>
        ) : (
          <>
            <P muted>
              Bez konta zapisy zostają w lokalnej bazie i outboxie. Logowanie zaczyna od czystych danych lokalnych (zmiany z trybu offline nie trafią na konto).
            </P>
            {loginForm}
          </>
        )}
        {info ? <P tone={info.startsWith('Błąd') ? 'bad' : 'ok'}>{info}</P> : null}
      </Section>

      <BackgroundStatus />

      <ErrorsSection />

      <Section title="Serwer Supabase">
        <P muted>
          Lokalny Supabase przez USB: `adb reverse tcp:54521 tcp:54521` (i 54524 dla Inbucket) — wtedy adres http://127.0.0.1:54521 działa na telefonie, także w linku z maila. W
          sieci Wi-Fi: http://IP-komputera:54521 (link z maila wskazuje wtedy 127.0.0.1 — użyj kodu). Klucz: PUBLISHABLE_KEY z `npm run supabase -- status`.
        </P>
        <Field label="Adres" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!user.online} />
        <Field label="Klucz publiczny (anon / publishable)" value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} editable={!user.online} />
        {user.online ? (
          <P muted>Adres zmienisz po wylogowaniu.</P>
        ) : (
          <Button
            kind="secondary"
            title="Zapisz adres"
            onPress={() => {
              saveServerConfig({ url, key });
              Alert.alert('Zapisano', 'Nowy adres działa od następnego logowania.');
            }}
          />
        )}
      </Section>
    </Screen>
  );
}
