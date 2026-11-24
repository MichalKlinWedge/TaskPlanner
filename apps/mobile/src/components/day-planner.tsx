/**
 * „Ułóż dzień” (v1.x) w „Planie dnia”, jak na webie (`day-planner.tsx`): zadania na ten dzień i zaległe → szkic
 * bloków w wolnych oknach godzin pracy (core `autoPlanDay`, offline i bez konta AI) albo „✨ Ułóż z AI”
 * z preferencją tekstem (godziny od modelu sprawdza `dayPlanFromAi`). Zapis dopiero po „Zastosuj” (`dayPlanOps`,
 * jedna transakcja z „Cofnij”).
 */
import {
  addDays,
  AI_HINT_MAX,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  aiDayPlanNote,
  aiPlanFixedNote,
  autoPlanDay,
  blocksForDay,
  BUFFER_CHOICES,
  bulkTaskOps,
  DAY_PLANNER,
  dayPlanFromAi,
  dayPlanOps,
  dayPlanRequest,
  DEFAULT_BUFFER_MIN,
  draftMinutes,
  formatMinutes,
  habitSlots,
  isOpen,
  plural,
  seriesNote,
  UNPLACED_REASON,
  withoutBlock,
  type CalendarEventLike,
  type DayPlanDraft,
  type LocalDate,
} from '@taskplanner/core';
import { useNetworkState } from 'expo-network';
import Storage from 'expo-sqlite/kv-store';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { askDayPlan, useAiAccount } from '@/lib/ai';
import { listEditable, type AppData } from '@/lib/app-data';
import { useDependencies } from '@/lib/dependencies';

import { useTaskActions } from './actions';
import { pickOption } from './pickers';
import { Button, Chip, P, Row, usePalette } from './ui';

/** Szkic w podglądzie; `rejected` — ile godzin od AI poprawił kod. */
export interface PlanPreview extends DayPlanDraft {
  ai: boolean;
  workspaceId: string | null;
  rejected: number;
}

const BUFFER_KEY = 'plan.buffer';
const tasksLabel = (n: number) => plural(n, ['zadanie', 'zadania', 'zadań']);
const bufferLabel = (n: number) => (n ? `${n} min` : 'brak');

function storedBuffer(): number {
  const raw = Storage.getItemSync(BUFFER_KEY);
  const value = raw === null ? NaN : Number(raw);
  return (BUFFER_CHOICES as readonly number[]).includes(value) ? value : DEFAULT_BUFFER_MIN;
}

interface Props {
  data: AppData;
  date: LocalDate;
  today: LocalDate;
  workspaceId: string | null;
  events: readonly CalendarEventLike[];
  /** Minuta „teraz” układanego dnia. */
  nowMin: number;
  preview: PlanPreview | null;
  onPreview: (preview: PlanPreview | null) => void;
  onOpen: (taskId: string) => void;
}

