/**
 * Onboarding po pierwszym zalogowaniu (M1): imię, ustawienia profilu i przestrzenie „Osobiste”
 * i „Praca” z Inboxem. Zapis przez `onboardingOps` z core — ten sam co na webie; deterministyczne
 * id przestrzeni sprawiają, że onboarding na dwóch urządzeniach nie dubluje danych.
 */
import {
  DEFAULT_WORKSPACES,
  formatMinutes,
  ProfileSettings,
  WEEKDAY,
  type DefaultWorkspace,
  type IsoWeekday,
} from '@taskplanner/core';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { BackHandler } from 'react-native';

import { Button, Chip, ColorDot, Field, P, Row, Screen, Section } from '@/components/ui';
import { useLocalQuery } from '@/lib/local-query';
import { completeOnboarding, deviceTimeZone, loadProfile, type Profile } from '@/lib/profile';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly IsoWeekday[];
const DURATIONS = [15, 30, 45, 60, 90, 120];

export default function Onboarding() {
  // Systemowe „wstecz” nie zamyka kreatora: bramka w `_layout` pokazuje go ponownie dopiero po
  // zmianie profilu, więc użytkownik zostawałby bez ustawień i przestrzeni. Przycisku w nagłówku
  // i gestu też nie ma (`headerBackVisible`, `gestureEnabled` w `_layout`).
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
      return () => sub.remove();
    }, []),
  );
  const profile = useLocalQuery(['profiles'], (engine) => loadProfile(engine));
  if (profile === undefined) return <Screen>{null}</Screen>;
  return <Form profile={profile} />;
}

function Form({ profile }: { profile: Profile | null }) {
  const initial = profile?.settings ?? ProfileSettings.parse({});
  const [name, setName] = useState(profile?.display_name ?? '');
  const [timeZone, setTimeZone] = useState(initial.timeZone ?? deviceTimeZone() ?? '');
  const [firstDay, setFirstDay] = useState<IsoWeekday>(initial.firstDayOfWeek as IsoWeekday);
  const [workDays, setWorkDays] = useState<IsoWeekday[]>(initial.workHours.days as IsoWeekday[]);
  const [workStart, setWorkStart] = useState(initial.workHours.start);
  const [workEnd, setWorkEnd] = useState(initial.workHours.end);
  const [reminder, setReminder] = useState(initial.defaultReminderTime);
  const [duration, setDuration] = useState(String(initial.defaultDurationMin));
  const [workspaces, setWorkspaces] = useState<DefaultWorkspace[]>(['personal', 'work']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Kolejność dni od wybranego pierwszego dnia tygodnia.
  const ordered = [...DAYS.slice(firstDay - 1), ...DAYS.slice(0, firstDay - 1)];
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const save = async () => {
    setError(null);
    const settings = {
      ...initial,
      timeZone: timeZone.trim() || undefined,
      firstDayOfWeek: firstDay,
      workHours: { days: [...workDays].sort((a, b) => a - b), start: workStart.trim(), end: workEnd.trim() },
      defaultReminderTime: reminder.trim(),
      defaultDurationMin: Number(duration),
    };
    const parsed = ProfileSettings.safeParse(settings);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Niepoprawne ustawienia.');
    if (!workspaces.length) return setError('Wybierz co najmniej jedną przestrzeń.');
    setBusy(true);
    try {
      await completeOnboarding({ displayName: name, settings: parsed.data, workspaces });
      router.replace('/workspaces');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <P muted>Kilka ustawień na start — wszystkie zmienisz później.</P>
      <Section title="Ty">
        <Field label="Imię" value={name} onChangeText={setName} autoComplete="given-name" maxLength={100} />
        <Field label="Strefa czasowa" value={timeZone} onChangeText={setTimeZone} autoCapitalize="none" autoCorrect={false} placeholder="Europe/Warsaw" />
      </Section>

      <Section title="Tydzień">
        <P muted>Pierwszy dzień tygodnia</P>
        <Row>
          {([1, 7] as const).map((d) => (
            <Chip key={d} label={WEEKDAY[d].label} selected={firstDay === d} onPress={() => setFirstDay(d)} />
          ))}
        </Row>
        <P muted>Dni pracy</P>
        <Row>
          {ordered.map((d) => (
            <Chip key={d} label={WEEKDAY[d].short} selected={workDays.includes(d)} onPress={() => setWorkDays(toggle(workDays, d))} />
          ))}
        </Row>
        <Row>
          <Field label="Praca od" value={workStart} onChangeText={setWorkStart} keyboardType="numbers-and-punctuation" maxLength={5} style={{ minWidth: 90 }} />
          <Field label="do" value={workEnd} onChangeText={setWorkEnd} keyboardType="numbers-and-punctuation" maxLength={5} style={{ minWidth: 90 }} />
        </Row>
      </Section>

      <Section title="Domyślne">
        <Field
          label="Przypomnienie zadania bez godziny"
          value={reminder}
          onChangeText={setReminder}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          style={{ maxWidth: 110 }}
        />
        <P muted>Czas trwania bloku w kalendarzu</P>
        <Row>
          {DURATIONS.map((m) => (
            <Chip key={m} label={formatMinutes(m)} selected={Number(duration) === m} onPress={() => setDuration(String(m))} />
          ))}
        </Row>
        <Field label="albo minut" value={duration} onChangeText={setDuration} keyboardType="number-pad" maxLength={3} style={{ maxWidth: 110 }} />
      </Section>

      <Section title="Przestrzenie">
        <P muted>Każda dostaje listę Inbox. Kolejne dodasz na ekranie przestrzeni.</P>
        {DEFAULT_WORKSPACES.map((w) => (
          <Row key={w.kind}>
            <ColorDot color={w.color} size={16} />
            <Chip label={w.name} selected={workspaces.includes(w.kind)} onPress={() => setWorkspaces(toggle(workspaces, w.kind))} />
          </Row>
        ))}
      </Section>

      {error ? <P tone="bad">{error}</P> : null}
      <Button title="Zaczynamy" disabled={busy} onPress={() => void save()} />
    </Screen>
  );
}
