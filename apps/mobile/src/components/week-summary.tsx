/**
 * Krok „Podsumowanie” przeglądu tygodnia (v1.x), jak na webie (`week-summary.tsx`): liczby z core `weekFacts`
 * (zawsze, także offline i bez konta AI) i „✨ Opisz tydzień” — zdania, w których liczby wstawia kod, oraz sugestie
 * przypięte do zadań (dotknięcie = zwykła decyzja przeglądu z „Cofnij”). Opis zapisuje dopiero „Zakończ przegląd”.
 */
import {
  addDays,
  AI_HINT_MAX,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  aiWeekSummaryNote,
  dayMonth,
  localDateAt,
  nextWeekNote,
  relativeDay,
  REVIEW_ACTION,
  reviewSummary,
  WEEK_SUMMARY,
  weekFactList,
  weekFacts,
  weekFactsFrom,
  weekFactTexts,
  weekSuggestionActive,
  weekSummaryFromAi,
  weekSummaryRequest,
  type ReviewAction,
  type ViewContext,
  type ViewTask,
  type WeekFact,
  type WeeklyReview,
  type WeekSummary,
} from '@taskplanner/core';
import type { SqlRow } from '@taskplanner/sync';
import { useNetworkState } from 'expo-network';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { askWeekSummary, useAiAccount } from '@/lib/ai';
import { listEditable, listLabel, type AppData } from '@/lib/app-data';
import { useFocusData } from '@/lib/focus';
import { useLocalQuery } from '@/lib/local-query';

import { Chip, P, Row, usePalette } from './ui';

interface Props {
  data: AppData;
  ctx: ViewContext;
  review: WeeklyReview;
  summary: WeekSummary | null;
  onSummary: (summary: WeekSummary | null) => void;
  onAct: (task: ViewTask, action: ReviewAction) => void;
}

function Rows({ title, facts }: { title: string; facts: readonly WeekFact[] }) {
  const p = usePalette();
  if (!facts.length) return null;
  return (
    <View style={styles.group}>
      <Text style={[styles.h3, { color: p.muted }]}>{title}</Text>
      {facts.map((f) => (
        <View key={f.key} style={styles.row}>
          <Text style={{ color: p.fg, flex: 1 }} numberOfLines={1}>
            {f.label}
          </Text>
          <Text style={{ color: p.fg }}>{f.value}</Text>
        </View>
      ))}
    </View>
  );
}

