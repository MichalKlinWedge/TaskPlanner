/**
 * Wiersz zadania (MVP-3): kółko ukończenia w kolorze priorytetu, tytuł, termin / godzina /
 * powtarzanie / postęp podzadań / lista. Gesty: przesunięcie w prawo = ukończ, w lewo = menu
 * terminu; długie przytrzymanie = zaznaczanie (potem dotknięcie dokłada kolejne), dotknięcie =
 * szczegóły zadania. Wirtualne wystąpienie serii (Nadchodzące) — tylko do odczytu.
 */
import { assigneeOf, collaboratorBadge, describeRecurrence, isOpen, PRIORITY, relativeDay, type LocalDate, type ViewTask } from '@taskplanner/core';
import { router } from 'expo-router';
import { memo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Swipeable, { SwipeDirection, type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import { useAppData } from '@/lib/app-data';

import { useTaskActions } from './actions';
import { rescheduleWithMenu } from './task-menus';
import { usePalette } from './ui';

export interface TaskRowProps {
  task: ViewTask;
  today: LocalDate;
  /** Pokazać termin (w sekcji „Dziś” zbędny). */
  showDate?: boolean;
  /** Nazwa listy w widokach zbiorczych. */
  listName?: string;
  depth?: number;
  progress?: { done: number; total: number };
  /** `true`/`false` — węzeł z podzadaniami (zwinięty / rozwinięty); brak — bez podzadań. */
  collapsed?: boolean;
  onCollapse?: () => void;
  /** Przyszłe wystąpienie serii — tylko do odczytu. */
  virtualDate?: LocalDate;
  /** Nawyk odhaczony dziś. */
  habitDone?: boolean;
  tagNames?: readonly string[];
}

export const TaskRow = memo(function TaskRow({ task, today, showDate = true, listName, depth = 0, progress, collapsed, onCollapse, virtualDate, habitDone, tagNames }: TaskRowProps) {
  const p = usePalette();
  const actions = useTaskActions();
  const { toggle, selected, toggleSelected } = actions;
  const swipe = useRef<SwipeableMethods>(null);
  const isSelected = selected.has(task.id);
  const selecting = selected.size > 0;
  const closed = task.kind === 'habit' ? !!habitDone : !isOpen(task);
  const date = virtualDate ?? task.dueDate;
  const overdue = !virtualDate && !closed && task.dueDate !== null && task.dueDate < today;
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;
  const swipeable = !virtualDate && !selecting;
  const assignee = assigneeOf(task.assigneeId, useAppData().collaborators);

  const meta = [
    showDate && date ? { text: relativeDay(date, today), bad: overdue } : null,
    task.dueTime ? { text: task.dueTime } : null,
    task.recurrence ? { text: `↻ ${describeRecurrence(task.recurrence)}` } : null,
    progress && progress.total > 0 ? { text: `☑ ${progress.done}/${progress.total}` } : null,
    task.status === 'in_progress' ? { text: 'w trakcie' } : task.status === 'waiting' ? { text: 'oczekuje' } : null,
    listName ? { text: listName } : null,
    assignee ? { text: `👤 ${collaboratorBadge(assignee)}` } : null,
    ...(tagNames ?? []).map((t) => ({ text: `@${t}` })),
  ].filter(Boolean) as { text: string; bad?: boolean }[];

  const body = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityState={{ selected: isSelected }}
      accessibilityHint={selecting ? 'Dotknij, żeby zaznaczyć albo odznaczyć' : 'Otwiera szczegóły; przesuń w prawo — ukończ, w lewo — termin; przytrzymaj — zaznacz'}
      onPress={() => (selecting ? toggleSelected(task.id) : router.push({ pathname: '/task/[id]', params: { id: task.id } }))}
      onLongPress={() => !virtualDate && toggleSelected(task.id)}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: isSelected ? p.selected : pressed ? p.border : p.bg, paddingLeft: 12 + depth * 18, borderColor: p.border, opacity: virtualDate ? 0.6 : 1 },
      ]}
    >
      {collapsed === undefined ? (
        depth > 0 || onCollapse ? <View style={styles.caret} /> : null
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={collapsed ? 'Rozwiń podzadania' : 'Zwiń podzadania'} hitSlop={10} onPress={onCollapse} style={styles.caret}>
          <Text style={{ color: p.muted, fontSize: 14 }}>{collapsed ? '▸' : '▾'}</Text>
        </Pressable>
      )}
      {virtualDate ? (
        <View style={[styles.check, { borderColor: color, borderStyle: 'dashed' }]} />
      ) : selecting ? (
        <View style={[styles.check, styles.square, { borderColor: isSelected ? p.accent : p.muted, backgroundColor: isSelected ? p.accent : 'transparent' }]}>
          {isSelected ? <Text style={styles.tick}>✓</Text> : null}
        </View>
      ) : (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: closed }}
          accessibilityLabel={closed ? `Przywróć „${task.title}”` : `Ukończ „${task.title}”`}
          hitSlop={12}
          onPress={() => void toggle(task, { habitDone })}
          style={[styles.check, { borderColor: color, backgroundColor: closed ? color : `${color}1A` }]}
        >
          {closed ? <Text style={styles.tick}>✓</Text> : null}
        </Pressable>
      )}
      <View style={styles.text}>
        <Text style={[styles.title, { color: closed ? p.muted : p.fg, textDecorationLine: closed ? 'line-through' : 'none' }]} numberOfLines={3}>
          {task.title}
        </Text>
        {meta.length ? (
          <Text style={[styles.meta, { color: p.muted }]} numberOfLines={1}>
            {meta.map((m, i) => (
              <Text key={i} style={m.bad ? { color: p.bad, fontWeight: '600' } : undefined}>
                {i ? ' · ' : ''}
                {m.text}
              </Text>
            ))}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );

  if (!swipeable) return body;
  return (
    <Swipeable
      ref={swipe}
      friction={1.6}
      leftThreshold={72}
      rightThreshold={72}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={() => (
        <View style={[styles.action, styles.left, { backgroundColor: closed ? p.muted : p.ok }]}>
          <Text style={styles.actionText}>{closed ? '↺ Przywróć' : '✓ Ukończ'}</Text>
        </View>
      )}
      renderRightActions={() => (
        <View style={[styles.action, styles.right, { backgroundColor: p.accent }]}>
          <Text style={styles.actionText}>📅 Termin</Text>
        </View>
      )}
      onSwipeableWillOpen={(direction) => {
        swipe.current?.close();
        // Kierunek = ruch palca: w prawo odsłania lewy panel („Ukończ”).
        if (direction === SwipeDirection.RIGHT) void toggle(task, { habitDone });
        else void rescheduleWithMenu(task, today, actions);
      }}
    >
      {body}
    </Swipeable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingRight: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  caret: { width: 14, alignItems: 'center', paddingTop: 2 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  square: { borderRadius: 6 },
  tick: { color: '#fff', fontSize: 13, fontWeight: '700' },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 16, lineHeight: 21 },
  meta: { fontSize: 12.5 },
  action: { flex: 1, justifyContent: 'center' },
  left: { alignItems: 'flex-start', paddingLeft: 20 },
  right: { alignItems: 'flex-end', paddingRight: 20 },
  actionText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
