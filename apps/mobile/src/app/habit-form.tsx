/**
 * Formularz nawyku (Etap 8): nazwa, lista, jak często (codziennie / wybrane dni / co miesiąc w ustalony
 * dzień / N razy w tygodniu lub miesiącu), cel ilościowy, początek, pora i przypomnienie o tej porze. Formularz ↔ pola —
 * `habitDraft` / `habitSaveOps` z core (jak `HabitEditor` na webie). `?id=` — edycja.
 */
import {
  dayChip,
  habitDraft,
  habitFields,
  habitMonthly,
  habitSaveOps,
  LIST_KIND,
  pluralForm,
  previewDates,
  shortDate,
  WEEKDAY,
  WEEKDAY_CODES,
  type HabitDraft,
  type IsoWeekday,
  type LocalTime,
  type MonthlyBy,
  type WeekdayCode,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { pickDate, pickOption, pickTime } from '@/components/pickers';
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
  const reminderIds =
    useLocalQuery(['reminders'], async (engine) => (id ? (await engine.db.all<{ id: string }>('select id from reminders where task_id = ? and deleted_at is null', [id])).map((r) => r.id) : []), [id]) ?? [];
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
  const [remindChoice, setRemind] = useState<boolean | null>(null);
  const remind = remindChoice ?? (task ? reminderIds.length > 0 : false);
  const [error, setError] = useState<string | null>(null);

  if (id && !task) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: p.bg }}>
        <Text style={{ color: p.muted }}>{data.loaded ? 'Tego nawyku już nie ma.' : 'Wczytywanie…'}</Text>
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
      // `...initial` — pola draftu, których formularz nie edytuje, zostają (np. koniec reguły).
      const draft: HabitDraft = { ...initial, schedule, start, target: quantity ? Number(target.replace(',', '.')) : null, unit: quantity ? unit : null, time };
      if (remind && !draft.time) throw new Error('Przypomnienie wymaga pory.');
      const { taskId, ops } = habitSaveOps({ id: task?.id, title, listId, draft, remind, reminderIds, lastSortKey: lastSortKey(data, listId), now: new Date() });
      await run(ops, { text: task ? `Zapisano „${title.trim()}”` : `Dodano nawyk „${title.trim()}”` });
      if (remind && !(await permissionState()).notifications) await requestNotificationPermission();
      if (task) router.back();
      else router.replace({ pathname: '/habit/[id]', params: { id: taskId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const list = data.lists.find((l) => l.id === listId);

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: task ? 'Edycja nawyku' : 'Nowy nawyk' }} />
      <Field label="Nazwa" value={title} onChangeText={setTitle} placeholder="np. Woda, Spacer 30 min" autoFocus={!task} maxLength={500} />
      <Value
        label="Lista"
        value={list ? listLabel(data, list.id) : '—'}
        onPress={() =>
          void pickOption<string>(
            'Lista nawyku',
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
          <Value label="Początek" value={shortDate(start)} onPress={() => void pickDate({ title: 'Początek nawyku', value: start, today }).then((d) => d && setStart(d))} />
        </View>
        <View style={{ flex: 1 }}>
          <Value label="Pora (opcjonalnie)" value={time ?? '—'} onPress={() => void pickTime({ title: 'Pora nawyku', value: time, allowNone: true }).then((t) => t !== undefined && setTime(t))} />
        </View>
      </View>
      <View style={styles.switchRow}>
        <Text style={{ color: p.fg, fontSize: 15, flex: 1 }}>Przypomnij o tej porze</Text>
        <Switch value={remind} onValueChange={setRemind} />
      </View>
      {remind ? <Text style={{ color: p.muted, fontSize: 12 }}>Powiadomienie przychodzi w dni nawyku, chyba że już odhaczony; ma przycisk „Zrobione”.</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: p.bad }}>
          {error}
        </Text>
      ) : null}
      <Button title={task ? 'Zapisz' : 'Dodaj nawyk'} onPress={() => void submit()} />
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
