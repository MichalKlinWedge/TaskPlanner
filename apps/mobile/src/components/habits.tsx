/**
 * Klocki nawyków (Etap 8, M15) — jak `components/app/habits.tsx` na webie: zapis wpisów dnia
 * (`habitEntryOps` z „Cofnij”), pasek 8 dni z uzupełnianiem wstecz, wiersz w bloku „Dziś”
 * (odhaczenie albo „− / +” celu ilościowego, dzień wolny, postęp i passa). Stany i statystyki
 * liczy `core/habits.ts`.
 */
import {
  addDays,
  addHabitValue,
  canEditHabitDay,
  dayChip,
  HABIT_BACKFILL_DAYS,
  habitDayStatus,
  habitEntryOps,
  habitProgressLabel,
  isoWeekday,
  nextHabitEntry,
  plural,
  WEEKDAY,
  type DayState,
  type Habit,
  type HabitCompletion,
  type HabitEntry,
  type HabitForDay,
  type HabitStreak,
  type IsoWeekday,
  type LocalDate,
  type ViewTask,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { useAppData, useToday, type AppData } from '@/lib/app-data';

import { useTaskActions } from './actions';
import { pickHabitValue } from './pickers';
import { usePalette } from './ui';

const EMPTY: readonly HabitCompletion[] = [];
export const completionsOf = (data: AppData, id: string) => data.habitCompletions.get(id) ?? EMPTY;
export const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)} %`);

export const STREAK_UNIT: Record<HabitStreak['unit'], readonly [string, string, string]> = {
  occurrence: ['dzień', 'dni', 'dni'],
  week: ['tydzień', 'tygodnie', 'tygodni'],
  month: ['miesiąc', 'miesiące', 'miesięcy'],
};

export const STATE_LABEL: Record<DayState, string> = {
  done: 'zrobione',
  partial: 'częściowo',
  skipped: 'dzień wolny',
  missed: 'opuszczone',
  pending: 'do zrobienia',
  off: 'bez planu',
};

/** Kolory stanów dnia (tło, tekst): zieleń dla postępu, opuszczone — blada czerwień. */
export function useStateColors(): Record<DayState, { bg: string; fg: string; border?: string }> {
  const p = usePalette();
  const dark = useColorScheme() === 'dark';
  return {
    done: { bg: dark ? '#10b981' : '#059669', fg: dark ? '#022c22' : '#ffffff' },
    partial: { bg: dark ? '#064e3b' : '#a7f3d0', fg: dark ? '#d1fae5' : '#064e3b' },
    skipped: { bg: 'transparent', fg: p.muted, border: p.muted },
    missed: { bg: dark ? '#4c0519' : '#ffe4e6', fg: dark ? '#fecdd3' : '#9f1239' },
    pending: { bg: p.card, fg: p.fg, border: p.accent },
    off: { bg: p.border, fg: p.muted },
  };
}

/** Zapis wpisu dnia z dymkiem i „Cofnij”; błąd (dzień spoza okna) — dymek. */
export function useHabitEntry() {
  const data = useAppData();
  const today = useToday(data.settings.timeZone);
  const { run, notify } = useTaskActions();
  return useCallback(
    (task: ViewTask, habit: Habit, date: LocalDate, entry: HabitEntry, toast?: string) => {
      try {
        const previous = completionsOf(data, task.id).find((c) => c.date === date) ?? null;
        const { ops, undo } = habitEntryOps(habit, task.id, date, entry, { now: new Date(), today, previous });
        void run(ops, toast ? { text: toast, undo } : undefined);
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e));
      }
    },
    [data, today, run, notify],
  );
}

export const entryToast = (task: ViewTask, date: LocalDate, today: LocalDate, entry: HabitEntry) => {
  const day = date === today ? 'dziś' : dayChip(date);
  return entry === null ? `„${task.title}” — ${day} wyczyszczone` : entry.kind === 'skipped' ? `„${task.title}” — ${day} dzień wolny` : `„${task.title}” — ${day} zrobione`;
};

const valueToast = (task: ViewTask, habit: Habit, date: LocalDate, today: LocalDate, entry: HabitEntry) =>
  entry?.kind === 'done' && entry.value != null
    ? `„${task.title}” — ${date === today ? 'dziś' : dayChip(date)}: ${String(entry.value).replace('.', ',')}${habit.unit ? ` ${habit.unit}` : ''}`
    : entryToast(task, date, today, entry);

/** Dziś i 7 poprzednich dni; dotknięcie: brak → zrobione → wolne → brak, a przy celu ilościowym — arkusz z wartością dnia. */
export function HabitDayStrip({ task, habit, size = 'md' }: { task: ViewTask; habit: Habit; size?: 'sm' | 'md' }) {
  const data = useAppData();
  const today = useToday(data.settings.timeZone);
  const save = useHabitEntry();
  const colors = useStateColors();
  const completions = completionsOf(data, task.id);
  const days = Array.from({ length: HABIT_BACKFILL_DAYS + 1 }, (_, i) => addDays(today, i - HABIT_BACKFILL_DAYS));
  const small = size === 'sm';
  return (
    <View style={styles.strip} accessibilityLabel={`Ostatnie dni: ${task.title}`}>
      {days.map((date) => {
        const status = habitDayStatus(habit, completions, date, today);
        const editable = canEditHabitDay(habit, date, today);
        const c = colors[status.state];
        const label = `${dayChip(date)} — ${STATE_LABEL[status.state]}${habit.target !== undefined && status.value !== null ? ` (${status.value} / ${habit.target})` : ''}`;
        return (
          <Pressable hitSlop={{ top: 4, bottom: 4 }}
            key={date}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={editable ? (habit.target !== undefined ? 'Dotknij, żeby wpisać wartość' : 'Dotknij, żeby zmienić') : undefined}
            disabled={!editable}
            onPress={async () => {
              if (habit.target !== undefined) {
                const entry = await pickHabitValue({
                  title: `${task.title} — ${dayChip(date)}`,
                  value: status.entry?.kind === 'done' ? (status.entry.value ?? habit.target) : habit.target,
                  target: habit.target,
                  unit: habit.unit,
                  skipped: status.entry?.kind === 'skipped',
                  empty: !status.entry,
                });
                if (entry !== undefined) save(task, habit, date, entry, valueToast(task, habit, date, today, entry));
                return;
              }
              const entry = nextHabitEntry(habit, status.entry);
              save(task, habit, date, entry, entryToast(task, date, today, entry));
            }}
            style={[
              styles.day,
              small ? styles.daySm : styles.dayMd,
              { backgroundColor: c.bg, borderColor: c.border ?? 'transparent', borderStyle: status.state === 'skipped' ? 'dashed' : 'solid', opacity: editable ? 1 : 0.45 },
            ]}
          >
            <Text style={{ color: c.fg, fontSize: small ? 9 : 10, opacity: 0.85 }}>{WEEKDAY[isoWeekday(date) as IsoWeekday].short}</Text>
            <Text style={{ color: c.fg, fontSize: small ? 11 : 13, fontWeight: date === today ? '700' : '400' }}>
              {status.state === 'done' ? '✓' : status.state === 'skipped' ? '–' : Number(date.slice(8))}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SmallButton({ label, onPress, disabled, a11y }: { label: string; onPress: () => void; disabled?: boolean; a11y?: string }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.small, { borderColor: p.border, opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color: p.fg, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** Wiersz nawyku w bloku „Dziś”. */
export function HabitTodayItem({ item, today }: { item: HabitForDay; today: LocalDate }) {
  const p = usePalette();
  const save = useHabitEntry();
  const { task, habit, status, streak } = item;
  const done = status.state === 'done';
  const progress = habitProgressLabel(habit, status);
  const set = (entry: HabitEntry, toast?: string) => save(task, habit, today, entry, toast);
  const toggle = () =>
    habit.target === undefined
      ? set(done ? null : { kind: 'done' }, done ? undefined : `„${task.title}” — zrobione`)
      : set(done ? null : { kind: 'done', value: habit.target }, done ? undefined : `„${task.title}” — cel osiągnięty`);
  return (
    <View style={[styles.item, { borderColor: p.border }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={habit.target === undefined ? `Zrobione: ${task.title}` : `Cel osiągnięty: ${task.title}`}
        hitSlop={12}
        onPress={toggle}
        style={[styles.check, { borderColor: done ? '#059669' : p.muted, backgroundColor: done ? '#059669' : 'transparent' }]}
      >
        {done ? <Text style={styles.tick}>✓</Text> : null}
      </Pressable>
      <Pressable accessibilityRole="link" style={{ flex: 1 }} onPress={() => router.push({ pathname: '/habit/[id]', params: { id: task.id } })}>
        <Text style={{ color: item.settled ? p.muted : p.fg, fontSize: 16 }} numberOfLines={2}>
          {task.title}
        </Text>
        {progress || status.state === 'skipped' || streak.current ? (
          <Text style={{ color: p.muted, fontSize: 12 }}>
            {[progress, status.state === 'skipped' ? 'dzień wolny' : null, streak.current ? `🔥 ${plural(streak.current, STREAK_UNIT[streak.unit])}` : null].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </Pressable>
      {habit.target !== undefined ? (
        <>
          <SmallButton label="−" a11y={`Odejmij 1: ${task.title}`} disabled={!status.entry || status.entry.kind !== 'done'} onPress={() => set(addHabitValue(habit, status.entry, -1))} />
          <SmallButton label="+" a11y={`Dodaj 1: ${task.title}`} onPress={() => set(addHabitValue(habit, status.entry, 1))} />
        </>
      ) : null}
      {!done ? (
        <SmallButton
          label={status.state === 'skipped' ? 'Cofnij' : 'Wolne'}
          a11y={status.state === 'skipped' ? `Cofnij dzień wolny: ${task.title}` : `Dzień wolny: ${task.title}`}
          onPress={() => set(status.state === 'skipped' ? null : { kind: 'skipped' }, status.state === 'skipped' ? undefined : `„${task.title}” — dziś dzień wolny`)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', gap: 4 },
  day: { alignItems: 'center', justifyContent: 'center', borderRadius: 7, borderWidth: 1.5 },
  daySm: { width: 30, height: 40 },
  dayMd: { flex: 1, height: 44 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#fff', fontSize: 13, fontWeight: '700' },
  small: { borderWidth: 1, borderRadius: 14, minWidth: 34, paddingHorizontal: 9, paddingVertical: 5, alignItems: 'center' },
});
