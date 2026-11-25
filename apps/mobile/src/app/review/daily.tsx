/**
 * Przegląd dnia (Etap 9, M16) — gesty na kolejce: karta zadania przesunięta w prawo = Ukończ,
 * w lewo = Jutro, w górę = Dziś, w dół = Kiedyś; przyciski dla wszystkich sześciu decyzji
 * (z „Wybierz datę” i „Usuń”), „Pomiń” / „Wstecz”, „Cofnij” w dymku. Kolejka ustalona na starcie
 * (`dailyReviewQueue`), decyzje przez `bulkTaskOps` (jak na webie); na końcu podsumowanie
 * (`dailySummary`) i plan jutra z osią dnia („Ułóż dzień”).
 */
import {
  addDays,
  dailyReviewQueue,
  dailySummary,
  daysBetween,
  localDateTimeAt,
  needsDecision,
  plural,
  PRIORITY,
  relativeDay,
  reviewStats,
  type ReviewAction,
} from '@taskplanner/core';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DayPlanCard } from '@/components/day-plan';
import { pickDate } from '@/components/pickers';
import { DecisionButtons, useDecide, useReviewSession, type LogEntry, type ReviewKindKey } from '@/components/review';
import { TaskRow } from '@/components/task-row';
import { Button, Section, usePalette } from '@/components/ui';
import { listLabel, useView } from '@/lib/app-data';

/** Próg gestu (px) — krótsze przesunięcie wraca na miejsce. */
const SWIPE = 90;

type Swipe = 'right' | 'left' | 'up' | 'down';
const SWIPE_ACTION: Record<Swipe, ReviewAction> = { right: { kind: 'done' }, left: { kind: 'tomorrow' }, up: { kind: 'today' }, down: { kind: 'someday' } };

