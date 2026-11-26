/**
 * Klocki przeglądu (Etap 9, M16) — jak `components/app/review.tsx` na webie: sesja
 * `review_sessions` (początek przy wejściu, koniec ze statystykami), decyzja przeglądu jako akcja
 * zbiorcza (`reviewBulkAction` → `bulkTaskOps`, z „Cofnij”), przyciski decyzji i odnośnik
 * „Pora na przegląd” w „Dziś” (`reviewsDue` z porami z Ustawień).
 */
import {
  addDays,
  bulkTaskOps,
  localDateAt,
  relativeDay,
  REVIEW_ACTION,
  reviewBulkAction,
  reviewFinishOp,
  reviewsDue,
  reviewStartOp,
  reviewStats,
  uuidv7,
  type LocalDate,
  type ReviewAction,
  type ReviewKind,
  type ViewTask,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppData, useToday } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { dismissReview, dismissedReviews, onDismissedReviews } from '@/lib/review-nudge';
import { mutateMany } from '@/lib/sync';

import { useTaskActions } from './actions';
import { usePalette } from './ui';

export type ReviewKindKey = keyof typeof REVIEW_ACTION;
export const REVIEW_KINDS = Object.keys(REVIEW_ACTION) as ReviewKindKey[];

export interface LogEntry {
  task: ViewTask;
  action: ReviewAction;
}

/**
 * Sesja `review_sessions`: początek przy wejściu (raz), koniec ze statystykami (raz; po „Wróć do kroków”
 * zapisuje się tylko zmieniony opis tygodnia).
 */
export function useReviewSession(kind: ReviewKind, today: LocalDate) {
  const [id] = useState(() => uuidv7());
  useEffect(() => {
    void mutateMany([reviewStartOp(id, kind, new Date())]).catch(() => undefined);
  }, [id, kind]);
  const finished = useRef<{ summary: string | null } | null>(null);
  return useCallback(
    (log: readonly LogEntry[], summary: string | null = null) => {
      if (finished.current && finished.current.summary === summary) return;
      finished.current = { summary };
      void mutateMany([reviewFinishOp(id, { ...reviewStats(log, { today }), ...(summary && { summary }) }, new Date())]).catch(() => undefined);
    },
    [id, today],
  );
}

/** Decyzja przeglądu → operacje z „Cofnij”; `false` = nic do zmiany (np. „Dziś” przy dzisiejszym). */
export function useDecide() {
  const data = useAppData();
  const timeZone = data.settings.timeZone;
  const today = useToday(timeZone);
  const { run, notify } = useTaskActions();
  return (task: ViewTask, action: ReviewAction): boolean => {
    const { ops, undo } = bulkTaskOps([task], data.tasks, reviewBulkAction(action), { today, now: new Date(), timeZone });
    if (!ops.length) {
      if (action.kind === 'someday' && task.recurrence) notify('Seria nie może być „kiedyś” — zakończ ją w szczegółach zadania albo wybierz datę.');
      return false;
    }
    const when = action.kind === 'date' ? relativeDay(action.date, today) : REVIEW_ACTION[action.kind].label.toLowerCase();
    void run(ops, { text: `„${task.title}” — ${action.kind === 'done' ? 'ukończone' : action.kind === 'delete' ? 'w koszu' : when}`, undo });
    return true;
  };
}

/**
 * Przyciski decyzji 1–6 (Ukończ / Dziś / Jutro / Wybierz datę / Kiedyś / Usuń). `compact` (listy przeglądu
 * tygodnia) = lekkie przyciski bez ramek, żeby tytuł zadania był najmocniejszy w wierszu; `trailing` — dodatkowy
 * przycisk w tym samym rzędzie.
 */
export function DecisionButtons({ onPick, disabled, compact, trailing }: { onPick: (kind: ReviewKindKey) => void; disabled?: readonly ReviewKindKey[]; compact?: boolean; trailing?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={compact ? styles.compactButtons : styles.buttons}>
      {REVIEW_KINDS.map((k) => {
        const off = disabled?.includes(k);
        const color = k === 'delete' ? p.bad : k === 'done' ? p.ok : compact ? p.muted : p.fg;
        return (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!off }}
            disabled={off}
            hitSlop={compact ? 4 : undefined}
            onPress={() => onPick(k)}
            style={({ pressed }) =>
              compact
                ? [styles.compact, k === 'delete' && styles.compactDelete, { backgroundColor: pressed ? p.border : 'transparent', opacity: off ? 0.35 : 1 }]
                : [styles.button, { borderColor: k === 'done' ? p.ok : p.border, backgroundColor: pressed ? p.border : p.card, opacity: off ? 0.35 : 1 }]
            }
          >
            <Text style={{ color, fontSize: compact ? 13 : 14, fontWeight: compact ? '500' : '600' }}>{REVIEW_ACTION[k].label}</Text>
          </Pressable>
        );
      })}
      {trailing}
    </View>
  );
}

/** Lekki przycisk w rzędzie decyzji (`DecisionButtons` `compact` `trailing`). */
export function CompactAction({ label, onPress }: { label: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" hitSlop={4} onPress={onPress} style={({ pressed }) => [styles.compact, { backgroundColor: pressed ? p.border : 'transparent' }]}>
      <Text style={{ color: p.accent, fontSize: 13, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

/** Daty lokalne ostatnio zakończonych przeglądów (do `reviewsDue`). */
export function useLastReviews(today: LocalDate, timeZone?: string): Partial<Record<ReviewKind, LocalDate | null>> {
  const rows =
    useLocalQuery(
      ['review_sessions'],
      (engine) =>
        engine.db.all<{ kind: string; finished_at: string }>(
          'select kind, finished_at from review_sessions where deleted_at is null and finished_at is not null and finished_at >= ? order by finished_at',
          [addDays(today, -2)],
        ),
      [today],
    ) ?? [];
  const last: Partial<Record<ReviewKind, LocalDate | null>> = {};
  for (const r of rows) last[r.kind as ReviewKind] = localDateAt(r.finished_at, timeZone);
  return last;
}

/** „Pora na przegląd dnia / tygodnia” w „Dziś” (pory z Ustawień → „Profil”, wspólne z webem) z „Nie dziś”. */
export function ReviewNudge() {
  const p = usePalette();
  const data = useAppData();
  const { timeZone } = data.settings;
  const today = useToday(timeZone);
  const last = useLastReviews(today, timeZone);
  const dismissed = useSyncExternalStore(onDismissedReviews, dismissedReviews);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const due = reviewsDue(data.settings, now, { timeZone, last }).filter((kind) => dismissed[kind] !== today);
  if (!due.length) return null;
  return (
    <View style={styles.nudges}>
      {due.map((kind) => (
        <View key={kind} style={[styles.nudge, { backgroundColor: p.selected }]}>
          <Pressable accessibilityRole="link" onPress={() => router.push(kind === 'daily' ? '/review/daily' : '/review/weekly')} style={({ pressed }) => [styles.nudgeText, { opacity: pressed ? 0.6 : 1 }]}>
            <Text style={{ color: p.fg, fontSize: 14 }}>{kind === 'daily' ? '🌙 Pora na przegląd dnia →' : '🗓 Pora na przegląd tygodnia →'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={() => dismissReview(kind, today)}>
            <Text style={{ color: p.muted, fontSize: 13 }}>Nie dziś</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { width: '31.5%', borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  compactButtons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', columnGap: 2, rowGap: 2 },
  compact: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 8 },
  compactDelete: { marginLeft: 6 },
  nudges: { gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  nudge: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 10, padding: 10 },
  nudgeText: { flex: 1 },
});
