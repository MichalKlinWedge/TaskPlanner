/**
 * Akcje zadań na telefonie (jak `task-item.tsx` na webie): ukończenie z „Cofnij”, zapis operacji
 * z core (`TaskOp`) z dymkiem, zaznaczanie wielu zadań (długie przytrzymanie) i operacje grupowe
 * (`bulkTaskOps`). Wszystko idzie przez lokalną bazę (`mutate` → wiersz + outbox).
 */
import { bulkTaskOps, completeTaskOps, descendants, isOpen, localDateAt, openDescendants, plural, relativeDay, reopenTaskPatch, type BulkAction, type TaskOp, type ViewTask } from '@taskplanner/core';
import * as Haptics from 'expo-haptics';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppData } from '@/lib/app-data';
import { applyOps } from '@/lib/headless';
import { mutate } from '@/lib/sync';

import { usePalette } from './ui';

interface Toast {
  id: number;
  text: string;
  undo?: TaskOp[];
}

export interface TaskActions {
  toggle: (task: ViewTask, opts?: { habitDone?: boolean }) => Promise<void>;
  /** Zapis operacji po kolei; z `toast` — dymek, z `undo` — także „Cofnij”. */
  run: (ops: readonly TaskOp[], toast?: { text: string; undo?: TaskOp[] }) => Promise<void>;
  notify: (message: string) => void;
  /** Zaznaczone zadania (tryb zaznaczania, gdy niepuste). */
  selected: ReadonlySet<string>;
  toggleSelected: (id: string) => void;
  setSelected: (ids: readonly string[]) => void;
  /** Akcja na zaznaczonych (z „Cofnij”), po niej zaznaczenie znika. */
  bulk: (action: BulkAction) => Promise<void>;
}

const ActionsContext = createContext<TaskActions | null>(null);

export function useTaskActions(): TaskActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useTaskActions poza <TaskActionsProvider>.');
  return actions;
}

export { applyOps };

