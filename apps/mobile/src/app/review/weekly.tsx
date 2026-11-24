/**
 * Przegląd tygodnia (Etap 9, M16) — siedem kroków jak `#/review/weekly` na webie: Inbox do zera
 * (z „Przenieś do…”), zaległe, aktywne projekty bez następnego kroku, „oczekuje” > 7 dni,
 * nadchodzący tydzień, nawyki z 7 dni, podsumowanie (`WeekSummaryStep`). Kroki i liczniki — `weeklyReview` z core, decyzje przy
 * każdym zadaniu przez `bulkTaskOps` (z „Cofnij”), na końcu podsumowanie i zapis `review_sessions`.
 * Chipy filtra zawężają zadania w krokach Inbox, Zaległe, Oczekuje i Nadchodzący tydzień (projekty
 * i nawyki zostają całe); filtr trwa do opuszczenia ekranu, podsumowanie liczy wszystko.
 */
import {
  addDays,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  bulkTaskOps,
  capitalized,
  dayLabel,
  isEmptyFilter,
  matchesFilter,
  needsDecision,
  plural,
  PRIORITY,
  relativeDay,
  reviewStats,
  WEEK_SUMMARY,
  weeklyReview,
  type FilterQuery,
  type ReviewAction,
  type ViewTask,
  type WeekSummary,
} from '@taskplanner/core';
import { useNetworkState } from 'expo-network';
import { router, Stack } from 'expo-router';
import { useCallback, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { STATE_LABEL, useStateColors } from '@/components/habits';
import { pickDate, pickOption } from '@/components/pickers';
import { QuickAddField } from '@/components/quick-add-field';
import { DecisionButtons, useDecide, useReviewSession, type LogEntry, type ReviewKindKey } from '@/components/review';
import { Button, Chip, ColorDot, usePalette } from '@/components/ui';
import { WeekSummaryStep } from '@/components/week-summary';
import { useAiAccount } from '@/lib/ai';
import { listLabel, useView } from '@/lib/app-data';

const STEPS = [
  { id: 'inbox', title: 'Inbox do zera' },
  { id: 'overdue', title: 'Zaległe' },
  { id: 'projects', title: 'Projekty bez następnego kroku' },
  { id: 'waiting', title: 'Oczekuje > 7 dni' },
  { id: 'upcoming', title: 'Nadchodzący tydzień' },
  { id: 'habits', title: 'Cykliczne w tygodniu' },
  { id: 'summary', title: WEEK_SUMMARY.step },
] as const;
type Step = (typeof STEPS)[number]['id'];
/** Kroki z pojedynczymi zadaniami — tylko w nich działa filtr. */
const FILTERED: readonly Step[] = ['inbox', 'overdue', 'waiting', 'upcoming'];

export default function WeeklyReviewScreen() {
  const p = usePalette();
  const colors = useStateColors();
  const insets = useSafeAreaInsets();
  const { data, today, ctx } = useView();
  const decide = useDecide();
  const { run } = useTaskActions();
  const finish = useReviewSession('weekly', today);
  const [step, setStep] = useState<Step>('inbox');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [finished, setFinished] = useState(false);
  const [summary, setSummary] = useState<WeekSummary | null>(null);
  const [askWeek, setAskWeek] = useState(false);
  const onAskStarted = useCallback(() => setAskWeek(false), []);
  const account = useAiAccount();
  const online = useNetworkState().isConnected !== false;
  const [filter, setFilter] = useState<FilterQuery>({});
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const lists = useMemo(() => data.lists.map((l) => ({ id: l.id, workspaceId: l.workspaceId, kind: l.kind, status: l.projectStatus })), [data.lists]);
  const full = useMemo(() => weeklyReview({ tasks: data.tasks, lists, completions: data.habitCompletions }, ctx), [data.tasks, lists, data.habitCompletions, ctx]);
  // Filtr po wyliczeniu kroków: projekt nie staje się „bez następnego kroku”, bo filtr ukrył jego zadania.
  const review = useMemo(() => {
    if (isEmptyFilter(filter)) return full;
    const match = matchesFilter(filter, today);
    return {
      ...full,
      inbox: full.inbox.filter(match),
      overdue: full.overdue.filter(match),
      waiting: full.waiting.filter((w) => match(w.task)),
      needsDecision: full.needsDecision.filter(match),
      upcoming: { ...full.upcoming, days: full.upcoming.days.map((d) => ({ ...d, items: d.items.filter((it) => match(it.task)) })) },
    };
  }, [full, filter, today]);
  const counts: Record<Step, number> = {
    inbox: review.inbox.length,
    overdue: review.overdue.length,
    projects: review.projectsWithoutNext.length,
    waiting: review.waiting.length,
    upcoming: review.upcoming.days.reduce((n, d) => n + d.items.length, 0),
    habits: review.habits.length,
    summary: 0,
  };
  const at = STEPS.findIndex((s) => s.id === step);
  const go = (s: Step) => {
    setStep(s);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };

  const act = (task: ViewTask, action: ReviewAction) => {
    if (decide(task, action)) setLog((l) => [...l, { task, action }]);
  };
  const pickFor = (task: ViewTask) => async (kind: ReviewKindKey) => {
    if (kind !== 'date') return act(task, { kind } as ReviewAction);
    const date = await pickDate({ title: 'Nowy termin', value: addDays(today, 2), today, firstDayOfWeek: data.settings.firstDayOfWeek });
    if (date) act(task, { kind: 'date', date });
  };
  const move = async (task: ViewTask) => {
    const target = await pickOption(
      'Przenieś do listy',
      data.lists.filter((l) => l.workspaceId === task.workspaceId && l.kind !== 'inbox').map((l) => ({ label: listLabel(data, l.id), value: l.id })),
    );
    if (!target) return;
    const { ops, undo } = bulkTaskOps([task], data.tasks, { kind: 'move', listId: target }, { today, now: new Date(), timeZone: ctx.timeZone });
    void run(ops, { text: `„${task.title}” → ${data.lists.find((l) => l.id === target)?.name}`, undo });
    setLog((l) => [...l, { task, action: { kind: 'today' } }]);
  };

  const empty = (text: string) => <Text style={[styles.empty, { color: p.muted, borderColor: p.border }]}>✓ {text}</Text>;
  const row = (task: ViewTask, extra?: ReactNode) => (
    <View key={task.id} style={[styles.row, { borderColor: p.border }]}>
      <Pressable style={styles.rowHead} onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })}>
        <View style={[styles.dot, { backgroundColor: PRIORITY[task.priority].color }]} />
        <Text style={{ color: p.fg, fontSize: 15, flex: 1 }} numberOfLines={2}>
          {task.title}
        </Text>
        {task.dueDate ? <Text style={{ color: task.dueDate < today ? p.bad : p.muted, fontSize: 12 }}>{relativeDay(task.dueDate, today)}</Text> : null}
      </Pressable>
      {needsDecision(task) ? <Text style={[styles.warn, { color: '#92400e', backgroundColor: '#fef3c7' }]}>{task.postponeCount}× przesuwane</Text> : null}
      <DecisionButtons compact onPick={(k) => void pickFor(task)(k)} disabled={task.recurrence ? ['someday'] : []} />
      {extra}
    </View>
  );

  if (finished) {
    const stats = reviewStats(log, ctx);
    const clean = full.inbox.length === 0 && full.projectsWithoutNext.length === 0;
    return (
      <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={[styles.body, { paddingBottom: 48 + insets.bottom }]}>
        <Stack.Screen options={{ title: 'Przegląd tygodnia — gotowe' }} />
        <View style={styles.stats}>
          {(
            [
              ['Decyzje', stats.reviewed],
              ['Inbox', full.inbox.length],
              ['Projekty bez kroku', full.projectsWithoutNext.length],
              ['Zaległe', full.overdue.length],
            ] as const
          ).map(([label, value]) => (
            <View key={label} style={[styles.stat, { borderColor: p.border, backgroundColor: p.card }]}>
              <Text style={{ color: p.muted, fontSize: 12 }}>{label}</Text>
              <Text style={{ color: p.fg, fontSize: 24, fontWeight: '600' }}>{value}</Text>
            </View>
          ))}
        </View>
        {summary ? <Text style={{ color: p.fg, fontSize: 15, lineHeight: 21 }}>{summary.text}</Text> : null}
        <Text style={{ color: p.fg }}>{clean ? 'Inbox pusty, każdy aktywny projekt ma następny krok.' : 'Zostało coś do uporządkowania — wróć do kroków albo zrób to później.'}</Text>
        <Button title="Gotowe" onPress={() => router.back()} />
        <Button kind="secondary" title="Wróć do kroków" onPress={() => setFinished(false)} />
      </ScrollView>
    );
  }

  let body: ReactNode;
  if (step === 'inbox') {
    body = review.inbox.length
      ? review.inbox.map((t) =>
          row(
            t,
            <Pressable accessibilityRole="button" onPress={() => void move(t)} hitSlop={6}>
              <Text style={{ color: p.accent, fontSize: 13 }}>Przenieś do…</Text>
            </Pressable>,
          ),
        )
      : empty('Inbox pusty.');
  } else if (step === 'overdue') {
    body = review.overdue.length ? review.overdue.map((t) => row(t)) : empty('Nic zaległego.');
  } else if (step === 'projects') {
    body = review.projectsWithoutNext.length
      ? review.projectsWithoutNext.map((pr) => {
          const project = data.lists.find((l) => l.id === pr.id);
          const open = data.tasks.filter((t) => t.listId === pr.id && t.kind === 'task' && (t.status === 'todo' || t.status === 'in_progress' || t.status === 'waiting') && !t.parentId);
          return (
            <View key={pr.id} style={[styles.project, { borderColor: p.border, backgroundColor: p.card }]}>
              <Pressable style={styles.rowHead} onPress={() => router.push({ pathname: '/list/[id]', params: { id: pr.id } })}>
                <ColorDot color={project?.color ?? null} />
                <Text style={{ color: p.fg, fontSize: 15, fontWeight: '600', flex: 1 }}>{project?.name}</Text>
              </Pressable>
              <Text style={{ color: p.muted, fontSize: 12 }}>{plural(open.length, ['otwarte zadanie', 'otwarte zadania', 'otwartych zadań'])} bez terminu</Text>
              {open.slice(0, 5).map((t) => (
                <View key={t.id} style={styles.next}>
                  <Text style={{ color: p.fg, flex: 1 }} numberOfLines={1}>
                    {t.title}
                  </Text>
                  <Chip label="Dziś" onPress={() => act(t, { kind: 'today' })} />
                  <Chip label="Jutro" onPress={() => act(t, { kind: 'tomorrow' })} />
                  <Chip label="+7 dni" onPress={() => act(t, { kind: 'date', date: addDays(today, 7) })} />
                </View>
              ))}
              <View style={{ marginHorizontal: -12 }}>
                <QuickAddField listId={pr.id} dueDate={addDays(today, 1)} placeholder="Następny krok (domyślnie na jutro)…" />
              </View>
            </View>
          );
        })
      : empty('Każdy aktywny projekt ma następny krok.');
  } else if (step === 'waiting') {
    body = review.waiting.length
      ? review.waiting.map(({ task, days }) =>
          row(
            task,
            <View style={styles.next}>
              <Text style={{ color: p.muted, fontSize: 12, flex: 1 }}>oczekuje {plural(days, ['dzień', 'dni', 'dni'])}</Text>
              <Chip
                label="Już nie czeka"
                onPress={() =>
                  void run([{ table: 'tasks', id: task.id, patch: { status: 'todo' } }], {
                    text: `„${task.title}” — do zrobienia`,
                    undo: [{ table: 'tasks', id: task.id, patch: { status: 'waiting' } }],
                  })
                }
              />
            </View>,
          ),
        )
      : empty('Nic nie czeka dłużej niż tydzień.');
  } else if (step === 'upcoming') {
    body = (
      <>
        {review.upcoming.days.map((d) => (
          <View key={d.date} style={[styles.day, { borderColor: p.border }]}>
            <Text style={{ color: p.muted, fontSize: 12, fontWeight: '700' }}>{capitalized(dayLabel(d.date))}</Text>
            {d.items.length ? (
              d.items.map((it) => (
                <Pressable key={`${it.task.id}:${it.date}`} style={[styles.rowHead, { opacity: it.virtual ? 0.6 : 1 }]} onPress={() => router.push({ pathname: '/task/[id]', params: { id: it.task.id } })}>
                  <View style={[styles.dot, { backgroundColor: PRIORITY[it.task.priority].color }]} />
                  <Text style={{ color: p.fg, flex: 1 }} numberOfLines={1}>
                    {it.task.title}
                  </Text>
                  {it.task.dueTime ? <Text style={{ color: p.muted, fontSize: 12 }}>{it.task.dueTime}</Text> : null}
                </Pressable>
              ))
            ) : (
              <Text style={{ color: p.muted, fontSize: 12 }}>—</Text>
            )}
          </View>
        ))}
        <Pressable accessibilityRole="link" onPress={() => router.push('/calendar')}>
          <Text style={{ color: p.accent }}>Otwórz kalendarz →</Text>
        </Pressable>
      </>
    );
  } else if (step === 'summary') {
    body = <WeekSummaryStep data={data} ctx={ctx} review={full} summary={summary} onSummary={setSummary} onAct={act} start={askWeek} onStarted={onAskStarted} />;
  } else {
    body = review.habits.length
      ? review.habits.map(({ task, days }) => (
          <View key={task.id} style={styles.habit}>
            <Text style={{ color: p.fg, flex: 1 }} numberOfLines={1}>
              {task.title}
            </Text>
            {days.map((d) => (
              <View
                key={d.date}
                accessibilityLabel={`${d.date}: ${STATE_LABEL[d.state]}`}
                style={[styles.cell, { backgroundColor: colors[d.state].bg, borderColor: colors[d.state].border ?? 'transparent', borderWidth: colors[d.state].border ? 1 : 0 }]}
              />
            ))}
            <Text style={{ color: p.muted, fontSize: 12, width: 28, textAlign: 'right' }}>{days.filter((d) => d.state === 'done').length}/7</Text>
          </View>
        ))
      : empty('Brak zadań cyklicznych.');
  }

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title: 'Przegląd tygodnia' }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.steps} style={styles.stepBar}>
        {STEPS.map((s, i) => {
          const count = s.id === 'upcoming' || s.id === 'habits' || s.id === 'summary' ? '' : ` ${counts[s.id] || '✓'}`;
          return <Chip key={s.id} label={`${i + 1}. ${s.title}${count}`} selected={s.id === step} onPress={() => go(s.id)} />;
        })}
      </ScrollView>
      <ScrollView ref={scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.h2, { color: p.fg }]}>
          {at + 1}. {STEPS[at]!.title}
        </Text>
        {aiAccountReady(account) && step !== 'summary' ? (
          <View style={styles.next}>
            <Chip
              label={summary ? WEEK_SUMMARY.again : WEEK_SUMMARY.ai}
              disabled={!online}
              onPress={() => {
                setAskWeek(true);
                go('summary');
              }}
            />
            {online ? null : <Text style={{ color: p.muted, fontSize: 12 }}>{AI_NEEDS_NETWORK}</Text>}
          </View>
        ) : null}
        {FILTERED.includes(step) ? <FilterBar query={filter} onChange={setFilter} /> : null}
        {body}
        {review.needsDecision.length && (step === 'overdue' || step === 'inbox') ? (
          <Text style={{ color: p.muted, fontSize: 12 }}>{plural(review.needsDecision.length, ['zadanie przesuwane', 'zadania przesuwane', 'zadań przesuwanych'])} 3 razy lub więcej — oznaczone na żółto.</Text>
        ) : null}
      </ScrollView>
      <View style={[styles.nav, { borderColor: p.border, paddingBottom: 12 + insets.bottom }]}>
        <Button kind="secondary" title="← Wstecz" disabled={at === 0} onPress={() => go(STEPS[at - 1]!.id)} />
        {at < STEPS.length - 1 ? (
          <Button title="Dalej →" onPress={() => go(STEPS[at + 1]!.id)} />
        ) : (
          <Button
            title="Zakończ przegląd"
            onPress={() => {
              finish(log, summary?.text ?? null);
              setFinished(true);
            }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  steps: { gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  stepBar: { flexGrow: 0, flexShrink: 0 },
  body: { padding: 16, gap: 10, paddingBottom: 48 },
  h2: { fontSize: 17, fontWeight: '700' },
  empty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 10, padding: 16, textAlign: 'center' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10, gap: 8 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  warn: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, fontSize: 12 },
  project: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6 },
  next: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  day: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 4 },
  habit: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cell: { width: 18, height: 18, borderRadius: 4 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { width: '48.5%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10 },
  nav: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