export function WeekSummaryStep({ data, ctx, review, summary, onSummary, onAct }: Props) {
  const p = usePalette();
  const { entries } = useFocusData();
  const account = useAiAccount();
  const online = useNetworkState().isConnected !== false;
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Trwający wpis skupienia liczy się do chwili wejścia w krok.
  const [now] = useState(() => new Date());
  const since = addDays(weekFactsFrom(ctx.today), -2);

  const series = useLocalQuery(
    ['task_completions', 'tasks'],
    (engine) =>
      engine.db.all<SqlRow>(
        `select c.task_id, c.completed_at from task_completions c join tasks t on t.id = c.task_id
           where c.deleted_at is null and c.kind = 'done' and t.kind = 'task' and t.deleted_at is null and c.completed_at >= ?`,
        [since],
      ),
    [since],
  );
  const sessions = useLocalQuery(['review_sessions'], (engine) =>
    engine.db.all<SqlRow>(
      "select finished_at, stats from review_sessions where deleted_at is null and kind = 'weekly' and finished_at is not null and stats is not null order by finished_at desc limit 20",
    ),
  );

  const facts = useMemo(
    () =>
      weekFacts(
        {
          tasks: data.tasks,
          seriesDone: (series ?? []).map((r) => ({ taskId: String(r.task_id), completedAt: String(r.completed_at) })),
          habitCompletions: data.habitCompletions,
          timeEntries: entries,
          workHours: data.settings.workHours,
          now,
        },
        ctx,
      ),
    [data.tasks, data.habitCompletions, data.settings.workHours, series, entries, now, ctx],
  );
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const listName = (id: string) => listLabel(data, id);
  const texts = weekFactTexts(facts, { list: listName, task: (id) => byId.get(id)?.title ?? '' });
  const note = nextWeekNote(facts);
  const canEdit = (task: ViewTask) => listEditable(data, task.listId);
  const previous = (sessions ?? []).flatMap((r) => {
    const text = reviewSummary(r.stats);
    return text && text !== summary?.text ? [{ text, date: localDateAt(String(r.finished_at), ctx.timeZone) }] : [];
  })[0];

  const ask = async () => {
    if (busy || !online || !aiAccountReady(account)) return;
    const list = weekFactList(texts);
    const query = weekSummaryRequest({ accountId: account.id, from: facts.from, today: ctx.today, facts: list, doneTaskIds: facts.doneTaskIds, tasks: data.tasks, review, canEdit, listName, hint });
    setBusy(true);
    setError(null);
    try {
      const result = weekSummaryFromAi(await askWeekSummary(query.request), query, { facts: list, tasks: data.tasks, canEdit, ctx });
      if (result) onSummary(result);
      else setError(WEEK_SUMMARY.invalid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const suggestions = (summary?.suggestions ?? []).flatMap((s) => {
    const task = byId.get(s.taskId);
    return task && weekSuggestionActive(task, s, ctx) ? [{ ...s, task }] : [];
  });

  return (
    <>
      <P muted>
        {dayMonth(facts.from)} – {dayMonth(facts.to)}
      </P>
      <View style={styles.tiles}>
        {texts.main.map((f) => (
          <View key={f.key} style={[styles.tile, f.key === 'pelnyDzien' && styles.wide, { borderColor: p.border, backgroundColor: p.card }]}>
            <Text style={{ color: p.muted, fontSize: 12 }}>{f.label}</Text>
            <Text style={{ color: p.fg, fontSize: 18, fontWeight: '600' }}>{f.value}</Text>
          </View>
        ))}
      </View>
      {note ? <P muted>Następne 7 dni: {note}.</P> : null}
      <Rows title={WEEK_SUMMARY.lists} facts={texts.lists} />
      <Rows title={WEEK_SUMMARY.habits} facts={texts.habits} />

      {aiAccountReady(account) ? (
        <View style={[styles.box, { borderColor: p.border }]}>
          <TextInput
            value={hint}
            onChangeText={setHint}
            maxLength={AI_HINT_MAX}
            placeholder={WEEK_SUMMARY.hint}
            placeholderTextColor={p.muted}
            accessibilityLabel="Wskazówka dla AI"
            editable={!busy}
            returnKeyType="send"
            onSubmitEditing={() => void ask()}
            style={[styles.input, { color: p.fg, borderColor: p.border }]}
          />
          <Row>
            <Chip label={busy ? WEEK_SUMMARY.busy : summary ? WEEK_SUMMARY.again : WEEK_SUMMARY.ai} disabled={busy || !online} onPress={() => void ask()} />
            {online ? null : <P muted>{AI_NEEDS_NETWORK}</P>}
          </Row>
          <P muted>{aiWeekSummaryNote(account.provider)}</P>
          {error ? <P tone="bad">{error}</P> : null}
        </View>
      ) : null}

      {summary ? (
        <View style={[styles.box, styles.dashed, { borderColor: p.accent }]}>
          <Text style={{ color: p.fg, fontSize: 15, lineHeight: 21 }}>{summary.text}</Text>
          <P muted>{WEEK_SUMMARY.saved}</P>
          <Row>
            <Chip label={WEEK_SUMMARY.discard} disabled={busy} onPress={() => onSummary(null)} />
          </Row>
          {suggestions.map((s) => (
            <View key={s.taskId} style={styles.row}>
              <Pressable accessibilityRole="button" style={styles.title} onPress={() => router.push({ pathname: '/task/[id]', params: { id: s.taskId } })}>
                <Text style={{ color: p.fg, fontWeight: '600' }} numberOfLines={2}>
                  {s.task.title}
                </Text>
                {s.reason ? <Text style={{ color: p.muted, fontSize: 12 }}>{s.reason}</Text> : null}
              </Pressable>
              <Chip label={s.action.kind === 'date' ? relativeDay(s.action.date, ctx.today) : REVIEW_ACTION[s.action.kind].label} onPress={() => onAct(s.task, s.action)} />
            </View>
          ))}
        </View>
      ) : null}

      {previous ? (
        <View style={styles.group}>
          <Text style={[styles.h3, { color: p.muted }]}>
            {WEEK_SUMMARY.previous} ({dayMonth(previous.date)})
          </Text>
          <Text style={{ color: p.fg }}>{previous.text}</Text>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '48.5%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10 },
  wide: { width: '100%' },
  group: { gap: 4 },
  h3: { fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  dashed: { borderWidth: 1, borderStyle: 'dashed' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 15 },
  title: { flex: 1, minWidth: 0 },
});
