/**
 * „Błędy aplikacji” w „Konto i synchronizacja” (Etap 13, D20): niewysłane wpisy z telefonu, ostatnie
 * wpisy konta z serwera (`client_errors` — web i telefon, wymaga sieci), błąd testowy i wysyłka.
 */
import { ERROR_KIND } from '@taskplanner/core';
import { useCallback, useEffect, useState } from 'react';

import { sessionUser } from '@/lib/config';
import { APP_VERSION, flushErrors, onErrorQueue, queuedErrors, reportError } from '@/lib/error-log';
import { supabaseClient } from '@/lib/sync';

import { Button, P, Row, Section } from './ui';

interface ErrorRow {
  id: number;
  kind: string;
  platform: string;
  message: string;
  app_version: string | null;
  count: number;
  last_at: string;
}

const PLATFORM: Record<string, string> = { web: 'przeglądarka', android: 'telefon' };
const when = (iso: string) => new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ErrorsSection() {
  const [queued, setQueued] = useState(queuedErrors);
  const [rows, setRows] = useState<ErrorRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = sessionUser().online;

  const load = useCallback(async () => {
    if (!sessionUser().online) return;
    const { data, error } = await supabaseClient().from('client_errors').select('id, kind, platform, message, app_version, count, last_at').order('last_at', { ascending: false }).limit(10);
    if (error) setProblem(`Nie udało się wczytać dziennika: ${error.message}`);
    else {
      setProblem(null);
      setRows(data as ErrorRow[]);
    }
  }, []);

  useEffect(() => onErrorQueue(() => setQueued(queuedErrors())), []);
  useEffect(() => {
    // Wczytanie przy pokazaniu sekcji (zapytanie do serwera, nie do lokalnej bazy) — jak na webie.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => setProblem('Dziennik jest na serwerze — wczyta się po połączeniu.'));
  }, [load]);

  const send = async (test: boolean) => {
    setBusy(true);
    if (test) reportError('error', new Error('Błąd testowy z telefonu'), { test: true });
    await flushErrors();
    await load().catch(() => undefined);
    setBusy(false);
  };

  return (
    <Section title="Błędy aplikacji">
      <P muted>
        {`Wersja ${APP_VERSION}. Niewysłane z telefonu: ${queued}.`}
        {online ? '' : ' Wpisy pójdą na serwer po zalogowaniu.'}
      </P>
      <Row>
        <Button kind="secondary" disabled={busy} title="Zapisz błąd testowy" onPress={() => void send(true)} />
        {online ? <Button kind="secondary" disabled={busy || !queued} title="Wyślij teraz" onPress={() => void send(false)} /> : null}
      </Row>
      {problem ? <P tone="bad">{problem}</P> : null}
      {rows && !rows.length ? <P muted>Brak błędów.</P> : null}
      {rows?.map((r) => (
        <P key={r.id}>
          {`${r.message}\n`}
          <P muted>
            {[ERROR_KIND[r.kind as keyof typeof ERROR_KIND] ?? r.kind, PLATFORM[r.platform] ?? r.platform, when(r.last_at), r.count > 1 ? `${r.count}×` : '', r.app_version ?? ''].filter(Boolean).join(' · ')}
          </P>
        </P>
      ))}
    </Section>
  );
}
