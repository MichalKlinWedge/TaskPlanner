/**
 * Ustawienia → „Profil” (M1) — te same pola `ProfileSettings` co formularz na webie; każda zmiana zapisuje
 * się od razu (`updateSettings`). Skupienie ma własną sekcję i czasy na ekranie timera.
 */
import { formatMinutes, ProfileSettings, THEME, TimeZone, WEEKDAY, type IsoWeekday, type LocalTime } from '@taskplanner/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { deviceTimeZone, loadProfile, updateSettings } from '@/lib/profile';
import { mutate } from '@/lib/sync';

import { pickOption, pickTime } from './pickers';
import { Button, Chip, Field, P, Row, Section, usePalette } from './ui';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly IsoWeekday[];
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const THEMES = Object.keys(THEME) as ProfileSettings['theme'][];

/** Strefy IANA, gdy silnik JS je zna (inaczej wpisana nazwa jest sprawdzana przez `Intl`). */
function knownZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** Wiersz „etykieta — wartość” z arkuszem wyboru; `children` po prawej zamiast wartości (przełącznik). */
function Line({ label, value, onPress, children }: { label: string; value?: string; onPress?: () => void; children?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={styles.line}>
      <Text style={{ color: p.fg, fontSize: 15, flex: 1 }}>{label}</Text>
      {value !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value}`}
          onPress={onPress}
          style={({ pressed }) => [styles.value, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
        >
          <Text style={{ color: p.accent, fontSize: 15 }}>{value}</Text>
        </Pressable>
      ) : null}
      {children}
    </View>
  );
}

export function ProfileSection() {
  const { data } = useView();
  const profile = useLocalQuery(['profiles'], (engine) => loadProfile(engine));
  // Konto bez profilu (tryb offline, przed pierwszą synchronizacją) nie ma czego zapisać.
  if (!profile || profile.id !== data.userId) return null;
  return <ProfileFields key={profile.id} id={profile.id} name={profile.display_name ?? ''} settings={profile.settings} />;
}

function ProfileFields({ id, name, settings }: { id: string; name: string; settings: ProfileSettings }) {
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const save = (patch: (s: ProfileSettings) => Partial<ProfileSettings>) => {
    setError(null);
    void updateSettings(patch).catch(fail);
  };
  const time = (title: string, value: LocalTime, set: (time: LocalTime) => void) => void pickTime({ title, value }).then((t) => t && set(t));

  const { workHours, dailyReview, weeklyReview, defaultDurationMin, firstDayOfWeek } = settings;
  const ordered = [...DAYS.slice(firstDayOfWeek - 1), ...DAYS.slice(0, firstDayOfWeek - 1)];
  const weekday = (title: string, days: readonly IsoWeekday[], value: number, set: (day: IsoWeekday) => void) =>
    void pickOption<IsoWeekday>(
      title,
      days.map((d) => ({ label: WEEKDAY[d].label, value: d, selected: d === value })),
    ).then((d) => d && set(d));
  const toggleDay = (day: IsoWeekday) => {
    if (workHours.days.length === 1 && workHours.days[0] === day) return setError('Zostaw co najmniej jeden dzień pracy.');
    save((s) => ({ workHours: { ...s.workHours, days: s.workHours.days.includes(day) ? s.workHours.days.filter((d) => d !== day) : [...s.workHours.days, day].sort((a, b) => a - b) } }));
  };

  return (
    <Section title="Profil">
      <NameField id={id} name={name} onError={fail} />
      <TimeZoneField value={settings.timeZone} onChange={(timeZone) => save(() => ({ timeZone }))} />
      <Line
        label="Pierwszy dzień tygodnia"
        value={WEEKDAY[firstDayOfWeek as IsoWeekday].label}
        onPress={() => weekday('Pierwszy dzień tygodnia', [1, 7], firstDayOfWeek, (d) => save(() => ({ firstDayOfWeek: d })))}
      />

      <P muted>Dni i godziny pracy</P>
      <Row>
        {ordered.map((d) => (
          <Chip key={d} label={WEEKDAY[d].short} selected={workHours.days.includes(d)} onPress={() => toggleDay(d)} />
        ))}
      </Row>
      <Line label="Początek pracy" value={workHours.start} onPress={() => time('Początek pracy', workHours.start, (start) => save((s) => ({ workHours: { ...s.workHours, start } })))} />
      <Line label="Koniec pracy" value={workHours.end} onPress={() => time('Koniec pracy', workHours.end, (end) => save((s) => ({ workHours: { ...s.workHours, end } })))} />

      <Line
        label="Przypomnienie zadania bez godziny"
        value={settings.defaultReminderTime}
        onPress={() => time('Przypomnienie zadania bez godziny', settings.defaultReminderTime, (defaultReminderTime) => save(() => ({ defaultReminderTime })))}
      />
      <Line
        label="Domyślny czas bloku"
        value={formatMinutes(defaultDurationMin)}
        onPress={() =>
          void pickOption<number>(
            'Domyślny czas bloku',
            [...new Set([...DURATIONS, defaultDurationMin])].sort((a, b) => a - b).map((m) => ({ label: formatMinutes(m), value: m, selected: m === defaultDurationMin })),
          ).then((m) => m && save(() => ({ defaultDurationMin: m })))
        }
      />

      <P muted>Przeglądy — o tej porze w „Dziś” (i na komputerze) pojawia się odnośnik do przeglądu.</P>
      <Line label="Przegląd dnia" {...(dailyReview.enabled && { value: dailyReview.time, onPress: () => time('Godzina przeglądu dnia', dailyReview.time, (t) => save((s) => ({ dailyReview: { ...s.dailyReview, time: t } }))) })}>
        <Switch accessibilityLabel="Przegląd dnia" value={dailyReview.enabled} onValueChange={(enabled) => save((s) => ({ dailyReview: { ...s.dailyReview, enabled } }))} />
      </Line>
      <Line
        label="Przegląd tygodnia"
        {...(weeklyReview.enabled && { value: weeklyReview.time, onPress: () => time('Godzina przeglądu tygodnia', weeklyReview.time, (t) => save((s) => ({ weeklyReview: { ...s.weeklyReview, time: t } }))) })}
      >
        <Switch accessibilityLabel="Przegląd tygodnia" value={weeklyReview.enabled} onValueChange={(enabled) => save((s) => ({ weeklyReview: { ...s.weeklyReview, enabled } }))} />
      </Line>
      {weeklyReview.enabled ? (
        <Line
          label="Dzień przeglądu tygodnia"
          value={WEEKDAY[weeklyReview.weekday as IsoWeekday].label}
          onPress={() => weekday('Dzień przeglądu tygodnia', ordered, weeklyReview.weekday, (d) => save((s) => ({ weeklyReview: { ...s.weeklyReview, weekday: d } })))}
        />
      ) : null}

      <P muted>Motyw (wspólny z komputerem)</P>
      <Row>
        {THEMES.map((theme) => (
          <Chip key={theme} label={THEME[theme]} selected={settings.theme === theme} onPress={() => save(() => ({ theme }))} />
        ))}
      </Row>
      {error ? <P tone="bad">{error}</P> : null}
    </Section>
  );
}

/** Imię: zapis po opuszczeniu pola i przy wyjściu z ekranu. */
function NameField({ id, name, onError }: { id: string; name: string; onError: (e: unknown) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const flush = useRef<() => void>(() => undefined);
  useEffect(() => {
    flush.current = () => {
      if (draft === null || draft.trim() === name) return;
      void mutate('profiles', id, { display_name: draft.trim() || null }).catch(onError);
    };
  });
  useEffect(() => () => flush.current(), []);
  return (
    <Field
      label="Jak się do Ciebie zwracać"
      value={draft ?? name}
      onChangeText={setDraft}
      onBlur={() => {
        flush.current();
        setDraft(null);
      }}
      autoComplete="given-name"
      maxLength={100}
    />
  );
}

/** Strefa: „strefa urządzenia” albo szukanie po nazwie (bez listy w silniku JS — dokładna nazwa IANA). */
function TimeZoneField({ value, onChange }: { value: string | undefined; onChange: (zone: string | undefined) => void }) {
  const device = deviceTimeZone();
  const [query, setQuery] = useState<string | null>(null);
  const deviceLabel = `strefa urządzenia${device ? ` (${device})` : ''}`;
  if (query === null) return <Line label="Strefa czasowa" value={value ?? deviceLabel} onPress={() => setQuery('')} />;
  const needle = query.trim().toLowerCase().replace(/\s+/g, '_');
  const matches = needle.length < 2 ? [] : knownZones().filter((z) => z.toLowerCase().includes(needle)).slice(0, 8);
  const exact = query.trim();
  if (needle.length >= 2 && !matches.length && TimeZone.safeParse(exact).success) matches.push(exact);
  const choose = (zone: string | undefined) => {
    setQuery(null);
    onChange(zone);
  };
  return (
    <View style={{ gap: 8 }}>
      <Field label="Strefa czasowa" value={query} onChangeText={setQuery} placeholder="np. Warsaw albo Europe/Warsaw" autoCapitalize="none" autoCorrect={false} autoFocus />
      <Row>
        <Chip label={deviceLabel} selected={!value} onPress={() => choose(undefined)} />
        {matches.map((z) => (
          <Chip key={z} label={z} selected={z === value} onPress={() => choose(z)} />
        ))}
      </Row>
      {needle.length >= 2 && !matches.length ? <P muted>Nie ma takiej strefy — wpisz nazwę jak „Europe/Warsaw”.</P> : null}
      <Button kind="secondary" title="Anuluj" onPress={() => setQuery(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  value: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, flexShrink: 1 },
});