export function DayPlanner({ data, date, today, workspaceId, events, nowMin, preview, onPreview, onOpen }: Props) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const deps = useDependencies();
  const account = useAiAccount();
  const online = useNetworkState().isConnected !== false;
  const [buffer, setBuffer] = useState(storedBuffer);
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { timeZone, defaultDurationMin, workHours } = data.settings;

  /** Dane układania: zajętość liczy się ze wszystkich przestrzeni, zadania — z bieżącej. */
  const input = (bufferMin: number) => {
    const habits = habitSlots(data.tasks, data.habitCompletions, date, addDays(date, 1), today);
    const plan = blocksForDay(data.tasks.filter((t) => t.kind === 'task'), events, date, { timeZone, defaultDurationMin, habits });
    const options = {
      date,
      today,
      workspaceId,
      canEdit: (t: { listId: string }) => listEditable(data, t.listId),
      deps,
      nowMin: date === today ? nowMin : null,
      defaultDurationMin,
      bufferMin,
      timeZone,
    };
    return { plan, options };
  };

  const auto = (bufferMin = buffer) => {
    const { plan, options } = input(bufferMin);
    setError(null);
    onPreview({ ...autoPlanDay(data.tasks, plan, workHours, options), workspaceId, ai: false, rejected: 0 });
  };

  const pickBuffer = async () => {
    const value = await pickOption<number>('Przerwa między blokami', BUFFER_CHOICES.map((n) => ({ label: bufferLabel(n), value: n, selected: n === buffer })));
    if (value === undefined) return;
    setBuffer(value);
    Storage.setItemSync(BUFFER_KEY, String(value));
    auto(value);
  };

  const ask = async () => {
    if (busy || !online || !aiAccountReady(account)) return;
    const { plan, options } = input(buffer);
    const built = dayPlanRequest(data.tasks, plan, workHours, options, { accountId: account.id, hint });
    if (!built) return setError(DAY_PLANNER.noSlots);
    setBusy(true);
    setError(null);
    try {
      const draft = dayPlanFromAi(await askDayPlan(built.request), built.ids, data.tasks, plan, workHours, options);
      onPreview({ ...draft, workspaceId, ai: true, rejected: draft.rejected.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!preview) {
    return (
      <Row>
        <Chip label={DAY_PLANNER.button} onPress={() => auto()} />
      </Row>
    );
  }

  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const unplaced = preview.unplaced.flatMap((u) => {
    const task = byId.get(u.taskId);
    return task && isOpen(task) ? [{ ...u, task }] : [];
  });
  const nothing = !preview.blocks.length && !unplaced.length;

  const apply = () => {
    const result = dayPlanOps(preview, data.tasks);
    if (!result.count) return notify(DAY_PLANNER.stale);
    void run(result.ops, { text: `Ułożono ${tasksLabel(result.count)} (${formatMinutes(draftMinutes(preview))})`, undo: result.undo });
    onPreview(unplaced.length ? { ...preview, blocks: [], rejected: 0 } : null);
  };

  const postpone = () => {
    const { ops, undo } = bulkTaskOps(unplaced.map((u) => u.task), data.tasks, { kind: 'date', date: addDays(date, 1) }, { today, now: new Date(), timeZone });
    void run(ops, { text: `Przełożono ${tasksLabel(unplaced.length)} na ${date === today ? 'jutro' : 'następny dzień'}`, undo });
    onPreview(preview.blocks.length ? { ...preview, unplaced: [] } : null);
  };

  return (
    <View style={[styles.box, { borderColor: p.border }]} accessibilityLabel="Układanie dnia">
      <Row>
        <Chip label={`${DAY_PLANNER.buffer}: ${bufferLabel(buffer)}`} disabled={busy} onPress={() => void pickBuffer()} />
        {preview.ai ? <Chip label={DAY_PLANNER.auto} disabled={busy} onPress={() => auto()} /> : null}
        <Chip label={DAY_PLANNER.discard} disabled={busy} onPress={() => onPreview(null)} />
      </Row>
      {aiAccountReady(account) && !nothing && preview.workday ? (
        <>
          <TextInput
            value={hint}
            onChangeText={setHint}
            maxLength={AI_HINT_MAX}
            placeholder={DAY_PLANNER.hint}
            placeholderTextColor={p.muted}
            accessibilityLabel="Preferencja dla AI"
            editable={!busy}
            returnKeyType="send"
            onSubmitEditing={() => void ask()}
            style={[styles.input, { color: p.fg, borderColor: p.border }]}
          />
          <Row>
            <Chip label={busy ? DAY_PLANNER.busy : DAY_PLANNER.ai} disabled={busy || !online} onPress={() => void ask()} />
            {online ? null : <P muted>{AI_NEEDS_NETWORK}</P>}
          </Row>
          <P muted>{aiDayPlanNote(account.provider)}</P>
        </>
      ) : null}
      {error ? <P tone="bad">{error}</P> : null}
      {!preview.workday ? <P muted>{DAY_PLANNER.dayOff}</P> : nothing ? <P muted>{DAY_PLANNER.nothing}</P> : null}
      {preview.rejected ? <P muted>{aiPlanFixedNote(preview.rejected)}</P> : null}
      {preview.series ? <P muted>{seriesNote(preview.series)}</P> : null}
      {preview.blocks.map((b) => (
        <View key={b.taskId} style={styles.row}>
          <Pressable accessibilityRole="button" onPress={() => onOpen(b.taskId)} style={styles.title}>
            <Text style={{ color: p.fg, fontSize: 13 }} numberOfLines={1}>
              {b.start}–{b.end} {byId.get(b.taskId)?.title}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`${DAY_PLANNER.remove}: ${byId.get(b.taskId)?.title ?? ''}`} hitSlop={10} onPress={() => onPreview(withoutBlock(preview, b.taskId))}>
            <Text style={{ color: p.muted, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>
      ))}
      {unplaced.length ? (
        <>
          <Text style={{ color: p.fg, fontSize: 13, fontWeight: '700' }}>
            {DAY_PLANNER.unplaced} ({unplaced.length})
          </Text>
          {unplaced.map((u) => (
            <View key={u.taskId} style={styles.row}>
              <Pressable accessibilityRole="button" onPress={() => onOpen(u.taskId)} style={styles.title}>
                <Text style={{ color: p.fg, fontSize: 13 }} numberOfLines={1}>
                  {u.task.title}
                </Text>
              </Pressable>
              <Text style={{ color: p.muted, fontSize: 12 }}>
                {u.task.durationMin ? `${formatMinutes(u.task.durationMin)} · ` : ''}
                {UNPLACED_REASON[u.reason]}
              </Text>
            </View>
          ))}
        </>
      ) : null}
      <Row>
        {preview.blocks.length ? <Button title={`${DAY_PLANNER.apply} (${tasksLabel(preview.blocks.length)})`} disabled={busy} onPress={apply} /> : null}
        {unplaced.length ? <Button kind="secondary" title={`${date === today ? DAY_PLANNER.postpone : DAY_PLANNER.postponeNext} (${unplaced.length})`} disabled={busy} onPress={postpone} /> : null}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, minWidth: 0 },
});
