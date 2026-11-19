/**
 * „Nawyki” (Etap 8): otwarte nawyki bieżącej przestrzeni z opisem, passą, regularnością 30 dni
 * i paskiem 8 dni (uzupełnianie wstecz), zakończone osobno, „+ Nowy nawyk”.
 */
import { describeHabit, habitsForDay, habitStats, isOpen, plural, toHabit } from '@taskplanner/core';
import { router, Stack } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { completionsOf, HabitDayStrip, pct, STREAK_UNIT } from '@/components/habits';
import { ScreenHeader } from '@/components/sync-banner';
import { Fab } from '@/components/task-list';
import { usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';

export default function HabitsScreen() {
  const p = usePalette();
  const { data, today, workspaceId } = useView();
  const habits = useMemo(
    () => data.tasks.filter((t) => t.kind === 'habit' && (!workspaceId || t.workspaceId === workspaceId)).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)),
    [data.tasks, workspaceId],
  );
  const forToday = useMemo(() => habitsForDay(data.tasks, data.habitCompletions, today, today, workspaceId), [data.tasks, data.habitCompletions, today, workspaceId]);
  const open = habits.filter(isOpen);
  const closed = habits.filter((t) => !isOpen(t));
  const left = forToday.filter((h) => !h.settled).length;
  const subtitle = open.length
    ? `${plural(forToday.length, ['nawyk', 'nawyki', 'nawyków'])} na dziś · ${left ? `${left} do zrobienia` : 'wszystko zrobione'}`
    : 'Codzienne i tygodniowe nawyki z passą i statystykami';

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title: 'Nawyki' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        <ScreenHeader subtitle={subtitle} />
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
        {!open.length && data.loaded ? (
          <Text style={[styles.empty, { color: p.muted }]}>Nie masz jeszcze nawyków. Dodaj pierwszy — np. „Woda 8 szklanek” albo „Siłownia 3 razy w tygodniu”.</Text>
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
      <Fab onPress={() => router.push('/habit-form')} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  empty: { textAlign: 'center', padding: 32, fontSize: 15 },
  head: { fontSize: 13, fontWeight: '700', paddingHorizontal: 12, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  closed: { paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  hint: { fontSize: 12, padding: 12 },
});
