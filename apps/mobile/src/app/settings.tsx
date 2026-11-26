import { ACCOUNT_DELETE_NOTE, LOGIN_INVITE_NOTE } from '@taskplanner/core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Linking, Switch, Text, View } from 'react-native';

import { AiSection } from '@/components/ai-section';
import { UpdateSection } from '@/components/app-update';
import { BackgroundStatus } from '@/components/background-status';
import { BackupSection } from '@/components/backup-section';
import { CalendarsSection } from '@/components/calendars-section';
import { ErrorsSection } from '@/components/errors-section';
import { InvitesSection } from '@/components/invites-section';
import { NotificationsSection } from '@/components/notifications';
import { PluginsSection } from '@/components/plugins-section';
import { ProfileSection } from '@/components/profile-section';
import { SyncIndicator } from '@/components/sync-indicator';
import { Button, CollapsibleSections, Field, P, Row, Screen, Section, usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { deleteAccount, sendMagicLink, signInWithGoogle, signOut, verifyEmailCode } from '@/lib/auth';
import { CLOUD_SERVER, PRIVACY_URL, saveServerConfig, serverConfig, sessionUser } from '@/lib/config';
import { useSyncStatus } from '@/lib/local-query';
import { mutate, onSessionChange, unsentChanges, type PullPerf } from '@/lib/sync';

const seconds = (ms: number) => `${(ms / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;

/** Przełącznik trybu skupienia (`settings.focus.enabled`); wyłączenie zatrzymuje trwający timer. */
function FocusSection() {
  const p = usePalette();
  const { data } = useView();
  const [error, setError] = useState<string | null>(null);
  if (!data.userId) return null;
  const on = data.settings.focus.enabled;
  return (
    <Section title="Tryb skupienia">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: p.muted, flex: 1 }}>Pomodoro i stoper: „▶ Skup się” w zadaniu, wskaźnik timera w nagłówku. Wyłączenie zatrzymuje trwający timer (też na komputerze).</Text>
        <Switch
          accessibilityLabel="Tryb skupienia"
          value={on}
          onValueChange={(enabled) => {
            setError(null);
            void mutate('profiles', data.userId, { settings: { ...data.settings, focus: { ...data.settings.focus, enabled } } }).catch((e: unknown) => setError(String(e)));
          }}
        />
      </View>
      {error ? <P tone="bad">{error}</P> : null}
    </Section>
  );
}

/** „Usuń konto”: konto i dane na serwerze (`account-delete`), potem wylogowanie z czyszczeniem telefonu. */
function DeleteAccountSection({ email }: { email: string | null }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = !!email && typed.trim().toLowerCase() === email.toLowerCase();
  const remove = () => {
    setBusy(true);
    setError(null);
    deleteAccount(typed)
      .then(() => router.replace('/'))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Section title="Usuń konto">
      <P muted>{ACCOUNT_DELETE_NOTE}</P>
      <Field label="Adres e-mail konta" value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
      <Button
        kind="danger"
        title={busy ? 'Usuwanie…' : 'Usuń konto'}
        disabled={busy || !matches}
        onPress={() =>
          Alert.alert('Usunąć konto?', 'Konto i wszystkie dane na serwerze znikną. Tego nie da się cofnąć.', [
            { text: 'Anuluj', style: 'cancel' },
            { text: 'Usuń', style: 'destructive', onPress: remove },
          ])
        }
      />
      {error ? <P tone="bad">{error}</P> : null}
    </Section>
  );
}

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
  const palette = usePalette();
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
  // Najpierw wysyłka zaległych zmian: lokalne dane znikają, więc o tym, czego serwer nie ma, trzeba wiedzieć przed potwierdzeniem.
  const confirmSignOut = () =>
    run(async () => {
      const left = await unsentChanges();
      const text = left
        ? `Niewysłane zmiany: ${left}. Serwer jeszcze ich nie ma (brak sieci albo sesji) — po wylogowaniu przepadną. Lepiej wyloguj się, gdy telefon się zsynchronizuje.`
        : 'Wszystkie zmiany są na serwerze. Dane na telefonie zostaną usunięte i wrócą po ponownym zalogowaniu.';
      Alert.alert(left ? 'Wylogować mimo niewysłanych zmian?' : 'Wylogować?', text, [
        { text: 'Anuluj', style: 'cancel' },
        { text: left ? 'Wyloguj mimo to' : 'Wyloguj', style: 'destructive', onPress: () => void run(async () => (await signOut(), 'Wylogowano.')) },
      ]);
    });
  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());

  // Logowanie: tryb bez konta i ponowne logowanie po utracie sesji (to samo konto — bez czyszczenia danych, `signedIn`).
  const loginForm = (
    <>
      <P muted>{LOGIN_INVITE_NOTE}</P>
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
      <CollapsibleSections value>
      {/* Logowanie (bez konta / po wygaśnięciu sesji) zawsze widoczne. */}
      <Section id="account" title={user.online ? `Zalogowano: ${user.email ?? '—'}` : 'Tryb offline (bez konta)'} alwaysOpen={!user.online || relogin}>
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
                title={busy ? 'Chwila…' : 'Wyloguj (czyści dane lokalne)'}
                onPress={() => void confirmSignOut()}
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
        <Text accessibilityRole="link" style={{ color: palette.accent, textDecorationLine: 'underline', fontSize: 13 }} onPress={() => void Linking.openURL(PRIVACY_URL)}>
          Polityka prywatności
        </Text>
      </Section>

      <UpdateSection />

      <ProfileSection />

      <FocusSection />

      <NotificationsSection />

      <AiSection />

      {user.online && !relogin ? <PluginsSection /> : null}

      {user.online && !relogin ? <CalendarsSection /> : null}

      <BackupSection />

      <BackgroundStatus />

      <ErrorsSection />

      {user.online && !relogin ? <InvitesSection /> : null}

      {user.online && !relogin ? <DeleteAccountSection email={user.email} /> : null}

      <Section title="Serwer Supabase">
        <P muted>
          Domyślnie serwer w chmurze ({CLOUD_SERVER.url}) — nic nie trzeba wpisywać. Lokalny Supabase przez USB: `adb reverse tcp:54521 tcp:54521` (i 54524 dla Inbucket) — wtedy adres http://127.0.0.1:54521 działa na telefonie, także w linku z maila. W
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
        {!user.online && (url !== CLOUD_SERVER.url || key !== CLOUD_SERVER.key) ? (
          <Button
            kind="secondary"
            title="Serwer w chmurze"
            onPress={() => {
              setUrl(CLOUD_SERVER.url);
              setKey(CLOUD_SERVER.key);
              saveServerConfig(CLOUD_SERVER);
              Alert.alert('Zapisano', 'Adres serwera w chmurze działa od następnego logowania.');
            }}
          />
        ) : null}
      </Section>
      </CollapsibleSections>
    </Screen>
  );
}
