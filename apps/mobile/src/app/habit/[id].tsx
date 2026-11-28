/**
 * Nawyk (Etap 8, M15): passa bieżąca i najdłuższa, regularność 7/30/90 dni, suma, pasek 8 dni,
 * wykres i tabela 12 tygodni, mapa cieplna roku kalendarzowego (‹ › w zakresie `habitYearRange`,
 * przyszłe dni reguły jako zaplanowane); edycja, zakończenie / wznowienie, kosz. Statystyki —
 * `habitStats`, `habitWeeks`, `habitYear` z core (jak `#/habit/<id>` na webie).
 */
import {
  dayChip,
  deleteTaskOps,
  describeHabit,
  habitStripHint,
  HABIT_CONVERT,
  HABIT_RATE_WINDOWS,
  habitStats,
  habitToSeriesOps,
  habitToSeriesProblem,
  habitWeeks,
  habitYear,
  habitYearRange,
  isOpen,
  MONTH_SHORT,
  plural,
  pluralForm,
  reopenTaskPatch,
  shortDate,
  toHabit,
  WEEKDAY,
  type DayState,
  type Habit,
  type IsoWeekday,
  type LocalDate,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState, type ComponentRef } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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
  const [shownYear, setShownYear] = useState<number | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
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
  // Mapa roku: rok kalendarzowy (domyślnie bieżący), strzałkami w zakresie `habitYearRange`.
  const range = habitYearRange(habit, completions, today);
  const currentYear = Number(today.slice(0, 4));
  const yearShown = Math.min(Math.max(shownYear ?? currentYear, range.min), range.max);
  const year = habitYear(habit, completions, today, { year: yearShown });
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
    if (!(await confirm(`Przenieść „${task.title}” do kosza?`, 'Historia zostaje i wróci razem z zadaniem.', 'Do kosza', 'Anuluj'))) return;
    const ops = deleteTaskOps(data.tasks, task.id, new Date());
    void run(ops, { text: `„${task.title}” w koszu`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: null } })) });
    router.back();
  };
  // Cykliczne z passą → zwykła seria (ekran zadania); przy odmowie — powód.
  const toSeries = async () => {
    const problem = habitToSeriesProblem(task);
    if (problem) return Alert.alert(HABIT_CONVERT.toSeries, problem);
    // Zmiana rodzaju i przejście na inny ekran — najpierw pytanie (historia wykonań zostaje).
    if (!(await confirm(`${HABIT_CONVERT.toSeries}?`, `„${task.title}” stanie się zwykłym zadaniem z powtarzaniem: bez passy i statystyk nawyku. Historia wykonań zostaje, a „Zamień na nawyk” w zadaniu przywraca nawyk.`, 'Zamień', 'Anuluj'))) return;
    const result = habitToSeriesOps(task, completions, today);
    void run(result.ops, { text: result.message, undo: result.undo });
    router.replace({ pathname: '/task/[id]', params: { id: task.id } });
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
      <Row>
        <Button kind="secondary" title={HABIT_CONVERT.toSeries} onPress={() => void toSeries()} />
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
      <Text style={{ color: p.muted, fontSize: 12 }}>{habitStripHint(habit, 'Dotknij')}</Text>

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
      <Pressable onPress={() => setTableOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: tableOpen }} hitSlop={6}>
        <Text style={{ color: p.accent, fontSize: 13 }}>{tableOpen ? '▾' : '▸'} Tabela tygodni</Text>
      </Pressable>
      {tableOpen ? <WeeksTable weeks={weeks} habit={habit} /> : null}

      <View style={styles.yearBar}>
        <Text style={[styles.h2, { color: p.fg, marginTop: 0 }]}>Rok</Text>
        <YearArrow label="Poprzedni rok" glyph="‹" disabled={yearShown <= range.min} onPress={() => setShownYear(yearShown - 1)} />
        <Text style={{ color: p.fg, fontSize: 14, minWidth: 44, textAlign: 'center', fontVariant: ['tabular-nums'] }} accessibilityLiveRegion="polite">
          {yearShown}
        </Text>
        <YearArrow label="Następny rok" glyph="›" disabled={yearShown >= range.max} onPress={() => setShownYear(yearShown + 1)} />
        {yearShown !== currentYear ? (
          <Pressable onPress={() => setShownYear(null)} hitSlop={8} accessibilityRole="button">
            <Text style={{ color: p.accent, fontSize: 13 }}>Bieżący</Text>
          </Pressable>
        ) : null}
      </View>
      <Heatmap key={yearShown} year={year} habit={habit} today={today} />
    </ScrollView>
  );
}

