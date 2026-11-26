/**
 * „✨ Rozbij na kroki” (v1.x) na ekranie zadania, jak na webie: wskazówka → szkic kroków od AI na koncie
 * użytkownika → poprawki (tytuł, czas, termin, priorytet, „po poprzednim”) → „Dodaj” (core `breakdownOps`,
 * jedna transakcja z „Cofnij”). Tylko przy sprawdzonym koncie AI; bez sieci nieaktywne. AI niczego samo nie zapisuje.
 */
import {
  AI_BREAKDOWN,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  aiBreakdownNote,
  AI_HINT_MAX,
  breakdownDrafts,
  breakdownDueBounds,
  breakdownMinutes,
  breakdownOps,
  breakdownRequest,
  canBreakDown,
  clampBreakdownDue,
  formatMinutes,
  plural,
  PRIORITY,
  shortDate,
  type AiAccount,
  type BreakdownDraft,
  type LocalDate,
  type ViewTask,
} from '@taskplanner/core';
import { useNetworkState } from 'expo-network';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTaskActions } from './actions';
import { pickDate, pickOption } from './pickers';
import { pickPriority } from './task-menus';
import { Button, Chip, P, Row, usePalette } from './ui';
import { askBreakdown, useAiAccount } from '@/lib/ai';
import type { AppData } from '@/lib/app-data';
import { useDependencies } from '@/lib/dependencies';
import { localEngine } from '@/lib/sync';

const DURATIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 480];
const steps = (n: number) => plural(n, ['krok', 'kroki', 'kroków']);

interface Props {
  task: ViewTask;
  data: AppData;
  today: LocalDate;
}

export function BreakdownField({ task, data, today }: Props) {
  const account = useAiAccount();
  const online = useNetworkState().isConnected !== false;
  const [open, setOpen] = useState(false);
  if (!aiAccountReady(account) || !canBreakDown(data.tasks, task)) return null;
  if (!open) {
    return (
      <Row>
        <Chip label={AI_BREAKDOWN.button} disabled={!online} onPress={() => setOpen(true)} />
        {online ? null : <P muted>{AI_NEEDS_NETWORK}</P>}
      </Row>
    );
  }
  return <BreakdownForm task={task} data={data} today={today} account={account} online={online} onClose={() => setOpen(false)} />;
}

