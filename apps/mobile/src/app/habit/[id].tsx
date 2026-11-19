/**
 * Nawyk (Etap 8, M15): passa bieżąca i najdłuższa, regularność 7/30/90 dni, suma, pasek 8 dni,
 * wykres 12 tygodni, mapa cieplna roku; edycja, zakończenie / wznowienie, kosz. Statystyki —
 * `habitStats`, `habitWeeks`, `habitYear` z core (jak `#/habit/<id>` na webie).
 */
import {
  deleteTaskOps,
  describeHabit,
  HABIT_BACKFILL_DAYS,
  HABIT_RATE_WINDOWS,
  habitStats,
  habitWeeks,
  habitYear,
  isOpen,
  plural,
  pluralForm,
  reopenTaskPatch,
  shortDate,
  toHabit,
  type DayState,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { confirm, useTaskActions } from '@/components/actions';
import { completionsOf, HabitDayStrip, pct, STATE_LABEL, STREAK_UNIT, useStateColors } from '@/components/habits';
import { Button, Row, usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';

const LEGEND: DayState[] = ['done', 'partial', 'skipped', 'missed', 'off'];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const p = usePalette();
  return (
    <View style={[styles.stat, { borderColor: p.border, backgroundColor: p.card }]}>
      <Text style={{ color: p.muted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: p.fg, fontSize: 24, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{value}</Text>
      {hint ? <Text style={{ color: p.muted, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

export default function HabitScreen() {
  const p = usePalette();
  const colors = useStateColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, today } = useView();
  const { run } = useTaskActions();
  const task = data.tasks.find((t) => t.id === id && t.kind === 'habit');
  const habit = task ? toHabit(task) : null;

  if (!task || !habit) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: p.bg }}>
        <Stack.Screen options={{ title: 'Nawyk' }} />
        <Text style={{ color: p.muted }}>{data.loaded ? 'Tego nawyku nie ma (usunięty albo w zarchiwizowanej liście).' : 'Wczytywanie…'}</Text>
      </View>
    );
  }
  const completions = completionsOf(data, task.id);
  const stats = habitStats(habit, completions, today);
  const weeks = habitWeeks(habit, completions, today, 12);
  const year = habitYear(habit, completions, today);
  const open = isOpen(task);
  const unit = STREAK_UNIT[stats.streak.unit];
  const quantity = habit.target !== undefined;
  const value = (w: (typeof weeks)[number]) => (quantity ? w.value : w.done);
  const goal = (w: (typeof weeks)[number]) => (w.target === null ? null : quantity ? w.target * habit.target! : w.target);
  const max = Math.max(1, ...weeks.map((w) => Math.max(value(w), goal(w) ?? 0)));

  const end = () =>
    void run([{ table: 'tasks', id: task.id, patch: { status: 'cancelled', completed_at: new Date().toISOString() } }], {
      text: `„${task.title}” — zakończony`,
      undo: [{ table: 'tasks', id: task.id, patch: { status: task.status, completed_at: task.completedAt } }],
    });
  const remove = async () => {
    if (!(await confirm(`Przenieść „${task.title}” do kosza?`, 'Historia zostaje i wróci razem z nawykiem.', 'Do kosza', 'Anuluj'))) return;
    const ops = deleteTaskOps(data.tasks, task.id, new Date());
    void run(ops, { text: `„${task.title}” w koszu`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: null } })) });
    router.back();
  };

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.body}>
      <Stack.Screen options={{ title: task.title }} />
      <Text style={{ color: p.muted, fontSize: 13 }}>
        {describeHabit(habit)}
        {habit.time ? ` · o ${habit.time}` : ''} · od {shortDate(habit.recurrence.anchor)}
        {open ? '' : ' · zakończony'}
      </Text>
      <Row>
        <Button kind="secondary" title="Edytuj" onPress={() => router.push({ pathname: '/habit-form', params: { id: task.id } })} />
        {open ? (
          <Button kind="secondary" title="Zakończ" onPress={end} />
        ) : (
          <Button kind="secondary" title="Wznów" onPress={() => void run([{ table: 'tasks', id: task.id, patch: reopenTaskPatch() }], { text: `„${task.title}” — wznowiony` })} />
        )}
        <Button kind="danger" title="Usuń" onPress={() => void remove()} />
      </Row>

      <View style={styles.stats}>
        <Stat label="Bieżąca passa" value={String(stats.streak.current)} hint={pluralForm(stats.streak.current, unit)} />
        <Stat label="Najdłuższa passa" value={String(stats.streak.best)} hint={pluralForm(stats.streak.best, unit)} />
        <Stat label="Regularność 30 dni" value={pct(stats.rates[30].rate)} hint={`${stats.rates[30].done} z ${stats.rates[30].possible}`} />
        <Stat
          label={quantity ? `Razem${habit.unit ? ` (${habit.unit})` : ''}` : 'Dni zrobione'}
          value={String(quantity ? stats.totalValue : stats.totalDone)}
          hint={quantity ? plural(stats.totalDone, ['dzień z celem', 'dni z celem', 'dni z celem']) : 'od początku'}
        />
      </View>
      <Text style={{ color: p.muted, fontSize: 12 }}>
        Regularność: {HABIT_RATE_WINDOWS.map((w) => `${w} dni ${pct(stats.rates[w].rate)} (${stats.rates[w].done}/${stats.rates[w].possible})`).join(' · ')}. Dni wolne i okres w toku się nie liczą.
      </Text>

      <Text style={[styles.h2, { color: p.fg }]}>Ostatnie dni</Text>
      {open ? <HabitDayStrip task={task} habit={habit} /> : null}
      <Text style={{ color: p.muted, fontSize: 12 }}>Dotknij dnia: zrobione → dzień wolny → wyczyść. Uzupełnić można do {HABIT_BACKFILL_DAYS} dni wstecz.</Text>

      <Text style={[styles.h2, { color: p.fg }]}>{quantity ? `Tygodnie — ${habit.unit ?? 'wartość'}` : 'Tygodnie — dni zrobione'}</Text>
      <View style={styles.chart} accessibilityLabel={weeks.map((w) => `${shortDate(w.start)}: ${value(w)}${goal(w) !== null ? ` z ${goal(w)}` : ''}`).join(', ')}>
        {weeks.map((w) => {
          const g = goal(w);
          return (
            <View key={w.start} style={styles.column}>
              <View style={[styles.track, { height: 90 }]}>
                {g !== null ? <View style={[styles.goal, { height: (90 * g) / max, borderColor: p.border }]} /> : null}
                <View style={[styles.bar, { height: Math.max(2, (90 * value(w)) / max), backgroundColor: g !== null && value(w) >= g ? colors.done.bg : p.accent }]} />
              </View>
              <Text style={{ color: p.muted, fontSize: 9 }}>{w.start.slice(8)}.{w.start.slice(5, 7)}</Text>
            </View>
          );
        })}
      </View>

      <Text style={[styles.h2, { color: p.fg }]}>Rok</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentOffset={{ x: 10_000, y: 0 }}>
        <View style={styles.heat}>
          {year.weeks.map((week, i) => (
            <View key={i} style={styles.heatCol}>
              {week.map((d) => {
                const c = colors[d.state];
                return (
                  <View
                    key={d.date}
                    style={[styles.cell, { backgroundColor: d.future ? 'transparent' : c.bg, borderColor: d.future ? 'transparent' : (c.border ?? 'transparent'), borderWidth: d.state === 'skipped' || d.state === 'pending' ? 1 : 0 }]}
                  />
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={styles.legend}>
        {LEGEND.map((s) => (
          <View key={s} style={styles.legendItem}>
            <View style={[styles.cell, { backgroundColor: colors[s].bg, borderColor: colors[s].border ?? 'transparent', borderWidth: s === 'skipped' ? 1 : 0 }]} />
            <Text style={{ color: p.muted, fontSize: 11 }}>
              {STATE_LABEL[s]} {year.counts[s]}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12, paddingBottom: 48 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { width: '48.5%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10 },
  h2: { fontSize: 15, fontWeight: '700', marginTop: 8 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  column: { alignItems: 'center', gap: 3, flex: 1 },
  track: { width: 16, justifyContent: 'flex-end' },
  goal: { position: 'absolute', bottom: 0, left: 0, right: 0, borderWidth: 1, borderStyle: 'dashed', borderRadius: 3 },
  bar: { width: '100%', borderRadius: 3 },
  heat: { flexDirection: 'row', gap: 2 },
  heatCol: { gap: 2 },
  cell: { width: 11, height: 11, borderRadius: 2 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