export default function DailyReviewScreen() {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { data, today, ctx } = useView();
  const decide = useDecide();
  const finish = useReviewSession('daily', today);
  // Kolejka ustalona na starcie — przesunięte na jutro nie wracają, a „Wstecz” trafia w to samo zadanie.
  const [queue] = useState(() => dailyReviewQueue(data.tasks, ctx));
  const [index, setIndex] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [started] = useState(() => Date.now());
  const done = index >= queue.length;
  const item = queue[index];
  const task = item ? (data.tasks.find((t) => t.id === item.task.id) ?? item.task) : undefined;

  const apply = (action: ReviewAction) => {
    if (!task || !item) return;
    const decided = decide(task, action);
    if (decided || action.kind === 'today') setLog((l) => [...l, { task: item.task, action }]);
    setIndex((i) => i + 1);
  };
  const pick = async (kind: ReviewKindKey) => {
    if (kind !== 'date') return apply({ kind } as ReviewAction);
    const date = await pickDate({ title: 'Nowy termin', value: addDays(today, 2), today });
    if (date) apply({ kind: 'date', date });
  };

  useEffect(() => {
    if (done) finish(log);
  }, [done, finish, log]);

  // Gest na karcie — PanResponder z najnowszą decyzją (ref), animacja odjazdu karty.
  const [position] = useState(() => new Animated.ValueXY());
  const latest = useRef({ apply, series: false });
  useEffect(() => {
    latest.current = { apply, series: !!task?.recurrence };
  });
  // Ref czytany tylko w obsłudze gestu, nie w renderze.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8,
      onPanResponderMove: Animated.event([null, { dx: position.x, dy: position.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        const horizontal = Math.abs(g.dx) >= Math.abs(g.dy);
        const swipe: Swipe | null = horizontal ? (g.dx > SWIPE ? 'right' : g.dx < -SWIPE ? 'left' : null) : g.dy < -SWIPE ? 'up' : g.dy > SWIPE ? 'down' : null;
        if (!swipe || (swipe === 'down' && latest.current.series)) {
          Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
          return;
        }
        void Haptics.selectionAsync().catch(() => undefined);
        const to = { x: swipe === 'right' ? width : swipe === 'left' ? -width : 0, y: swipe === 'up' ? -600 : swipe === 'down' ? 600 : 0 };
        Animated.timing(position, { toValue: to, duration: 160, useNativeDriver: false }).start(() => {
          latest.current.apply(SWIPE_ACTION[swipe]);
          position.setValue({ x: 0, y: 0 });
        });
      },
      onPanResponderTerminate: () => Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start(),
    }),
  );

  if (done) return <DailyDone log={log} total={queue.length} started={started} />;

  const rotate = position.x.interpolate({ inputRange: [-width, 0, width], outputRange: ['-12deg', '0deg', '12deg'] });
  const fade = (value: Animated.Value, inputRange: number[], outputRange: number[]) => value.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
  const overdueDays = task?.dueDate ? daysBetween(task.dueDate, today) : 0;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title: 'Przegląd dnia' }} />
      <View style={styles.progressRow}>
        <Text style={{ color: p.muted, fontSize: 13 }}>
          {index + 1} / {queue.length}
        </Text>
        <View style={[styles.progress, { backgroundColor: p.border }]}>
          <View style={{ width: `${(index / Math.max(1, queue.length)) * 100}%`, height: '100%', backgroundColor: p.accent }} />
        </View>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setIndex(queue.length)}>
          <Text style={{ color: p.accent, fontSize: 13 }}>Zakończ</Text>
        </Pressable>
      </View>

      <View style={styles.stage}>
        <Animated.Text style={[styles.hint, styles.hintRight, { color: p.ok, opacity: fade(position.x, [20, SWIPE], [0, 1]) }]}>✓ Ukończ</Animated.Text>
        <Animated.Text style={[styles.hint, styles.hintLeft, { color: p.accent, opacity: fade(position.x, [-SWIPE, -20], [1, 0]) }]}>← Jutro</Animated.Text>
        <Animated.Text style={[styles.hint, styles.hintUp, { color: p.accent, opacity: fade(position.y, [-SWIPE, -20], [1, 0]) }]}>↑ Dziś</Animated.Text>
        <Animated.Text style={[styles.hint, styles.hintDown, { color: p.muted, opacity: fade(position.y, [20, SWIPE], [0, 1]) }]}>↓ Kiedyś</Animated.Text>
        {task && item ? (
          <Animated.View
            {...responder.panHandlers}
            accessibilityLabel={`${task.title}. Przesuń w prawo — ukończ, w lewo — jutro, w górę — dziś, w dół — kiedyś`}
            style={[styles.card, { backgroundColor: p.card, borderColor: p.border, transform: [{ translateX: position.x }, { translateY: position.y }, { rotate }] }]}
          >
            <Text style={[styles.section, { color: item.section === 'overdue' ? p.bad : p.muted }]}>
              {item.section === 'overdue' ? `Zaległe · ${plural(overdueDays, ['dzień', 'dni', 'dni'])}` : 'Na dziś'}
            </Text>
            <View style={styles.titleRow}>
              <View style={[styles.dot, { backgroundColor: PRIORITY[task.priority].color }]} />
              <Pressable style={{ flex: 1 }} onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })}>
                <Text style={{ color: p.fg, fontSize: 20, fontWeight: '600' }}>{task.title}</Text>
              </Pressable>
            </View>
            <Text style={{ color: p.muted, fontSize: 14 }}>
              {listLabel(data, task.listId)}
              {task.dueDate ? ` · ${relativeDay(task.dueDate, today)}` : ''}
              {task.dueTime ? ` ${task.dueTime}` : ''}
              {task.recurrence ? ' · seria' : ''}
            </Text>
            {needsDecision(task) ? (
              <Text style={[styles.warn, { color: '#92400e', backgroundColor: '#fef3c7' }]}>Przesuwane {task.postponeCount} razy — zrób, zmniejsz albo usuń.</Text>
            ) : null}
            <Text style={{ color: p.muted, fontSize: 12, marginTop: 'auto' }}>→ ukończ · ← jutro · ↑ dziś · ↓ kiedyś</Text>
          </Animated.View>
        ) : null}
      </View>

      <View style={[styles.bottom, { paddingBottom: 16 + insets.bottom }]}>
        <DecisionButtons onPick={(k) => void pick(k)} disabled={task?.recurrence ? ['someday'] : []} />
        <View style={styles.nav}>
          <Button kind="secondary" title="← Wstecz" disabled={index === 0} onPress={() => setIndex((i) => Math.max(0, i - 1))} />
          <Button kind="secondary" title="Pomiń →" onPress={() => setIndex((i) => i + 1)} />
        </View>
      </View>
    </View>
  );
}

