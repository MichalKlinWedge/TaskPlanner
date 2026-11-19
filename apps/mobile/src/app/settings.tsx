import { useState } from 'react';
import { Alert } from 'react-native';

import { Button, Field, P, Row, Screen, Section } from '@/components/ui';
import { saveServerConfig, serverConfig, sessionUser } from '@/lib/config';
import { lastSyncAt, lastSyncError, signIn, signOut, syncNow } from '@/lib/sync';

export default function Settings() {
  const config = serverConfig();
  const [url, setUrl] = useState(config?.url ?? 'http://192.168.');
  const [key, setKey] = useState(config?.key ?? '');
  const [email, setEmail] = useState(sessionUser().email ?? 'dev@taskplanner.test');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState(sessionUser());
  const [info, setInfo] = useState<string | null>(null);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
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

  return (
    <Screen>
      <Section title="Serwer Supabase">
        <P muted>Lokalny Supabase z komputera: http://IP-komputera-w-LAN:54521 (telefon w tej samej sieci Wi-Fi, port otwarty w zaporze). Klucz: PUBLISHABLE_KEY z `npm run supabase -- status`.</P>
        <Field label="Adres" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <Field label="Klucz publiczny (anon / publishable)" value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} />
        <Button
          kind="secondary"
          title="Zapisz adres"
          onPress={() => {
            saveServerConfig({ url, key });
            Alert.alert('Zapisano', 'Nowy adres działa od następnej synchronizacji.');
          }}
        />
      </Section>

      <Section title={user.online ? `Zalogowano: ${user.email}` : 'Tryb offline (bez konta)'}>
        {user.online ? (
          <>
            <P muted>
              Ostatnia synchronizacja: {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString('pl-PL') : '—'}
              {lastSyncError ? ` · błąd: ${lastSyncError}` : ''}
            </P>
            <Row>
              <Button disabled={busy} title="Synchronizuj teraz" onPress={() => void run(async () => `Synchronizacja: ${await syncNow()} ms`)} />
              <Button disabled={busy} kind="danger" title="Wyloguj (czyści dane lokalne)" onPress={() => void run(async () => (await signOut(), 'Wylogowano.'))} />
            </Row>
          </>
        ) : (
          <>
            <P muted>Bez konta zapisy zostają w lokalnej bazie i outboxie. Logowanie innym kontem czyści dane lokalne (inny zakres).</P>
            <Field label="E-mail" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            <Field label="Hasło" value={password} onChangeText={setPassword} secureTextEntry />
            <Button
              disabled={busy || !password}
              title="Zaloguj"
              onPress={() =>
                void run(async () => {
                  saveServerConfig({ url, key });
                  await signIn(email.trim(), password);
                  setPassword('');
                  return `Zalogowano. Synchronizacja: ${await syncNow()} ms`;
                })
              }
            />
          </>
        )}
      </Section>
      {info ? <P tone={info.startsWith('Błąd') ? 'bad' : 'ok'}>{info}</P> : null}
    </Screen>
  );
}
