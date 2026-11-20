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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppData, useToday } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { mutateMany } from '@/lib/sync';

import { useTaskActions } from './actions';
import { usePalette } from './ui';

export type ReviewKindKey = keyof typeof REVIEW_ACTION;
export const REVIEW_KINDS = Object.keys(REVIEW_ACTION) as ReviewKindKey[];

export interface LogEntry {
  task: ViewTask;
  action: ReviewAction;
}

/** Sesja `review_sessions`: początek przy wejściu (raz), koniec ze statystykami (raz). */
export function useReviewSession(kind: ReviewKind, today: LocalDate) {
  const [id] = useState(() => uuidv7());
  useEffect(() => {
    void mutateMany([reviewStartOp(id, kind, new Date())]).catch(() => undefined);
  }, [id, kind]);
  const finished = useRef(false);
  return useCallback(
    (log: readonly LogEntry[]) => {
      if (finished.current) return;
      finished.current = true;
      void mutateMany([reviewFinishOp(id, reviewStats(log, { today }), new Date())]).catch(() => undefined);
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

/** Przyciski decyzji 1–6 (Ukończ / Dziś / Jutro / Wybierz datę / Kiedyś / Usuń). */
export function DecisionButtons({ onPick, disabled, compact }: { onPick: (kind: ReviewKindKey) => void; disabled?: readonly ReviewKindKey[]; compact?: boolean }) {
  const p = usePalette();
  return (
    <View style={styles.buttons}>
      {REVIEW_KINDS.map((k) => {
        const off = disabled?.includes(k);
        return (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!off }}
            disabled={off}
            onPress={() => onPick(k)}
            style={({ pressed }) => [
              compact ? styles.compact : styles.button,
              { borderColor: k === 'done' ? p.ok : p.border, backgroundColor: pressed ? p.border : p.card, opacity: off ? 0.35 : 1 },
            ]}
          >
            <Text style={{ color: k === 'delete' ? p.bad : k === 'done' ? p.ok : p.fg, fontSize: compact ? 12 : 14, fontWeight: '600' }}>{REVIEW_ACTION[k].label}</Text>
          </Pressable>
        );
      })}
    </View>
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

/** „Pora na przegląd dnia / tygodnia” w „Dziś” (pory z Ustawień → „Przeglądy”, wspólne z webem). */
export function ReviewNudge() {
  const p = usePalette();
  const data = useAppData();
  const { timeZone } = data.settings;
  const today = useToday(timeZone);
  const last = useLastReviews(today, timeZone);
  const due = reviewsDue(data.settings, new Date(), { timeZone, last });
  if (!due.length) return null;
  return (
    <View style={styles.nudges}>
      {due.map((kind) => (
        <Pressable
          key={kind}
          accessibilityRole="link"
          onPress={() => router.push(kind === 'daily' ? '/review/daily' : '/review/weekly')}
          style={({ pressed }) => [styles.nudge, { backgroundColor: pressed ? p.border : p.selected }]}
        >
          <Text style={{ color: p.fg, fontSize: 14 }}>{kind === 'daily' ? '🌙 Pora na przegląd dnia →' : '🗓 Pora na przegląd tygodnia →'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { width: '31.5%', borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  compact: { borderWidth: 1, borderRadius: 14, paddingVertical: 5, paddingHorizontal: 9 },
  nudges: { gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  nudge: { borderRadius: 10, padding: 10 },
});
