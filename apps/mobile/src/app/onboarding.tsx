/**
 * Onboarding po pierwszym zalogowaniu (M1): imię, ustawienia profilu i przestrzenie „Osobiste”
 * i „Praca” z Inboxem. Zapis przez `onboardingOps` z core — ten sam co na webie; deterministyczne
 * id przestrzeni sprawiają, że onboarding na dwóch urządzeniach nie dubluje danych. Strefa i godziny
 * z tych samych wybieraków co w „Profilu”; „Pomiń” zapisuje ustawienia domyślne. Po zapisie — ekran Start
 * z polem szybkiego dodawania (pierwsze zadanie).
 */
import {
  DEFAULT_WORKSPACES,
  formatMinutes,
  ProfileSettings,
  WEEKDAY,
  type DefaultWorkspace,
  type IsoWeekday,
  type LocalTime,
} from '@taskplanner/core';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { BackHandler } from 'react-native';

import { pickTime } from '@/components/pickers';
import { Line, TimeZoneField } from '@/components/profile-section';
import { Button, Chip, ColorDot, Field, P, Row, Screen, Section } from '@/components/ui';
import { useLocalQuery } from '@/lib/local-query';
import { completeOnboarding, loadProfile, type Profile } from '@/lib/profile';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly IsoWeekday[];
const DURATIONS = [15, 30, 45, 60, 90, 120];

/** Pole ustawień → nazwa w komunikacie błędu (inaczej „Godzina w formacie GG:MM” nie mówi, o które pole chodzi). */
const FIELD_NAME: Record<string, string> = {
  timeZone: 'Strefa czasowa',
  workHours: 'Godziny pracy',
  defaultReminderTime: 'Przypomnienie zadania bez godziny',
  defaultDurationMin: 'Czas trwania bloku',
};

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
  const [timeZone, setTimeZone] = useState<string | undefined>(initial.timeZone);
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

  const time = (title: string, value: string, set: (t: LocalTime) => void) => void pickTime({ title, value: value as LocalTime }).then((t) => t && set(t));

  const finish = async (settings: ProfileSettings, chosen: DefaultWorkspace[], displayName: string) => {
    setBusy(true);
    try {
      await completeOnboarding({ displayName, settings, workspaces: chosen });
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    const settings = {
      ...initial,
      timeZone: timeZone?.trim() || undefined,
      firstDayOfWeek: firstDay,
      workHours: { days: [...workDays].sort((a, b) => a - b), start: workStart.trim(), end: workEnd.trim() },
      defaultReminderTime: reminder.trim(),
      defaultDurationMin: Number(duration),
    };
    const parsed = ProfileSettings.safeParse(settings);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = FIELD_NAME[String(issue?.path[0] ?? '')];
      return setError(`${field ? `${field}: ` : ''}${issue?.message ?? 'Niepoprawne ustawienia.'}`);
    }
    if (!workspaces.length) return setError('Wybierz co najmniej jedną przestrzeń.');
    await finish(parsed.data, workspaces, name);
  };

  return (
    <Screen>
      <P muted>Kilka ustawień na start — wszystkie zmienisz później w „Ustawieniach”.</P>
      <Button kind="secondary" title="Pomiń — użyj domyślnych" disabled={busy} onPress={() => void finish(initial, ['personal', 'work'], name)} />
      <Section title="Ty">
        <Field label="Imię" value={name} onChangeText={setName} autoComplete="given-name" maxLength={100} />
        <TimeZoneField value={timeZone} onChange={setTimeZone} />
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
        <Line label="Praca od" value={workStart} onPress={() => time('Praca od', workStart, setWorkStart)} />
        <Line label="Praca do" value={workEnd} onPress={() => time('Praca do', workEnd, setWorkEnd)} />
      </Section>

      <Section title="Domyślne">
        <Line label="Przypomnienie zadania bez godziny" value={reminder} onPress={() => time('Przypomnienie zadania bez godziny', reminder, setReminder)} />
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
