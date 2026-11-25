/**
 * Formularz nawyku (Etap 8): nazwa, lista, jak często (codziennie / wybrane dni / co miesiąc w ustalony
 * dzień / N razy w tygodniu lub miesiącu), cel ilościowy, początek, koniec, pora i przypomnienia (przed porą / jednorazowe). Formularz ↔ pola —
 * `habitDraft` / `habitSaveOps` z core (jak `HabitEditor` na webie). `?id=` — edycja.
 */
import {
  addDays,
  dayChip,
  habitDraft,
  habitFields,
  habitMonthly,
  habitSaveOps,
  LIST_KIND,
  MAX_COUNT,
  pluralForm,
  previewDates,
  relativeDay,
  REMINDER_PRESETS,
  reminderOffset,
  shortDate,
  WEEKDAY,
  WEEKDAY_CODES,
  type HabitDraft,
  type HabitReminderDraft,
  type IsoWeekday,
  type LocalDate,
  type LocalTime,
  type MonthlyBy,
  type RecurrenceEnd,
  type WeekdayCode,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { pickDate, pickNumber, pickOption, pickTime } from '@/components/pickers';
import { Button, Chip, Field, usePalette } from '@/components/ui';
import { lastSortKey, listLabel, targetInbox, useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { permissionState, requestNotificationPermission } from '@/lib/reminders';

type ScheduleKind = HabitDraft['schedule']['kind'];
const MONTHLY_BY: [MonthlyBy, string][] = [
  ['day', 'dnia miesiąca'],
  ['weekday', 'w dzień tygodnia'],
  ['last_day', 'ostatniego dnia'],
  ['last_workday', 'ostatniego dnia roboczego'],
];
const NTH: [number, string][] = [[1, 'pierwszy'], [2, 'drugi'], [3, 'trzeci'], [4, 'czwarty'], [-1, 'ostatni']];
const weekdayName = (d: WeekdayCode) => WEEKDAY[(WEEKDAY_CODES.indexOf(d) + 1) as IsoWeekday].label;

const reminderLabel = (r: HabitReminderDraft, today: LocalDate): string =>
  r.kind === 'relative' ? (r.offsetMin === 0 ? 'o porze zadania' : `${reminderOffset(r.offsetMin)} porą zadania`) : `jednorazowo: ${relativeDay(r.atDate, today)}, ${r.atTime}`;

function Value({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} onPress={onPress} style={({ pressed }) => [styles.value, { borderColor: p.border, backgroundColor: pressed ? p.border : p.card }]}>
      <Text style={{ color: p.muted, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: p.fg, fontSize: 15 }} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

export default function HabitFormScreen() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { data, today, workspaceId } = useView();
  const { run } = useTaskActions();
  const task = id ? (data.tasks.find((t) => t.id === id && t.kind === 'habit') ?? null) : null;
  const savedReminders = useLocalQuery(
    ['reminders'],
    async (engine) =>
      (id
        ? await engine.db.all<{ id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
            'select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null and (created_by is null or created_by = ?) order by kind desc, offset_min, at_date, at_time',
            [id, engine.userId],
          )
        : []
      ).map(
        (r): HabitReminderDraft & { id: string } =>
          r.kind === 'absolute'
            ? { id: r.id, kind: 'absolute', atDate: String(r.at_date) as LocalDate, atTime: String(r.at_time).slice(0, 5) as LocalTime }
            : { id: r.id, kind: 'relative', offsetMin: Number(r.offset_min) },
      ),
    [id],
  );
  const initial = useMemo(() => habitDraft(task, today), [task, today]);
  const [title, setTitle] = useState(task?.title ?? '');
  const [listId, setListId] = useState(task?.listId ?? targetInbox(data, workspaceId)?.id ?? data.lists[0]?.id ?? '');
  const [kind, setKind] = useState<ScheduleKind>(initial.schedule.kind);
  const [days, setDays] = useState<IsoWeekday[]>(initial.schedule.kind === 'days' ? initial.schedule.days : [1, 2, 3, 4, 5]);
  const [times, setTimes] = useState(initial.schedule.kind === 'goal' ? initial.schedule.times : 3);
  const [period, setPeriod] = useState<'week' | 'month'>(initial.schedule.kind === 'goal' ? initial.schedule.period : 'week');
  const [monthly, setMonthly] = useState(initial.schedule.kind === 'monthly' ? initial.schedule : habitMonthly(initial.start));
  const [quantity, setQuantity] = useState(initial.target !== null);
  const [target, setTarget] = useState(String(initial.target ?? 8));
  const [unit, setUnit] = useState(initial.unit ?? '');
  const [start, setStart] = useState(initial.start);
  const [time, setTime] = useState<LocalTime | null>(initial.time);
  const [end, setEnd] = useState<RecurrenceEnd>(initial.end ?? { kind: 'never' });
  // Lista przypomnień: z bazy, dopóki użytkownik jej nie zmieni (zapis dopiero przy „Zapisz”).
  const [reminderList, setReminderList] = useState<HabitReminderDraft[] | null>(null);
  const reminders: HabitReminderDraft[] = reminderList ?? savedReminders ?? [];
  const [error, setError] = useState<string | null>(null);

  if (id && !task) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: p.bg }}>
        <Text style={{ color: p.muted }}>{data.loaded ? 'Tego zadania cyklicznego już nie ma.' : 'Wczytywanie…'}</Text>
      </View>
    );
  }

  const kinds: [ScheduleKind, string][] = [
    ['daily', 'Codziennie'],
    ['days', 'W wybrane dni'],
    ['monthly', 'Co miesiąc'],
    ['goal', 'N razy w okresie'],
    ...(initial.schedule.kind === 'custom' ? ([['custom', 'Bez zmian (własna reguła)']] as [ScheduleKind, string][]) : []),
  ];

  // Najbliższe dni przy „co miesiąc” (np. 31. dnia omija krótsze miesiące).
  const monthlyPreview = (() => {
    if (kind !== 'monthly') return null;
    try {
      return previewDates(habitFields({ schedule: monthly, start, target: null, unit: null, time: null }).recurrence, today, 3);
    } catch {
      return null;
    }
  })();

  const addReminder = async () => {
    const offsets = REMINDER_PRESETS.filter((m) => m < 1440 && !reminders.some((r) => r.kind === 'relative' && r.offsetMin === m));
    const choice = await pickOption<number | 'abs'>('Przypomnienie', [
      ...(time ? offsets.map((m) => ({ label: reminderLabel({ kind: 'relative', offsetMin: m }, today), value: m })) : []),
      { label: 'Jednorazowo: dzień i godzina…', value: 'abs' as const, ...(!time && { hint: 'Przypomnienia przed porą zadania — po ustawieniu pory' }) },
    ]);
    if (choice === undefined) return;
    if (choice !== 'abs') return setReminderList([...reminders, { kind: 'relative', offsetMin: choice }]);
    const atDate = await pickDate({ title: 'Dzień przypomnienia', value: start > today ? start : today, today });
    if (!atDate) return;
    const atTime = await pickTime({ title: 'Godzina przypomnienia', value: time ?? '09:00' });
    if (atTime) setReminderList([...reminders, { kind: 'absolute', atDate, atTime }]);
  };

  // „Po N razach” (COUNT) nie łączy się z „N razy w okresie” (jak na webie).
  const shownEnd: RecurrenceEnd = kind === 'goal' && end.kind === 'count' ? { kind: 'never' } : end;
  const pickEnd = async () => {
    const choice = await pickOption<RecurrenceEnd['kind']>('Koniec powtarzania', [
      { label: 'nigdy', value: 'never', selected: shownEnd.kind === 'never' },
      { label: 'w dniu…', value: 'until', selected: shownEnd.kind === 'until' },
      ...(kind === 'goal' ? [] : [{ label: 'po liczbie razy…', value: 'count' as const, selected: shownEnd.kind === 'count' }]),
    ]);
    if (choice === 'never') setEnd({ kind: 'never' });
    else if (choice === 'until') {
      const date = await pickDate({ title: 'Ostatni dzień', value: end.kind === 'until' ? end.date : addDays(start, 29), today });
      if (date) setEnd({ kind: 'until', date });
    } else if (choice === 'count') {
      const n = await pickNumber('Po ilu razach zakończyć', { value: end.kind === 'count' ? end.n : 30, min: 1, max: MAX_COUNT });
      if (n) setEnd({ kind: 'count', n });
    }
  };

  const submit = async () => {
    try {
      const schedule: HabitDraft['schedule'] =
        kind === 'days'
          ? { kind, days }
          : kind === 'goal'
            ? { kind, period, times }
            : kind === 'monthly'
              ? monthly
              : kind === 'custom' && initial.schedule.kind === 'custom'
                ? initial.schedule
                : { kind: 'daily' };
      const draft: HabitDraft = { schedule, start, end: shownEnd, target: quantity ? Number(target.replace(',', '.')) : null, unit: quantity ? unit : null, time };
      if (reminders.some((r) => r.kind === 'relative') && !draft.time) throw new Error('Przypomnienie przed porą zadania wymaga pory — ustaw ją albo dodaj przypomnienie na dzień i godzinę.');
      const { taskId, ops } = habitSaveOps({
        id: task?.id,
        title,
        listId,
        draft,
        reminders,
        reminderIds: (savedReminders ?? []).map((r) => r.id),
        lastSortKey: lastSortKey(data, listId),
        now: new Date(),
      });
      await run(ops, { text: task ? `Zapisano „${title.trim()}”` : `Dodano cykliczne „${title.trim()}”` });
      if (reminders.length && !(await permissionState()).notifications) await requestNotificationPermission();
      if (task) router.back();
      else router.replace({ pathname: '/habit/[id]', params: { id: taskId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const list = data.lists.find((l) => l.id === listId);

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: task ? 'Edycja cyklicznego' : 'Nowe cykliczne' }} />
      <Field label="Nazwa" value={title} onChangeText={setTitle} placeholder="np. Woda, Spacer 30 min" autoFocus={!task} maxLength={500} />
      <Value
        label="Lista"
        value={list ? listLabel(data, list.id) : '—'}
        onPress={() =>
          void pickOption<string>(
            'Lista zadania',
            data.lists.map((l) => ({ label: listLabel(data, l.id), hint: `${data.workspaces.find((w) => w.id === l.workspaceId)?.name ?? ''} · ${LIST_KIND[l.kind]}`, value: l.id, selected: l.id === listId })),
          ).then((v) => v && setListId(v))
        }
      />

      <Text style={[styles.label, { color: p.fg }]}>Jak często</Text>
      <View style={styles.wrap}>
        {kinds.map(([k, label]) => (
          <Chip key={k} label={label} selected={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      {kind === 'days' ? (
        <View style={styles.days}>
          {([1, 2, 3, 4, 5, 6, 7] as IsoWeekday[]).map((d) => {
            const on = days.includes(d);
            return (
              <Pressable
                key={d}
                accessibilityRole="button"
                accessibilityLabel={WEEKDAY[d].label}
                accessibilityState={{ selected: on }}
                onPress={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
                style={[styles.day, { borderColor: on ? p.accent : p.border, backgroundColor: on ? p.accent : 'transparent' }]}
              >
                <Text style={{ color: on ? '#fff' : p.fg, fontSize: 13 }}>{WEEKDAY[d].short}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {kind === 'goal' ? (
        <View style={styles.line}>
          <TextInput
            accessibilityLabel="Ile razy"
            value={String(times || '')}
            onChangeText={(t) => setTimes(Number(t.replace(/\D/g, '')) || 0)}
            keyboardType="number-pad"
            maxLength={2}
            style={[styles.input, { width: 56, color: p.fg, borderColor: p.border }]}
          />
          <Text style={{ color: p.fg }}>{pluralForm(times, ['raz', 'razy', 'razy'])} w</Text>
          <Chip label="tygodniu" selected={period === 'week'} onPress={() => setPeriod('week')} />
          <Chip label="miesiącu" selected={period === 'month'} onPress={() => setPeriod('month')} />
          {period === 'month' ? (
            <Text style={{ color: p.muted, fontSize: 12, width: '100%' }}>
              dowolne dni; konkretny dzień miesiąca — wybierz „Co miesiąc”
            </Text>
          ) : null}
        </View>
      ) : null}
      {kind === 'monthly' ? (
        <View style={{ gap: 8 }}>
          <View style={styles.line}>
            <View style={{ flex: 1 }}>
              <Value
                label="Którego dnia"
                value={MONTHLY_BY.find(([b]) => b === monthly.by)![1]}
                onPress={() =>
                  void pickOption<MonthlyBy>(
                    'Którego dnia miesiąca',
                    MONTHLY_BY.map(([b, label]) => ({ label, value: b, selected: b === monthly.by })),
                  ).then((v) => v && setMonthly({ ...monthly, by: v }))
                }
              />
            </View>
            {monthly.by === 'day' ? (
              <TextInput
                accessibilityLabel="Dzień miesiąca"
                value={String(monthly.day || '')}
                onChangeText={(t) => setMonthly({ ...monthly, day: Number(t.replace(/\D/g, '')) || 0 })}
                keyboardType="number-pad"
                maxLength={2}
                style={[styles.input, { width: 64, color: p.fg, borderColor: p.border }]}
              />
            ) : null}
          </View>
          {monthly.by === 'weekday' ? (
            <View style={styles.line}>
              <View style={{ flex: 1 }}>
                <Value
                  label="Który"
                  value={NTH.find(([n]) => n === monthly.nth)?.[1] ?? '—'}
                  onPress={() =>
                    void pickOption<number>(
                      'Który w miesiącu',
                      NTH.map(([n, label]) => ({ label, value: n, selected: n === monthly.nth })),
                    ).then((v) => v !== undefined && setMonthly({ ...monthly, nth: v }))
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Value
                  label="Dzień tygodnia"
                  value={weekdayName(monthly.weekday)}
                  onPress={() =>
                    void pickOption<WeekdayCode>(
                      'Dzień tygodnia',
                      WEEKDAY_CODES.map((d) => ({ label: weekdayName(d), value: d, selected: d === monthly.weekday })),
                    ).then((v) => v && setMonthly({ ...monthly, weekday: v }))
                  }
                />
              </View>
            </View>
          ) : null}
          {monthlyPreview?.length ? <Text style={{ color: p.muted, fontSize: 12 }}>najbliżej: {monthlyPreview.map((d) => dayChip(d)).join(' · ')}</Text> : null}
        </View>
      ) : null}

      <View style={styles.switchRow}>
        <Text style={{ color: p.fg, fontSize: 15, flex: 1 }}>Cel ilościowy</Text>
        <Switch value={quantity} onValueChange={setQuantity} />
      </View>
      {quantity ? (
        <View style={styles.line}>
          <TextInput
            accessibilityLabel="Cel na dzień"
            value={target}
            onChangeText={setTarget}
            keyboardType="decimal-pad"
            style={[styles.input, { width: 70, color: p.fg, borderColor: p.border }]}
          />
          <TextInput
            accessibilityLabel="Jednostka"
            value={unit}
            onChangeText={setUnit}
            placeholder="szklanek"
            placeholderTextColor={p.muted}
            maxLength={20}
            style={[styles.input, { flex: 1, color: p.fg, borderColor: p.border }]}
          />
          <Text style={{ color: p.muted, fontSize: 12, width: '100%' }}>dziennie; mniej = „częściowo” (nie zalicza dnia)</Text>
        </View>
      ) : null}

      <View style={styles.line}>
        <View style={{ flex: 1 }}>
          <Value label="Początek" value={shortDate(start)} onPress={() => void pickDate({ title: 'Początek', value: start, today }).then((d) => d && setStart(d))} />
        </View>
        <View style={{ flex: 1 }}>
          <Value label="Pora (opcjonalnie)" value={time ?? '—'} onPress={() => void pickTime({ title: 'Pora zadania', value: time, allowNone: true }).then((t) => t !== undefined && setTime(t))} />
        </View>
      </View>
      <Value
        label="Koniec"
        value={shownEnd.kind === 'until' ? `w dniu ${shortDate(shownEnd.date)}` : shownEnd.kind === 'count' ? `po ${shownEnd.n} ${pluralForm(shownEnd.n, ['razie', 'razach', 'razach'])}` : 'nigdy'}
        onPress={() => void pickEnd()}
      />
      <Text style={[styles.label, { color: p.fg }]}>Przypomnienia</Text>
      {reminders.map((r, i) => (
        <View key={r.id ?? `new-${i}`} style={styles.switchRow}>
          <Text style={{ color: p.fg, fontSize: 15, flex: 1 }}>🔔 {reminderLabel(r, today)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Usuń przypomnienie" hitSlop={10} onPress={() => setReminderList(reminders.filter((_, j) => j !== i))}>
            <Text style={{ color: p.muted, fontSize: 18 }}>×</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.wrap}>
        <Chip label="+ Dodaj przypomnienie" onPress={() => void addReminder()} />
      </View>
      {reminders.length ? (
        <Text style={{ color: p.muted, fontSize: 12 }}>
          Przed porą — w każdy zaplanowany dzień, chyba że już odhaczone; jednorazowe — raz, w wybranym dniu. Powiadomienie ma przycisk „Zrobione”.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: p.bad }}>
          {error}
        </Text>
      ) : null}
      <Button title={task ? 'Zapisz' : 'Dodaj cykliczne'} onPress={() => void submit()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12, paddingBottom: 48 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  days: { flexDirection: 'row', gap: 4 },
  day: { flex: 1, height: 40, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  value: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, gap: 2 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