function DailyDone({ log, total, started }: { log: LogEntry[]; total: number; started: number }) {
  const [seconds] = useState(() => Math.round((Date.now() - started) / 1000));
  const p = usePalette();
  const { data, today, ctx, workspaceId } = useView();
  const stats = reviewStats(log, ctx);
  const summary = dailySummary(data.tasks, ctx);
  // Przegląd rano → plan na dziś, po południu i wieczorem → na jutro (przełącznik pod listą).
  const [onToday, setOnToday] = useState(() => localDateTimeAt(new Date(), ctx.timeZone).slice(11) < '12:00');
  const plan = onToday ? summary.today : summary.tomorrow;
  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.doneBody}>
      <Stack.Screen options={{ title: 'Przegląd dnia' }} />
      <Text style={{ color: p.fg, fontSize: 20, fontWeight: '600' }}>{total ? 'Przegląd zakończony' : 'Nic do przejrzenia — brak zaległych i dzisiejszych zadań.'}</Text>
      {total ? (
        <Text style={{ color: p.muted }}>
          {stats.reviewed} z {total} · ukończone {stats.done} · przesunięte {stats.rescheduled} · kiedyś {stats.someday} · usunięte {stats.deleted} · {seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`}
        </Text>
      ) : null}
      <Section title={`Ukończone dziś · ${summary.doneToday.length}`}>
        {summary.doneToday.slice(0, 20).map((t) => (
          <Text key={t.id} style={{ color: p.muted }} numberOfLines={1}>
            ✓ {t.title}
          </Text>
        ))}
      </Section>
      <Section title={`Plan na ${onToday ? 'dziś' : 'jutro'} · ${plan.length}`}>
        <View style={{ marginHorizontal: -12 }}>
          {plan.map((t) => (
            <TaskRow key={t.id} task={t} today={today} showDate={false} listName={listLabel(data, t.listId)} />
          ))}
        </View>
        {!plan.length ? <Text style={{ color: p.muted }}>{onToday ? 'Na dziś nic więcej nie ma.' : 'Na jutro nic nie ma.'}</Text> : null}
        <Pressable onPress={() => setOnToday((v) => !v)} hitSlop={8} accessibilityRole="button">
          <Text style={{ color: p.accent, marginTop: 6 }}>Pokaż plan na {onToday ? 'jutro' : 'dziś'}</Text>
        </Pressable>
      </Section>
      <View style={{ marginHorizontal: -12 }}>
        <DayPlanCard key={onToday ? 'today' : 'tomorrow'} data={data} today={today} workspaceId={workspaceId} initial={onToday ? today : addDays(today, 1)} />
      </View>
      <Button title="Gotowe" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  progress: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  stage: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
  card: { minHeight: 240, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 18, gap: 8, elevation: 4 },
  section: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 9 },
  warn: { borderRadius: 8, padding: 8, fontSize: 13 },
  hint: { position: 'absolute', top: 20, fontSize: 16, fontWeight: '700' },
  hintRight: { left: 24 },
  hintLeft: { right: 24 },
  hintUp: { top: 0, alignSelf: 'center' },
  hintDown: { top: undefined, bottom: 0, alignSelf: 'center' },
  bottom: { padding: 16, gap: 12 },
  nav: { flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  doneBody: { padding: 16, gap: 12, paddingBottom: 48 },
});
