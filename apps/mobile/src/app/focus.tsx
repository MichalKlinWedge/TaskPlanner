/**
 * Tryb skupienia (Etap 7, M14) — ekran jak `#/focus` na webie: tarcza z pozostałym czasem (stoper —
 * upływ), etap i licznik serii, Pomodoro / stoper / pauza / pomiń / stop, zadanie z ukończeniem, opisem,
 * podzadaniami i „spędzono / szac.”, wybór zadania (dziś i zaległe albo szukanie wśród otwartych), przełączenie
 * trwającego timera na zadanie, z którego otwarto ekran, długości etapów, „Ten tydzień”.
 * Ekran nie gaśnie, póki etap biegnie (`expo-keep-awake`). Przejścia — `focusCommand`
 * (`lib/headless.ts`), powiadomienia i koniec etapu w tle — `lib/focus.ts`.
 */
import {
  FOCUS_PHASE,
  focusElapsed,
  focusRemaining,
  focusWeek,
  formatMinutes,
  formatTimer,
  isoWeekday,
  normalizeText,
  phaseMs,
  PRIORITY,
  selectToday,
  WEEKDAY,
  type IsoWeekday,
  type ViewContext,
} from '@taskplanner/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { DescriptionField } from '@/components/description-field';
import { pickOption } from '@/components/pickers';
import { TaskRow } from '@/components/task-row';
import { Button, Section, usePalette } from '@/components/ui';
import { listEditable, listLabel, useView, type AppData } from '@/lib/app-data';
import { isTicking, spentMinutes, syncFocusNotifications, useFocusData } from '@/lib/focus';
import { focusCommand, type FocusCommand } from '@/lib/headless';
import { permissionState, requestNotificationPermission } from '@/lib/reminders';
import { mutate } from '@/lib/sync';

const KEEP_AWAKE_TAG = 'focus';

/** Zegar co sekundę, gdy etap biegnie. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** Długości etapów (pola liczbowe ustawień skupienia). */
type LengthKey = 'focusMin' | 'shortBreakMin' | 'longBreakMin' | 'longBreakEvery';
const LENGTHS: { key: LengthKey; label: string; values: number[] }[] = [
  { key: 'focusMin', label: 'Praca', values: [10, 15, 20, 25, 30, 40, 45, 50, 60, 90] },
  { key: 'shortBreakMin', label: 'Krótka przerwa', values: [1, 3, 5, 10, 15] },
  { key: 'longBreakMin', label: 'Długa przerwa', values: [10, 15, 20, 25, 30] },
  { key: 'longBreakEvery', label: 'Długa co', values: [2, 3, 4, 5, 6] },
];

