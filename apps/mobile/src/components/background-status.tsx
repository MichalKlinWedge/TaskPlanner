/**
 * Przypomnienia i praca w tle w „Konto i synchronizacja”: uprawnienia (powiadomienia, dokładne
 * alarmy — bez nich Android przesuwa przypomnienia o ~75 % czasu do terminu), ostatnie
 * przeplanowanie M8, rejestracja i ostatnie przebiegi synchronizacji w tle.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState, Switch, Text, View } from 'react-native';

import { backgroundRuns, backgroundState, runBackgroundSync, type BackgroundRun, type BackgroundState } from '@/lib/background-sync';
import { sessionUser } from '@/lib/config';
import { phoneRemindersOn, setPhoneReminders } from '@/lib/device';
import { useLocalQuery } from '@/lib/local-query';
import { permissionState, requestExactAlarms, requestNotificationPermission, type PermissionState } from '@/lib/reminders';
import { lastSchedule, scheduleReminders, type ScheduleResult } from '@/lib/scheduler';

import { Button, P, Row, Section, usePalette } from './ui';

const when = (ms: number) => new Date(ms).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

interface State {
  permissions: PermissionState;
  background: BackgroundState;
  schedule: ScheduleResult | null;
  runs: BackgroundRun[];
  /** Przebiegi w ostatnich 24 h. */
  lastDay: number;
}

async function readState(): Promise<State> {
  const [permissions, background] = await Promise.all([permissionState(), backgroundState()]);
  const runs = backgroundRuns();
  const now = Date.now();
  return { permissions, background, schedule: lastSchedule(), runs, lastDay: runs.filter((r) => now - r.at < 86_400_000).length };
}

export function BackgroundStatus() {
  const p = usePalette();
  const [state, setState] = useState<State | null>(null);
  const on = useLocalQuery(['devices'], phoneRemindersOn);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void readState().then(setState);
  }, []);

  useEffect(() => {
    refresh();
    // Powrót z ustawień systemu („Alarmy i przypomnienia”).
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void scheduleReminders().then(refresh);
    });
    return () => sub.remove();
  }, [refresh]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await scheduleReminders();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!state) return null;
  const { permissions, background, schedule, runs, lastDay } = state;
  const last = runs.at(-1);
  return (
    <Section title="Przypomnienia i praca w tle">
      <P tone={permissions.notifications ? 'ok' : 'bad'}>{permissions.notifications ? 'Powiadomienia: włączone' : 'Powiadomienia: wyłączone — przypomnienia nie przyjdą'}</P>
      <P tone={permissions.exactAlarms ? 'ok' : 'bad'}>
        {permissions.exactAlarms ? 'Dokładne alarmy: tak (±1 min)' : 'Dokładne alarmy: nie — Android opóźnia przypomnienia (włącz „Alarmy i przypomnienia”)'}
      </P>
      <Row>
        {!permissions.notifications ? <Button title="Włącz powiadomienia" disabled={busy} onPress={() => void act(requestNotificationPermission)} /> : null}
        {!permissions.exactAlarms ? <Button kind="secondary" title="Dokładne alarmy…" disabled={busy} onPress={() => void act(() => requestExactAlarms().catch(() => false))} /> : null}
      </Row>
      {sessionUser().online && on !== undefined ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: p.fg, fontSize: 15 }}>Przypomnienia na tym telefonie</Text>
            <Text style={{ color: p.muted, fontSize: 12 }}>Wyłącz, jeśli wystarczą powiadomienia przeglądarki (też dźwięk końca etapu skupienia). Pozostałe urządzenia: Ustawienia na komputerze.</Text>
          </View>
          <Switch
            accessibilityLabel="Przypomnienia na tym telefonie"
            value={on}
            disabled={busy}
            onValueChange={(enabled) =>
              void act(async () => {
                await setPhoneReminders(enabled);
                if (enabled && !permissions.notifications) await requestNotificationPermission();
              })
            }
          />
        </View>
      ) : null}
      {schedule ? (
        <P muted>
          {schedule.error
            ? `Planowanie (${when(schedule.at)}): błąd — ${schedule.error}`
            : `Zaplanowane: ${schedule.scheduled} (okno 7 dni, najwyżej 50)${schedule.next ? `, najbliższe ${when(schedule.next)}` : ''} · przeliczone ${when(schedule.at)}`}
        </P>
      ) : null}
      <P muted>
        {background.registered
          ? `Synchronizacja w tle: co ≥ 15 min, gdy jest sieć (decyduje Android)${last ? ` · ostatnio ${when(last.at)} ${last.ok ? `OK, ${last.ms} ms` : `błąd: ${last.error}`} · przebiegów w 24 h: ${lastDay}` : ' · jeszcze nie uruchomiona'}`
          : background.available
            ? 'Synchronizacja w tle: niezarejestrowana (zarejestruje się przy następnym starcie).'
            : 'Synchronizacja w tle: niedostępna na tym urządzeniu.'}
      </P>
      <Row>
        <Button kind="secondary" title="Przelicz teraz" disabled={busy} onPress={() => void act(runBackgroundSync)} />
      </Row>
    </Section>
  );
}