/** Pytanie z dwoma odpowiedziami jako Promise. */
export const confirm = (title: string, message: string, ok = 'Tak', cancel = 'Nie'): Promise<boolean> =>
  new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: cancel, style: 'cancel', onPress: () => resolve(false) },
      { text: ok, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;
const BULK_TEXT: Record<BulkAction['kind'], string> = {
  complete: 'Ukończono',
  priority: 'Zmieniono priorytet',
  today: 'Na dziś',
  tomorrow: 'Na jutro',
  date: 'Nowy termin',
  someday: 'Na kiedyś',
  move: 'Przeniesiono',
  delete: 'Do kosza',
};

export function TaskActionsProvider({ children }: { children: ReactNode }) {
  const data = useAppData();
  const timeZone = data.settings.timeZone;
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<Toast | null>(null);
  const [rawSelected, setSelectedState] = useState<ReadonlySet<string>>(new Set());
  // Zaznaczone zadania, których już nie ma (usunięte, z innego urządzenia), wypadają z zaznaczenia.
  const selected = useMemo(() => {
    if (!rawSelected.size) return rawSelected;
    const alive = new Set(data.tasks.map((t) => t.id));
    return [...rawSelected].every((id) => alive.has(id)) ? rawSelected : new Set([...rawSelected].filter((id) => alive.has(id)));
  }, [rawSelected, data.tasks]);
  const next = useRef(0);
  const tasksRef = useRef(data.tasks);
  useEffect(() => {
    tasksRef.current = data.tasks;
  });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);


  const show = useCallback((text: string, undo?: TaskOp[]) => setToast({ id: ++next.current, text, undo }), []);
  const fail = useCallback((e: unknown) => show(e instanceof Error ? e.message : String(e)), [show]);

  const toggle = useCallback(
    async (task: ViewTask, { habitDone }: { habitDone?: boolean } = {}) => {
      try {
        if (task.kind === 'habit' && habitDone) {
          await applyOps(completeTaskOps(task, { now: new Date(), timeZone }).undo);
          return;
        }
        if (task.kind === 'task' && !isOpen(task)) {
          await mutate('tasks', task.id, reopenTaskPatch());
          return;
        }
        const now = new Date();
        // Seria: zamknięte podzadania wracają do „Do zrobienia” przy następnym wystąpieniu (M7).
        const result = completeTaskOps(task, { now, timeZone, subtasks: task.recurrence ? descendants(tasksRef.current, task.id) : [] });
        // M3: rodzic z otwartymi podzadaniami — „Ukończyć też podzadania?”.
        const open = task.recurrence ? [] : openDescendants(tasksRef.current, task.id);
        if (open.length && (await confirm(`Ukończyć „${task.title}”?`, `Zadanie ma ${plural(open.length, ['otwarte podzadanie', 'otwarte podzadania', 'otwartych podzadań'])}. Ukończyć też je?`))) {
          for (const child of open) {
            const done = completeTaskOps({ ...child, recurrence: null }, { now, timeZone });
            result.ops.push(...done.ops);
            result.undo.push(...done.undo);
          }
        }
        await applyOps(result.ops);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        const today = localDateAt(now, timeZone);
        show(result.nextDue ? `„${task.title}” — następny termin: ${relativeDay(result.nextDue, today)}` : `Ukończono „${task.title}”`, result.undo);
      } catch (e) {
        fail(e);
      }
    },
    [timeZone, show, fail],
  );

  const run = useCallback(
    async (ops: readonly TaskOp[], toastText?: { text: string; undo?: TaskOp[] }) => {
      try {
        await applyOps(ops);
        if (toastText) show(toastText.text, toastText.undo);
      } catch (e) {
        fail(e);
      }
    },
    [show, fail],
  );

  const toggleSelected = useCallback((id: string) => {
    void Haptics.selectionAsync().catch(() => undefined);
    setSelectedState((current) => {
      const s = new Set(current);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }, []);
  const setSelected = useCallback((ids: readonly string[]) => setSelectedState(new Set(ids)), []);

  const bulk = useCallback(
    async (action: BulkAction) => {
      const all = tasksRef.current;
      const chosen = all.filter((t) => selected.has(t.id));
      if (!chosen.length) return;
      const now = new Date();
      const { ops, undo } = bulkTaskOps(chosen, all, action, { today: localDateAt(now, timeZone), now, timeZone });
      setSelectedState(new Set());
      if (!ops.length) return show('Nic do zmiany.');
      await run(ops, { text: `${BULK_TEXT[action.kind]}: ${plural(chosen.length, TASKS)}`, undo });
    },
    [selected, timeZone, run, show],
  );

  const value = useMemo(() => ({ toggle, run, notify: show, selected, toggleSelected, setSelected, bulk }), [toggle, run, show, selected, toggleSelected, setSelected, bulk]);

  const undo = async () => {
    if (!toast?.undo) return;
    const ops = toast.undo;
    setToast(null);
    await applyOps(ops).catch(fail);
  };

  return (
    <ActionsContext.Provider value={value}>
      {children}
      {toast ? (
        <View pointerEvents="box-none" style={[styles.toastWrap, { bottom: insets.bottom + 150 }]}>
          <View accessibilityRole="alert" style={[styles.toast, { backgroundColor: p.fg }]}>
            <Text style={[styles.toastText, { color: p.bg }]} numberOfLines={2}>
              {toast.text}
            </Text>
            {toast.undo ? (
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void undo()}>
                <Text style={[styles.undo, { color: p.accent }]}>Cofnij</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Zamknij" hitSlop={8} onPress={() => setToast(null)}>
              <Text style={{ color: p.bg, opacity: 0.6 }}>✕</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ActionsContext.Provider>
  );
}

const styles = StyleSheet.create({
  toastWrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, maxWidth: 560, elevation: 6 },
  toastText: { flexShrink: 1, fontSize: 14 },
  undo: { fontWeight: '700', fontSize: 14 },
});
