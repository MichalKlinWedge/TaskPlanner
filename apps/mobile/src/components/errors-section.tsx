/**
 * „Błędy aplikacji” w „Konto i synchronizacja” (Etap 13, D20): niewysłane wpisy z telefonu, ostatnie
 * 20 wpisów konta z serwera (`client_errors` — web i telefon, wymaga sieci; dotknięcie rozwija adres / ekran
 * i stos, jak `<details>` na webie), błąd testowy i wysyłka.
 */
import { ERROR_KIND } from '@taskplanner/core';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { devToolsEnabled, sessionUser } from '@/lib/config';
import { APP_VERSION, flushErrors, onErrorQueue, queuedErrors, reportError } from '@/lib/error-log';
import { supabaseClient } from '@/lib/sync';

import { Button, P, Row, Section, usePalette } from './ui';

interface ErrorRow {
  id: number;
  kind: string;
  platform: string;
  message: string;
  stack: string | null;
  url: string | null;
  app_version: string | null;
  count: number;
  last_at: string;
}

/** Ile ostatnich wpisów (jak na webie). */
const RECENT_ERRORS = 20;
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
    const { data, error } = await supabaseClient().from('client_errors').select('id, kind, platform, message, stack, url, app_version, count, last_at').order('last_at', { ascending: false }).limit(RECENT_ERRORS);
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
        {devToolsEnabled() ? <Button kind="secondary" disabled={busy} title="Zapisz błąd testowy" onPress={() => void send(true)} /> : null}
        {online ? <Button kind="secondary" disabled={busy || !queued} title="Wyślij teraz" onPress={() => void send(false)} /> : null}
      </Row>
      {problem ? <P tone="bad">{problem}</P> : null}
      {rows && !rows.length ? <P muted>Brak błędów.</P> : null}
      {rows?.map((r) => <ErrorItem key={r.id} row={r} />)}
    </Section>
  );
}

/** Wpis dziennika; dotknięcie rozwija adres (web) / ekran (telefon) i stos. */
function ErrorItem({ row: r }: { row: ErrorRow }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const details = !!(r.url || r.stack);
  const meta = [ERROR_KIND[r.kind as keyof typeof ERROR_KIND] ?? r.kind, PLATFORM[r.platform] ?? r.platform, when(r.last_at), r.count > 1 ? `${r.count}×` : '', r.app_version ?? ''].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityRole={details ? 'button' : undefined}
      accessibilityState={details ? { expanded: open } : undefined}
      disabled={!details}
      onPress={() => setOpen(!open)}
      style={{ gap: 2 }}
    >
      <Text style={{ color: p.fg }}>
        {details ? <Text style={{ color: p.muted }}>{open ? '▾ ' : '▸ '}</Text> : null}
        {r.message}
      </Text>
      <P muted>{meta}</P>
      {open && r.url ? <P muted>{`${r.platform === 'android' ? 'Ekran' : 'Adres'}: ${r.url}`}</P> : null}
      {open && r.stack ? (
        <View style={{ backgroundColor: p.selected, borderRadius: 6, padding: 6 }}>
          <Text selectable style={{ color: p.fg, fontSize: 11, fontFamily: 'monospace' }}>
            {r.stack}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
