/**
 * „Cykliczne” (Etap 8): otwarte nawyki bieżącej przestrzeni z opisem, passą, regularnością 30 dni
 * i paskiem 8 dni (uzupełnianie wstecz), zakończone osobno, „+ Nowe cykliczne”. Chipy filtra (lista,
 * godzina — reszta warunków nie dotyczy nawyków) trwają do opuszczenia ekranu, nie są zapisywane.
 * Pod nawykami sekcja „Zadania z powtarzaniem” — zwykłe serie (core `selectSeries`), bez passy.
 */
import { applyFilter, describeHabit, habitsForDay, habitStats, isEmptyFilter, isOpen, plural, selectSeries, toHabit, type FilterQuery } from '@taskplanner/core';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilterBar, type FilterField } from '@/components/filter-bar';
import { completionsOf, HabitDayStrip, pct, STREAK_UNIT } from '@/components/habits';
import { ScreenHeader } from '@/components/sync-banner';
import { Fab } from '@/components/task-list';
import { TaskRow } from '@/components/task-row';
import { usePalette } from '@/components/ui';
import { listLabel, useView } from '@/lib/app-data';

const HIDDEN: FilterField[] = ['tags', 'priorities', 'statuses', 'due'];

export default function HabitsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { data, today, workspaceId } = useView();
  const [filter, setFilter] = useState<FilterQuery>({});
  const tasks = useMemo(() => (isEmptyFilter(filter) ? data.tasks : applyFilter(data.tasks, filter, today)), [data.tasks, filter, today]);
  const habits = useMemo(
    () => tasks.filter((t) => t.kind === 'habit' && (!workspaceId || t.workspaceId === workspaceId)).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)),
    [tasks, workspaceId],
  );
  const forToday = useMemo(() => habitsForDay(tasks, data.habitCompletions, today, today, workspaceId), [tasks, data.habitCompletions, today, workspaceId]);
  const series = useMemo(() => selectSeries(tasks, { today, workspaceId }), [tasks, today, workspaceId]);
  const open = habits.filter(isOpen);
  const closed = habits.filter((t) => !isOpen(t));
  const left = forToday.filter((h) => !h.settled).length;
  const filtered = !isEmptyFilter(filter);
  const subtitle = open.length || filtered
    ? `${plural(forToday.length, ['cykliczne', 'cykliczne', 'cyklicznych'])} na dziś · ${left ? `${left} do zrobienia` : 'wszystko zrobione'}`
    : 'Codzienne i tygodniowe zadania cykliczne z passą i statystykami';

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title: 'Cykliczne' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        <ScreenHeader subtitle={subtitle}>
          <FilterBar query={filter} onChange={setFilter} hide={HIDDEN} />
        </ScreenHeader>
        {open.map((task) => {
          const habit = toHabit(task);
          if (!habit) return null;
          const stats = habitStats(habit, completionsOf(data, task.id), today);
          return (
            <View key={task.id} style={[styles.row, { borderColor: p.border }]}>
              <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/habit/[id]', params: { id: task.id } })}>
                <Text style={{ color: p.fg, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                  {task.title}
                </Text>
                <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
                  {describeHabit(habit)} · 🔥 {plural(stats.streak.current, STREAK_UNIT[stats.streak.unit])} · 30 dni: {pct(stats.rates[30].rate)}
                </Text>
              </Pressable>
              <HabitDayStrip task={task} habit={habit} size="sm" />
            </View>
          );
        })}
        {!open.length && filtered ? <Text style={[styles.empty, { color: p.muted }]}>Żadne otwarte zadanie cykliczne nie pasuje do filtra.</Text> : null}
        {!open.length && !filtered && data.loaded ? (
          <Text style={[styles.empty, { color: p.muted }]}>{series.length ? 'Nie masz jeszcze zadań cyklicznych z passą.' : 'Nie masz jeszcze zadań cyklicznych.'} Dodaj pierwsze — np. „Woda 8 szklanek” albo „Siłownia 3 razy w tygodniu”.</Text>
        ) : null}
        {series.length ? (
          <View style={{ marginTop: 18 }}>
            <Text style={[styles.head, { color: p.muted, borderColor: p.border }]}>Zadania z powtarzaniem · {series.length}</Text>
            <Text style={[styles.note, { color: p.muted }]}>Zwykłe zadania z regułą powtarzania, bez passy i statystyk. Data to najbliższe wystąpienie.</Text>
            {series.map((t) => (
              <TaskRow key={t.id} task={t} today={today} listName={listLabel(data, t.listId)} />
            ))}
          </View>
        ) : null}
        {closed.length ? (
          <View style={{ marginTop: 18 }}>
            <Text style={[styles.head, { color: p.muted, borderColor: p.border }]}>Zakończone · {closed.length}</Text>
            {closed.map((t) => (
              <Pressable key={t.id} accessibilityRole="link" onPress={() => router.push({ pathname: '/habit/[id]', params: { id: t.id } })} style={[styles.closed, { borderColor: p.border }]}>
                <Text style={{ color: p.muted, fontSize: 15 }}>{t.title}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={[styles.hint, { color: p.muted }]}>Dotknij dnia: zrobione → dzień wolny → wyczyść (do 7 dni wstecz).</Text>
      </ScrollView>
      <Fab label="Nowe cykliczne" bottom={16 + insets.bottom} onPress={() => router.push('/habit-form')} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  empty: { textAlign: 'center', padding: 32, fontSize: 15 },
  head: { fontSize: 13, fontWeight: '700', paddingHorizontal: 12, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  closed: { paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  hint: { fontSize: 12, padding: 12 },
  note: { fontSize: 12, paddingHorizontal: 12, paddingTop: 4 },
});