function YearArrow({ label, glyph, disabled, onPress }: { label: string; glyph: string; disabled: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} hitSlop={8} style={{ paddingHorizontal: 8, opacity: disabled ? 0.3 : 1 }}>
      <Text style={{ color: p.fg, fontSize: 20 }}>{glyph}</Text>
    </Pressable>
  );
}

/** Tabela ostatnich 12 tygodni (od najnowszego) — te same liczby co wykres. */
function WeeksTable({ weeks, habit }: { weeks: ReturnType<typeof habitWeeks>; habit: Habit }) {
  const p = usePalette();
  const quantity = habit.target !== undefined;
  const cell = { color: p.fg, fontSize: 12, fontVariant: ['tabular-nums' as const] };
  const head = { color: p.muted, fontSize: 12 };
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.tableRow}>
        <Text style={[head, styles.tableWeek]}>Tydzień</Text>
        <Text style={[head, styles.tableNum]}>Zrobione dni</Text>
        <Text style={[head, styles.tableNum]}>Cel</Text>
        {quantity ? <Text style={[head, styles.tableNum]}>{habit.unit ?? 'Wartość'}</Text> : null}
      </View>
      {[...weeks].reverse().map((w) => (
        <View key={w.start} style={[styles.tableRow, { borderTopColor: p.border }]}>
          <Text style={[cell, styles.tableWeek]}>
            {shortDate(w.start)}–{shortDate(w.end)}
          </Text>
          <Text style={[cell, styles.tableNum]}>{w.done}</Text>
          <Text style={[cell, styles.tableNum]}>{w.target ?? '—'}</Text>
          {quantity ? <Text style={[cell, styles.tableNum]}>{w.value}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const CELL = 11;
const GAP = 2;
const LABEL_W = 20;

/** Mapa cieplna roku kalendarzowego: kolumny tygodni (pon–ndz), przyszłe dni nawyku jako zaplanowane. */
function Heatmap({ year, habit, today }: { year: ReturnType<typeof habitYear>; habit: Habit; today: LocalDate }) {
  const p = usePalette();
  const colors = useStateColors();
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const size = useRef({ view: 0, content: 0 });
  const legend = LEGEND.filter((s) => s !== 'partial' || habit.target !== undefined).filter((s) => s !== 'missed' || !habit.goal);
  const planned = !habit.goal && year.weeks.some((w) => w.some((d) => d.planned));
  const todayColumn = year.weeks.findIndex((w) => w.some((d) => d.date === today));
  // Po ułożeniu (szerokość widoku i treści — w dowolnej kolejności): dziś pod ¾ szerokości,
  // rok miniony — koniec, przyszły — początek.
  const place = () => {
    const { view, content } = size.current;
    if (!view || !content) return;
    const x = todayColumn >= 0 ? LABEL_W + todayColumn * (CELL + GAP) - view * 0.75 : year.weeks[0]![0]!.date > today ? 0 : content;
    scroller.current?.scrollTo({ x: Math.max(0, Math.min(x, content - view)), animated: false });
  };
  return (
    <View style={{ gap: 6 }}>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        onLayout={(e) => {
          size.current.view = e.nativeEvent.layout.width;
          place();
        }}
        onContentSizeChange={(w) => {
          size.current.content = w;
          place();
        }}
      >
        <View style={{ gap: GAP }}>
          <View style={styles.heatRow}>
            <View style={{ width: LABEL_W }} />
            {year.weeks.map((_, column) => {
              const month = year.months.find((m) => m.column === column);
              return (
                <View key={column} style={{ width: CELL, height: 12, overflow: 'visible' }}>
                  {month ? <Text style={[styles.month, { color: p.muted }]}>{MONTH_SHORT[month.month - 1]}</Text> : null}
                </View>
              );
            })}
          </View>
          {([1, 2, 3, 4, 5, 6, 7] as IsoWeekday[]).map((weekday) => (
            <View key={weekday} style={styles.heatRow}>
              <Text style={{ width: LABEL_W, color: p.muted, fontSize: 9, lineHeight: CELL }}>{weekday % 2 ? WEEKDAY[weekday].short : ''}</Text>
              {year.weeks.map((week) => {
                const d = week[weekday - 1]!;
                if (d.outside) return <View key={d.date} style={styles.cell} />;
                if (d.future) {
                  // Przyszły dzień bez planu — blada komórka, żeby siatka roku była widoczna.
                  if (!d.planned) return <View key={d.date} style={[styles.cell, { backgroundColor: colors.off.bg, opacity: 0.3 }]} />;
                  return <View key={d.date} accessibilityLabel={`${dayChip(d.date)}: zaplanowane`} style={[styles.cell, { backgroundColor: p.card, borderColor: p.accent, borderWidth: 1 }]} />;
                }
                const c = colors[d.state];
                const label = `${dayChip(d.date)}: ${STATE_LABEL[d.state]}${d.value !== null && habit.target !== undefined ? ` (${d.value} / ${habit.target})` : ''}`;
                return (
                  <View
                    key={d.date}
                    accessibilityLabel={label}
                    style={[styles.cell, { backgroundColor: c.bg, borderColor: c.border ?? 'transparent', borderWidth: d.state === 'skipped' || d.state === 'pending' ? 1 : 0, opacity: d.state === 'off' ? 0.6 : 1 }]}
                  />
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      {habit.goal && year.weeks.some((w) => w.some((d) => d.future && !d.outside)) ? (
        <Text style={{ color: p.muted, fontSize: 12 }}>Przy „N razy w okresie” dni nie są z góry ustalone — przyszłe dni zapełnią się, gdy je odhaczysz.</Text>
      ) : null}
      <View style={styles.legend}>
        {legend.map((s) => (
          <View key={s} style={styles.legendItem}>
            <View style={[styles.cell, { backgroundColor: colors[s].bg, borderColor: colors[s].border ?? 'transparent', borderWidth: s === 'skipped' ? 1 : 0 }]} />
            <Text style={{ color: p.muted, fontSize: 11 }}>
              {STATE_LABEL[s]}
              {year.counts[s] && s !== 'off' ? ` (${year.counts[s]})` : ''}
            </Text>
          </View>
        ))}
        {planned ? (
          <View style={styles.legendItem}>
            <View style={[styles.cell, { backgroundColor: p.card, borderColor: p.accent, borderWidth: 1 }]} />
            <Text style={{ color: p.muted, fontSize: 11 }}>zaplanowane</Text>
          </View>
        ) : null}
      </View>
    </View>
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
  yearBar: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8 },
  heatRow: { flexDirection: 'row', gap: GAP, alignItems: 'center' },
  month: { position: 'absolute', left: 0, top: 0, fontSize: 9, width: 30 },
  cell: { width: CELL, height: CELL, borderRadius: 2 },
  tableRow: { flexDirection: 'row', gap: 8, paddingTop: 3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'transparent' },
  tableWeek: { flex: 2 },
  tableNum: { flex: 1, textAlign: 'right' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
