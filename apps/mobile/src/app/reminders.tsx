import { formatMinutes } from '@taskplanner/core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, AppState, Share } from 'react-native';

import { Button, Field, P, Row, Screen, Section } from '@/components/ui';
import {
  actionLog,
  batches,
  batchStats,
  cancelBatch,
  collectDeliveries,
  permissionState,
  report,
  requestExactAlarms,
  requestNotificationPermission,
  resetMeasurements,
  scheduleBatch,
  scheduledCount,
  type Batch,
  type Delivery,
  type PermissionState,
} from '@/lib/reminders';
import { formatClock } from '@/lib/time';

export default function Reminders() {
  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [scheduled, setScheduled] = useState(0);
  const [list, setList] = useState<Batch[]>([]);
  const [count, setCount] = useState('50');
  const [hours, setHours] = useState('72');
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    await collectDeliveries();
    setPerm(await permissionState());
    setScheduled(await scheduledCount());
    setList(batches().reverse());
    setTick((t) => t + 1);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      // Powrót z ustawień systemu (dokładne alarmy) → stan uprawnień od nowa.
      const sub = AppState.addEventListener('change', (state) => state === 'active' && void load());
      return () => sub.remove();
    }, [load]),
  );

  const schedule = async (delivery: Delivery, n = Number(count), h = Number(hours)) => {
    if (!(n > 0 && n <= 200 && h > 0)) return Alert.alert('Seria', 'Liczba 1–200, godziny > 0.');
    setBusy(true);
    try {
      const batch = await scheduleBatch({ count: n, hours: h, delivery });
      Alert.alert('Seria zaplanowana', `${batch.count} przypomnień (${batch.delivery}), dokładne alarmy: ${batch.exactAllowed ? 'tak' : 'nie'}.`);
    } catch (error) {
      Alert.alert('Błąd', String(error));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const actions = actionLog().slice(-10).reverse();
  return (
    <Screen>
      <Section title="Uprawnienia">
        <P tone={perm?.notifications ? 'ok' : 'bad'}>Powiadomienia: {perm?.notifications ? 'tak' : 'nie'}</P>
        <P tone={perm?.exactAlarms ? 'ok' : 'bad'}>Dokładne alarmy (SCHEDULE_EXACT_ALARM): {perm?.exactAlarms ? 'tak' : 'nie'}</P>
        <P muted>Bez dokładnych alarmów Android używa setAndAllowWhileIdle (w Doze nawet kilkanaście minut opóźnienia); z nimi — setExactAndAllowWhileIdle albo setAlarmClock.</P>
        <Row>
          <Button kind="secondary" title="Poproś o powiadomienia" onPress={async () => (await requestNotificationPermission(), load())} />
          <Button kind="secondary" title="Ustawienia dokładnych alarmów" onPress={async () => (await requestExactAlarms().catch(() => false), load())} />
        </Row>
      </Section>

      <Section title="Nowa seria">
        <Row>
          <Field label="Liczba" value={count} onChangeText={setCount} keyboardType="number-pad" style={{ width: 90 }} />
          <Field label="W ciągu godzin" value={hours} onChangeText={setHours} keyboardType="number-pad" style={{ width: 90 }} />
        </Row>
        <P muted>Pierwsze za 2 min, kolejne równo rozłożone. Zaplanowanych w systemie: {scheduled}.</P>
        <Row>
          <Button disabled={busy} title="Zaplanuj (bestEffort)" onPress={() => void schedule('bestEffort')} />
          <Button disabled={busy} kind="secondary" title="Zaplanuj (alarmClock)" onPress={() => void schedule('alarmClock')} />
          <Button disabled={busy} kind="secondary" title="Szybki test: 3 w 4 min" onPress={() => void schedule('bestEffort', 3, 4 / 60)} />
        </Row>
      </Section>

      <Section title="Wyniki">
        <P muted>Nie usuwaj powiadomień z serii — wejście na ten ekran zbiera czas ich pokazania (Android trzyma maks. ok. 50 naraz, więc zbieraj co najmniej raz dziennie).</P>
        {list.length === 0 ? <P muted>Brak serii.</P> : null}
        {list.map((b) => {
          const s = batchStats(b);
          const pct = s.delivered ? Math.round((100 * s.within1) / s.delivered) : 0;
          return (
            <Section key={b.id} title={`Seria ${b.id} · ${b.delivery} · dokładne: ${b.exactAllowed ? 'tak' : 'nie'}`}>
              <P muted>
                {b.count} w {formatMinutes(Math.round(b.hours * 60))} od {formatClock(b.createdAt)}
              </P>
              <P tone={s.delivered < s.due ? 'bad' : undefined}>
                Pokazane {s.delivered}/{s.due} należnych · ±1 min: {s.within1} ({pct} %) · ≤10 min: {s.within10}
              </P>
              <P>
                Opóźnienie: mediana {s.medianS?.toFixed(0) ?? '–'} s · p95 {s.p95S?.toFixed(0) ?? '–'} s · maks. {s.maxS?.toFixed(0) ?? '–'} s
              </P>
              <Button kind="danger" title="Anuluj pozostałe" onPress={async () => (await cancelBatch(b), load())} />
            </Section>
          );
        })}
        <Row>
          <Button title="Udostępnij raport" onPress={() => void Share.share({ message: report() })} />
          <Button kind="secondary" title="Zbierz teraz" onPress={() => void load()} />
          <Button
            kind="danger"
            title="Wyczyść pomiary"
            onPress={() =>
              Alert.alert('Wyczyścić pomiary?', 'Serie, czasy pokazania i dziennik akcji (zaplanowane powiadomienia zostają).', [
                { text: 'Anuluj', style: 'cancel' },
                { text: 'Wyczyść', style: 'destructive', onPress: () => (resetMeasurements(), void load()) },
              ])
            }
          />
        </Row>
      </Section>

      <Section title="Akcje z powiadomień (ostatnie 10)">
        {actions.length === 0 ? <P muted>Brak — użyj „Ukończ” / „Odłóż 10 min” / „Jutro” na powiadomieniu przy zamkniętej aplikacji.</P> : null}
        {actions.map((a) => (
          <P key={`${a.at}-${a.notificationId}`} mono tone={a.ok ? undefined : 'bad'}>
            {formatClock(a.at)} {a.action} [{a.appState}] {a.ok ? 'OK' : a.error}
          </P>
        ))}
      </Section>
    </Screen>
  );
}
