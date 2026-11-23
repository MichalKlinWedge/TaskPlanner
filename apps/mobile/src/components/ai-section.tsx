/**
 * Ustawienia → „Asystent AI” (v1.x): własne konto AI użytkownika (BYOK, na start Gemini) — jak karta na webie.
 * Wklejony klucz idzie do Edge Function `ai` (Vault) i nie wraca; konto, lista modeli i stan przychodzą
 * synchronizacją. „Sprawdź” = lista modeli na kluczu, model wybiera się z niej. Zmiany tylko online.
 */
import { AI_ACCOUNT_STATUS, AI_BILLING_STATEMENT, AI_INTRO, AI_PROVIDER, AI_PROVIDERS, aiDataNote, type AiAccount, type AiProvider } from '@taskplanner/core';
import { useState } from 'react';
import { Alert, Linking, Pressable, Switch, Text, View } from 'react-native';

import { createAiAccount, deleteAiAccount, testAiAccount, updateAiAccount, useAiAccount } from '@/lib/ai';
import { sessionUser } from '@/lib/config';

import { Button, Chip, Field, P, Row, Section, usePalette } from './ui';

type Message = { tone?: 'ok' | 'bad'; text: string } | null;

export function AiSection() {
  const account = useAiAccount();
  const online = sessionUser().online;
  const [editingKey, setEditingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const run = (work: () => Promise<Message>) => {
    setBusy(true);
    setMessage(null);
    work()
      .then(setMessage)
      .catch((e: unknown) => setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false));
  };

  const check = (accountId: string): Promise<Message> =>
    testAiAccount(accountId).then((r) =>
      r.ok ? { tone: 'ok', text: `Klucz działa — dostępnych modeli: ${r.models.length}. Wybrany: ${r.model ?? '—'}.` } : { tone: 'bad', text: r.error },
    );

  const saveKey = (provider: AiProvider, key: string) =>
    run(async () => {
      const id = account ? (await updateAiAccount(account.id, { key, billingConfirmed: true }), account.id) : (await createAiAccount({ provider, key, billingConfirmed: true })).accountId;
      setEditingKey(false);
      return check(id);
    });

  return (
    <Section title="Asystent AI">
      <P muted>{AI_INTRO}</P>
      {account ? <AccountSummary account={account} busy={busy || !online} onModel={(model) => run(async () => (await updateAiAccount(account.id, { model }), null))} /> : null}
      {!online ? <P muted>Konto AI podpina się po zalogowaniu, z siecią.</P> : !account || editingKey ? (
        <KeyForm key={account?.id ?? 'nowe'} provider={account?.provider ?? 'gemini'} replacing={!!account} busy={busy} onSubmit={saveKey} onCancel={account ? () => setEditingKey(false) : undefined} />
      ) : (
        <Row>
          <Button title={busy ? 'Sprawdzanie…' : 'Sprawdź'} disabled={busy} onPress={() => run(() => check(account.id))} />
          <Button kind="secondary" title="Zmień klucz" disabled={busy} onPress={() => setEditingKey(true)} />
          <Button
            kind="secondary"
            title="Odłącz"
            disabled={busy}
            onPress={() =>
              Alert.alert(`Odłączyć konto ${AI_PROVIDER[account.provider].label}?`, 'Klucz zostanie usunięty z serwera, a funkcje ✨ znikną.', [
                { text: 'Anuluj', style: 'cancel' },
                { text: 'Odłącz', style: 'destructive', onPress: () => run(async () => (await deleteAiAccount(account.id), { text: 'Konto AI odłączone, klucz usunięty z serwera.' })) },
              ])
            }
          />
        </Row>
      )}
      {message ? <P tone={message.tone}>{message.text}</P> : null}
      <P muted>{aiDataNote(account?.provider ?? 'gemini')}</P>
    </Section>
  );
}

function AccountSummary({ account, busy, onModel }: { account: AiAccount; busy: boolean; onModel: (model: string) => void }) {
  const status = AI_ACCOUNT_STATUS[account.status];
  return (
    <View style={{ gap: 6 }}>
      <P>
        {AI_PROVIDER[account.provider].label}
        {account.keyHint ? ` · klucz ${account.keyHint}` : ''}
      </P>
      <P tone={status.tone === 'ok' ? 'ok' : status.tone === 'error' ? 'bad' : undefined} muted={status.tone === 'muted'}>
        {`Stan: ${status.label}`}
      </P>
      {account.lastError ? <P tone="bad">{`Ostatni błąd: ${account.lastError}`}</P> : null}
      {account.models.length ? (
        <>
          <P muted>Model (lista od dostawcy dla Twojego klucza; domyślnie najtańszy Flash-Lite):</P>
          <Row>
            {account.models.map((m) => (
              <Chip key={m.id} label={m.label || m.id} selected={m.id === account.model} disabled={busy} onPress={() => m.id !== account.model && onModel(m.id)} />
            ))}
          </Row>
        </>
      ) : (
        <P muted>Kliknij „Sprawdź”, żeby pobrać listę modeli dla tego klucza.</P>
      )}
    </View>
  );
}

function KeyForm({
  provider: initial,
  replacing,
  busy,
  onSubmit,
  onCancel,
}: {
  provider: AiProvider;
  replacing: boolean;
  busy: boolean;
  onSubmit: (provider: AiProvider, key: string) => void;
  onCancel?: () => void;
}) {
  const p = usePalette();
  const [provider, setProvider] = useState<AiProvider>(initial);
  const [key, setKey] = useState('');
  const [billing, setBilling] = useState(false);
  const info = AI_PROVIDER[provider];
  const ready = key.trim().length >= 20 && billing && !busy;
  return (
    <View style={{ gap: 8 }}>
      <Row>
        {AI_PROVIDERS.map((id) => (
          <Chip key={id} label={AI_PROVIDER[id].label} selected={id === provider} disabled={replacing || busy} onPress={() => setProvider(id)} />
        ))}
      </Row>
      <Field
        label={replacing ? 'Nowy klucz API' : 'Klucz API'}
        value={key}
        onChangeText={setKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        placeholder="Wklej klucz z AI Studio"
        editable={!busy}
      />
      <P muted>{info.keyHelp}</P>
      <P tone="ok" onPress={() => void Linking.openURL(info.keyUrl).catch(() => undefined)}>
        Utwórz klucz w Google AI Studio ↗
      </P>
      <Pressable accessibilityRole="switch" accessibilityState={{ checked: billing }} onPress={() => setBilling(!billing)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Switch value={billing} onValueChange={setBilling} disabled={busy} />
        <Text style={{ color: p.fg, flex: 1 }}>{AI_BILLING_STATEMENT}</Text>
      </Pressable>
      <Row>
        <Button title={busy ? 'Sprawdzanie…' : 'Sprawdź'} disabled={!ready} onPress={() => onSubmit(provider, key.trim())} />
        {onCancel ? <Button kind="secondary" title="Anuluj" disabled={busy} onPress={onCancel} /> : null}
      </Row>
    </View>
  );
}