export default function FocusScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ task?: string }>();
  const { data, today, ctx } = useView();
  const focus = useFocusData();
  const { notify, toggle } = useTaskActions();
  const { state, settings } = focus;
  const ticking = isTicking(state);
  const now = useNow(ticking);
  const [chosen, setChosen] = useState<string | null>(params.task ?? null);
  const [picking, setPicking] = useState(false);

  // Ekran nie gaśnie, póki etap biegnie (tylko na tym ekranie).
  useEffect(() => {
    if (!ticking) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
  }, [ticking]);

  const activeTaskId = state.phase === 'idle' ? chosen : state.taskId;
  const task = activeTaskId ? data.tasks.find((t) => t.id === activeTaskId) : undefined;
  const subtasks = task ? data.tasks.filter((t) => t.parentId === task.id).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)) : [];

  const run = async (command: FocusCommand) => {
    try {
      if (command.kind === 'start' && !(await permissionState()).notifications) await requestNotificationPermission();
      const result = await focusCommand(command);
      await syncFocusNotifications(result);
    } catch (e) {
      notify(`Timer: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const remaining = focusRemaining(state, new Date(now), settings);
  const elapsed = focusElapsed(state, new Date(now));
  const total = phaseMs(state.phase, settings);
  const shown = state.phase === 'idle' ? settings.focusMin * 60_000 : state.phase === 'ready' ? 0 : (remaining ?? elapsed);
  const fraction = total ? Math.min(1, elapsed / total) : 0;
  const color = state.phase === 'focus' || state.phase === 'stopwatch' ? p.accent : state.phase === 'idle' ? p.muted : p.ok;

  // Ekran otwarty z innego zadania niż to, nad którym biegnie timer.
  const wanted = state.phase !== 'idle' && chosen && chosen !== state.taskId ? data.tasks.find((t) => t.id === chosen) : undefined;
  const editable = !!task && listEditable(data, task.listId);
  const complete = async () => {
    if (!task) return;
    if (task.status !== 'done' && state.phase !== 'idle' && state.taskId === task.id) await run({ kind: 'stop' });
    await toggle(task);
  };

  const setLength = (key: LengthKey, values: number[], label: string) =>
    void pickOption<number>(label, values.map((v) => ({ label: key === 'longBreakEvery' ? `co ${v} etapy` : formatMinutes(v), value: v, selected: settings[key] === v }))).then((v) => {
      if (v === undefined || v === settings[key]) return;
      void mutate('profiles', data.userId, { settings: { ...data.settings, focus: { ...settings, [key]: v } } }).catch((e: unknown) => notify(String(e)));
    });

  // Minuta wystarczy — statystyki nie muszą liczyć się co sekundę.
  const minute = Math.floor(now / 60_000);
  const week = useMemo(
    () =>
      focusWeek(focus.entries, data.tasks.map((t) => ({ id: t.id, listId: t.listId, workspaceId: t.workspaceId })), {
        today,
        firstDayOfWeek: data.settings.firstDayOfWeek,
        timeZone: data.settings.timeZone,
        now: new Date(minute * 60_000),
      }),
    [focus.entries, data.tasks, today, data.settings.firstDayOfWeek, data.settings.timeZone, minute],
  );
  const maxDay = Math.max(1, ...week.days.map((d) => d.minutes));

  // Wejścia są ukryte przy wyłączonym trybie, ale ekran da się otworzyć linkiem / skrótem — jak `#/focus` na webie.
  if (!data.settings.focus.enabled) {
    return (
      <View style={[styles.body, { flex: 1, backgroundColor: p.bg }]}>
        <Stack.Screen options={{ title: 'Skupienie' }} />
        <Text style={{ color: p.muted, fontSize: 15 }}>Tryb skupienia jest wyłączony — włącz go w Ustawieniach.</Text>
        <Button title="Otwórz Ustawienia" onPress={() => router.replace('/settings')} />
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Skupienie' }} />
      {wanted ? (
        <View style={[styles.other, { backgroundColor: p.selected }]}>
          <Text style={{ color: p.fg, fontSize: 14 }}>
            Timer działa {task ? `dla „${task.title}”` : 'bez zadania'}.
          </Text>
          <Button kind="secondary" title={`Przełącz na „${wanted.title}”`} onPress={() => void run({ kind: 'start', taskId: wanted.id, mode: state.phase === 'stopwatch' ? 'stopwatch' : 'pomodoro' })} />
        </View>
      ) : null}
      <View style={styles.dial}>
        <Text style={[styles.phase, { color }]}>
          {FOCUS_PHASE[state.phase === 'idle' ? 'focus' : state.phase]}
          {state.paused ? ' · pauza' : ''}
        </Text>
        <Text accessibilityRole="timer" style={[styles.timer, { color: state.paused ? p.muted : p.fg }]}>
          {formatTimer(shown)}
        </Text>
        {total ? (
          <View style={[styles.progress, { backgroundColor: p.border }]}>
            <View style={{ width: `${fraction * 100}%`, height: '100%', backgroundColor: color }} />
          </View>
        ) : null}
        <Text style={{ color: p.muted, fontSize: 13 }}>
          {state.phase === 'stopwatch'
            ? 'Stoper — bez limitu'
            : `Seria: ${state.completedFocus % settings.longBreakEvery}/${settings.longBreakEvery} do długiej przerwy · ukończone ${state.completedFocus}`}
        </Text>
      </View>

      <View style={styles.buttons}>
        {state.phase === 'idle' ? (
          <>
            <Button title={`▶ Pomodoro ${settings.focusMin} min`} onPress={() => void run({ kind: 'start', taskId: chosen, mode: 'pomodoro' })} />
            <Button kind="secondary" title="⏱ Stoper" onPress={() => void run({ kind: 'start', taskId: chosen, mode: 'stopwatch' })} />
          </>
        ) : state.phase === 'ready' ? (
          <>
            <Button title="▶ Następny etap pracy" onPress={() => void run({ kind: 'continue' })} />
            <Button kind="secondary" title="■ Stop" onPress={() => void run({ kind: 'stop' })} />
          </>
        ) : (
          <>
            {state.paused ? <Button title="▶ Wznów" onPress={() => void run({ kind: 'resume' })} /> : <Button title="❚❚ Pauza" onPress={() => void run({ kind: 'pause' })} />}
            {state.phase !== 'stopwatch' ? (
              <Button kind="secondary" title={state.phase === 'focus' ? 'Zakończ etap' : 'Pomiń przerwę'} onPress={() => void run({ kind: 'skip' })} />
            ) : null}
            <Button kind="secondary" title="■ Stop" onPress={() => void run({ kind: 'stop' })} />
          </>
        )}
      </View>

      <Section title="Zadanie">
        {task ? (
          <>
            <View style={styles.taskHead}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: task.status === 'done', disabled: !editable }}
                accessibilityLabel={task.status === 'done' ? 'Przywróć zadanie' : 'Ukończ zadanie'}
                disabled={!editable}
                hitSlop={10}
                onPress={() => void complete()}
                style={[styles.check, { borderColor: PRIORITY[task.priority].color, backgroundColor: task.status === 'done' ? PRIORITY[task.priority].color : 'transparent', opacity: editable ? 1 : 0.4 }]}
              >
                {task.status === 'done' ? <Text style={styles.tick}>✓</Text> : null}
              </Pressable>
              <Pressable accessibilityRole="link" style={{ flex: 1 }} onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })}>
                <Text style={{ color: task.status === 'done' ? p.muted : p.fg, fontSize: 17, fontWeight: '600', textDecorationLine: task.status === 'done' ? 'line-through' : 'none' }}>{task.title}</Text>
              </Pressable>
            </View>
            <Text style={{ color: p.muted, fontSize: 13 }}>
              {listLabel(data, task.listId)} · spędzono {formatMinutes(spentMinutes(focus.entries, task.id, new Date(now)))}
              {task.durationMin ? ` / szac. ${formatMinutes(task.durationMin)}` : ''}
            </Text>
            <DescriptionField key={task.id} taskId={task.id} readOnly={!editable} />
            {subtasks.length ? (
              <View style={{ marginHorizontal: -12 }}>
                {subtasks.map((c) => (
                  <TaskRow key={c.id} task={c} today={today} />
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <Text style={{ color: p.muted }}>Bez zadania — czas liczy się ogólnie.</Text>
        )}
        {state.phase !== 'idle' ? null : picking ? (
          <TaskPicker
            data={data}
            ctx={ctx}
            onPick={(id) => {
              if (id !== undefined) setChosen(id);
              setPicking(false);
            }}
          />
        ) : (
          <Button kind="secondary" title={task ? 'Zmień zadanie' : 'Wybierz zadanie'} onPress={() => setPicking(true)} />
        )}
      </Section>

      <Section title="Długości etapów">
        <View style={styles.lengths}>
          {LENGTHS.map((l) => (
            <Pressable
              key={l.key}
              accessibilityRole="button"
              onPress={() => setLength(l.key, l.values, l.label)}
              style={({ pressed }) => [styles.length, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
            >
              <Text style={{ color: p.muted, fontSize: 11 }}>{l.label}</Text>
              <Text style={{ color: p.fg, fontSize: 15 }}>{l.key === 'longBreakEvery' ? `co ${settings[l.key]}` : formatMinutes(settings[l.key])}</Text>
            </Pressable>
          ))}
        </View>
      </Section>

      <Section title="Ten tydzień">
        <Text style={{ color: p.fg }}>
          {formatMinutes(week.total)} pracy · Pomodoro: {week.pomodoros}
        </Text>
        <View style={styles.week}>
          {week.days.map((d) => (
            <View key={d.date} style={styles.weekDay}>
              <View style={[styles.weekBar, { height: 4 + (60 * d.minutes) / maxDay, backgroundColor: d.date === today ? p.accent : p.muted }]} />
              <Text style={{ color: p.muted, fontSize: 11 }}>{WEEKDAY[isoWeekday(d.date) as IsoWeekday].short}</Text>
              <Text style={{ color: p.fg, fontSize: 11 }}>{d.minutes ? formatMinutes(d.minutes) : '—'}</Text>
            </View>
          ))}
        </View>
        {week.byTask.slice(0, 5).map((b) => (
          <Text key={b.id ?? 'none'} style={{ color: p.muted, fontSize: 13 }} numberOfLines={1}>
            {formatMinutes(b.minutes)} · {b.id ? (data.tasks.find((t) => t.id === b.id)?.title ?? 'zadanie usunięte') : 'bez zadania'}
          </Text>
        ))}
      </Section>
    </ScrollView>
  );
}

/** Wybór zadania: zaległe, dzisiejsze i trwające, a po wpisaniu — wszystkie otwarte (bez polskich znaków). */
function TaskPicker({ data, ctx, onPick }: { data: AppData; ctx: ViewContext; onPick: (id: string | null | undefined) => void }) {
  const p = usePalette();
  const [query, setQuery] = useState('');
  const options = useMemo(() => {
    const needle = normalizeText(query.trim());
    if (needle) {
      return data.tasks
        .filter((t) => t.kind === 'task' && (t.status === 'todo' || t.status === 'in_progress') && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId) && normalizeText(t.title).includes(needle))
        .slice(0, 12);
    }
    const { overdue, today, ongoing } = selectToday(data.tasks, ctx, { completed: 'hidden' });
    return [...overdue, ...today, ...ongoing].filter((t, i, all) => t.kind === 'task' && all.findIndex((x) => x.id === t.id) === i).slice(0, 12);
  }, [data.tasks, ctx, query]);
  return (
    <View style={{ gap: 4 }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Szukaj wśród otwartych zadań…"
        placeholderTextColor={p.muted}
        accessibilityLabel="Szukaj zadania"
        style={[styles.search, { color: p.fg, borderColor: p.border }]}
      />
      {options.map((t) => (
        <Pressable key={t.id} accessibilityRole="button" onPress={() => onPick(t.id)} style={[styles.option, { borderColor: p.border }]}>
          <View style={[styles.dot, { backgroundColor: PRIORITY[t.priority].color }]} />
          <Text style={{ color: p.fg, fontSize: 15, flex: 1 }} numberOfLines={1}>
            {t.title}
          </Text>
          <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
            {listLabel(data, t.listId)}
          </Text>
        </Pressable>
      ))}
      {!options.length ? <Text style={{ color: p.muted, fontSize: 13 }}>{query.trim() ? 'Nic nie pasuje.' : 'Na dziś nic — wyszukaj zadanie albo zacznij bez zadania.'}</Text> : null}
      <Button kind="secondary" title="Bez zadania" onPress={() => onPick(null)} />
      <Button kind="secondary" title="Anuluj" onPress={() => onPick(undefined)} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 14, paddingBottom: 48 },
  dial: { alignItems: 'center', gap: 8, paddingVertical: 18 },
  phase: { fontSize: 16, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  timer: { fontSize: 76, fontWeight: '200', fontVariant: ['tabular-nums'] },
  progress: { width: '80%', height: 6, borderRadius: 3, overflow: 'hidden' },
  buttons: { gap: 10 },
  taskHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#fff', fontSize: 13, fontWeight: '700' },
  other: { borderRadius: 10, padding: 10, gap: 8 },
  search: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  lengths: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  length: { width: '48%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  week: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingTop: 6 },
  weekDay: { alignItems: 'center', gap: 2, flex: 1 },
  weekBar: { width: 14, borderRadius: 3 },
});