function BreakdownForm({ task, data, today, account, online, onClose }: Props & { account: AiAccount; online: boolean; onClose: () => void }) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const deps = useDependencies();
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<BreakdownDraft[] | null>(null);

  const ask = async () => {
    if (busy || !online) return;
    setBusy(true);
    setError(null);
    try {
      const engine = await localEngine();
      const [row] = await engine.db.all<{ description_md: string | null }>('select description_md from tasks where id = ?', [task.id]);
      const result = await askBreakdown(breakdownRequest(task, { accountId: account.id, tasks: data.tasks, description: row?.description_md ?? null, hint, today }));
      setDrafts(breakdownDrafts(result.steps, task, { tasks: data.tasks, today }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const patch = (key: string, change: Partial<BreakdownDraft>) => setDrafts((list) => list?.map((d) => (d.key === key ? { ...d, ...change } : d)) ?? null);
  const chosen = drafts?.filter((d) => d.selected && d.title.trim()).length ?? 0;

  const apply = () => {
    const result = drafts && breakdownOps(drafts, task.id, { tasks: data.tasks, deps, today, now: new Date() });
    if (!result) return notify(AI_BREAKDOWN.blocked);
    void run(result.ops, { text: `Dodano ${steps(result.count)} do „${task.title}”`, undo: result.undo });
    onClose();
  };

  const pickDuration = async (d: BreakdownDraft) => {
    const values = [...new Set([...DURATIONS, ...(d.durationMin ? [d.durationMin] : [])])].sort((a, b) => a - b);
    const picked = await pickOption<number>('Czas kroku', [
      { label: 'bez czasu', value: 0, selected: !d.durationMin },
      ...values.map((n) => ({ label: formatMinutes(n), value: n, selected: n === d.durationMin })),
    ]);
    if (picked !== undefined) patch(d.key, { durationMin: picked || null });
  };
  // Jak pole daty na webie (`min` / `max`): od dziś do terminu zadania; data spoza zakresu wraca na jego brzeg.
  const bounds = breakdownDueBounds(task, today);
  const pickDue = async (d: BreakdownDraft) => {
    const date = await pickDate({ title: bounds.max ? `Termin kroku (do ${shortDate(bounds.max)})` : 'Termin kroku', value: d.dueDate, today, allowNone: true });
    if (date === undefined) return;
    const clamped = clampBreakdownDue(date, task, today);
    if (clamped !== date) notify(clamped === bounds.min ? 'Termin kroku najwcześniej dziś.' : `Termin kroku najpóźniej ${shortDate(clamped!)} — termin zadania.`);
    patch(d.key, { dueDate: clamped });
  };
  const pickStepPriority = async (d: BreakdownDraft) => {
    const priority = await pickPriority('Priorytet kroku', d.priority);
    if (priority) patch(d.key, { priority });
  };

  return (
    <View style={[styles.box, { borderColor: p.border }]}>
      <TextInput
        value={hint}
        onChangeText={setHint}
        maxLength={AI_HINT_MAX}
        placeholder={AI_BREAKDOWN.hint}
        placeholderTextColor={p.muted}
        accessibilityLabel="Wskazówka dla AI"
        editable={!busy}
        returnKeyType="send"
        onSubmitEditing={() => void ask()}
        style={[styles.input, { color: p.fg, borderColor: p.border }]}
      />
      <P muted>{aiBreakdownNote(account.provider)}</P>
      <Row>
        <Button kind={drafts ? 'secondary' : 'primary'} title={busy ? AI_BREAKDOWN.busy : drafts ? AI_BREAKDOWN.again : AI_BREAKDOWN.ask} disabled={busy || !online} onPress={() => void ask()} />
        <Button kind="secondary" title="Anuluj" onPress={onClose} />
      </Row>
      {online ? null : <P muted>{AI_NEEDS_NETWORK}</P>}
      {error ? <P tone="bad">{error}</P> : null}
      {drafts && !drafts.length ? <P muted>{AI_BREAKDOWN.empty}</P> : null}
      {drafts?.length ? (
        <>
          {drafts.map((d, i) => (
            <View key={d.key} style={[styles.step, { borderColor: p.border, opacity: d.selected ? 1 : 0.5 }]}>
              <View style={styles.head}>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: d.selected }}
                  accessibilityLabel={`Dodaj krok: ${d.title}`}
                  hitSlop={10}
                  onPress={() => patch(d.key, { selected: !d.selected })}
                >
                  <Text style={{ color: d.selected ? p.accent : p.muted, fontSize: 20 }}>{d.selected ? '☑' : '☐'}</Text>
                </Pressable>
                <TextInput
                  value={d.title}
                  onChangeText={(title) => patch(d.key, { title })}
                  maxLength={500}
                  accessibilityLabel={`Tytuł kroku ${i + 1}`}
                  style={[styles.input, { flex: 1, color: p.fg, borderColor: p.border }]}
                />
              </View>
              <Row>
                <Chip label={d.durationMin ? formatMinutes(d.durationMin) : 'bez czasu'} onPress={() => void pickDuration(d)} />
                <Chip label={d.dueDate ? shortDate(d.dueDate) : 'bez terminu'} onPress={() => void pickDue(d)} />
                <Chip label={PRIORITY[d.priority].label} onPress={() => void pickStepPriority(d)} />
                {i > 0 ? <Chip label={AI_BREAKDOWN.after} selected={d.afterPrevious} onPress={() => patch(d.key, { afterPrevious: !d.afterPrevious })} /> : null}
              </Row>
            </View>
          ))}
          <P muted>{`Razem ${formatMinutes(breakdownMinutes(drafts))}${task.durationMin ? ` · czas zadania ${formatMinutes(task.durationMin)}` : ''}`}</P>
          <Row>
            <Button title={`Dodaj ${steps(chosen)}`} disabled={!chosen || busy} onPress={apply} />
          </Row>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 15 },
  step: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
