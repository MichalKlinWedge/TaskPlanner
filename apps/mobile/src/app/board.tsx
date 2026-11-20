/**
 * Uproszczona tablica kanban (MVP-4, M10 na telefonie): kolumny z `core/kanban.ts`
 * (`boardColumns`) — jedna kolumna na ekranie, przełączana zakładkami z licznikami; kartę
 * przenosi menu „⇄” (do innej kolumny na początek, wyżej / niżej w kolumnie) przez `boardDropOps`,
 * jak przeciąganie na webie (atrybut kolumny + `board_sort_key`, z „Cofnij”).
 * `?list=` — tablica listy (kryterium w `view_prefs.boardBy`, chipy filtra zapisane w `view_prefs.filter`
 * jak na ekranie listy), bez — bieżącej przestrzeni (chipy filtra w pamięci do zamknięcia aplikacji)
 * (kryterium zapamiętane na urządzeniu).
 */
import { applyFilter, BOARD_BY, boardColumns, isEmptyFilter, tagsForWorkspace, type FilterQuery, boardDropOps, type BoardBy, type BoardColumn, type ViewTask } from '@taskplanner/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { pickOption, type Option } from '@/components/pickers';
import { TaskRow } from '@/components/task-row';
import { Chip, usePalette } from '@/components/ui';
import { listLabel, useView } from '@/lib/app-data';
import { mutate } from '@/lib/sync';

const BY_KEY = 'board.by';
const NO_FILTER: FilterQuery = {};

type Move = { kind: 'column'; key: string } | { kind: 'up' } | { kind: 'down' };

export default function BoardScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { list: listId } = useLocalSearchParams<{ list?: string }>();
  const { data, today, ctx } = useView();
  const { run, notify } = useTaskActions();
  const list = listId ? data.lists.find((l) => l.id === listId) : undefined;
  const [localBy, setLocalBy] = useState<BoardBy>(() => (Storage.getItemSync(BY_KEY) as BoardBy | null) ?? 'status');
  const by: BoardBy = list ? (list.prefs.boardBy ?? 'status') : localBy;
  const setBy = (next: BoardBy) => {
    if (list) void mutate('lists', list.id, { view_prefs: { ...list.prefs, boardBy: next } }).catch((e: unknown) => notify(String(e)));
    else {
      Storage.setItemSync(BY_KEY, next);
      setLocalBy(next);
    }
  };

  const [localFilter, setLocalFilter] = useState<FilterQuery>({});
  const filter = list ? (list.prefs.filter ?? NO_FILTER) : localFilter;
  const setFilter = (next: FilterQuery) => {
    if (!list) return setLocalFilter(next);
    const prefs = { ...list.prefs };
    delete prefs.filter;
    if (!isEmptyFilter(next)) prefs.filter = next;
    void mutate('lists', list.id, { view_prefs: prefs }).catch((e: unknown) => notify(String(e)));
  };
  const tasks = useMemo(() => {
    const own = data.tasks.filter((t) => (listId ? t.listId === listId : !ctx.workspaceId || t.workspaceId === ctx.workspaceId));
    return isEmptyFilter(filter) ? own : applyFilter(own, filter, today);
  }, [data.tasks, listId, ctx.workspaceId, filter, today]);
  const lists = useMemo(() => {
    const used = new Set(tasks.map((t) => t.listId));
    return data.lists.filter((l) => used.has(l.id) || l.id === listId);
  }, [data.lists, tasks, listId]);
  // Kolumny tagów: tagi przestrzeni tablicy (wybranej albo wspólnej dla jej list) + użyte na kartach.
  const tags = useMemo(() => {
    const space = ctx.workspaceId ?? (lists.length && lists.every((l) => l.workspaceId === lists[0]!.workspaceId) ? lists[0]!.workspaceId : null);
    return tagsForWorkspace(data.tags, space, tasks.flatMap((t) => t.tagIds));
  }, [data.tags, ctx.workspaceId, lists, tasks]);
  const columns = useMemo(() => boardColumns(tasks, by, { today, firstDayOfWeek: ctx.firstDayOfWeek }, { tags, lists }), [tasks, by, today, ctx.firstDayOfWeek, tags, lists]);
  const [selected, setSelected] = useState<string | null>(null);
  const column = columns.find((c) => c.key === selected) ?? columns[0];

  const tagName = useMemo(() => new Map(data.tags.map((t) => [t.id, t.name])), [data.tags]);
  const children = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const t of data.tasks) {
      if (!t.parentId || t.status === 'cancelled') continue;
      const c = map.get(t.parentId) ?? { done: 0, total: 0 };
      c.total++;
      if (t.status === 'done') c.done++;
      map.set(t.parentId, c);
    }
    return map;
  }, [data.tasks]);

  const moveCard = async (task: ViewTask, from: BoardColumn) => {
    const at = from.tasks.findIndex((t) => t.id === task.id);
    const options: Option<Move>[] = [
      ...(at > 0 ? [{ label: '↑ Wyżej', value: { kind: 'up' } as Move }] : []),
      ...(at < from.tasks.length - 1 ? [{ label: '↓ Niżej', value: { kind: 'down' } as Move }] : []),
      ...columns.filter((c) => c.key !== from.key).map((c) => ({ label: `→ ${c.label}`, hint: `${c.tasks.length}`, value: { kind: 'column', key: c.key } as Move })),
    ];
    const move = await pickOption(`„${task.title}”`, options);
    if (!move) return;
    const target = move.kind === 'column' ? columns.find((c) => c.key === move.key) : from;
    if (!target) return;
    if (by === 'tag' && target.key !== from.key && target.key !== 'none' && task.tagIds.includes(target.key)) return notify('Zadanie ma już ten tag.');
    const index = move.kind === 'column' ? 0 : move.kind === 'up' ? at - 1 : at + 1;
    const { ops, undo } = boardDropOps(task, data.tasks, by, from.key, target.key, target.tasks, index, { today, now: new Date(), timeZone: ctx.timeZone });
    void run(ops, target.key === from.key ? undefined : { text: `„${task.title}” → ${target.label}`, undo });
  };

  const title = list ? `Tablica · ${list.name}` : `Tablica · ${data.workspaces.find((w) => w.id === ctx.workspaceId)?.name ?? 'wszystko'}`;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title }} />
      <View style={styles.top}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Kolumny: ${BOARD_BY[by]}`}
          onPress={() => void pickOption<BoardBy>('Kolumny według', (Object.keys(BOARD_BY) as BoardBy[]).map((k) => ({ label: BOARD_BY[k], value: k, selected: k === by }))).then((v) => v && setBy(v))}
          style={[styles.by, { borderColor: p.border }]}
        >
          <Text style={{ color: p.fg, fontSize: 13 }}>Kolumny: {BOARD_BY[by]}</Text>
        </Pressable>
        {by === 'status' ? <Text style={{ color: p.muted, fontSize: 12 }}>„Gotowe” z ostatnich 7 dni</Text> : null}
      </View>
      <FilterBar query={filter} onChange={setFilter} hide={list ? ['lists'] : []} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabs}>
        {columns.map((c) => (
          <Chip key={c.key} label={`${c.label} ${c.tasks.length}`} selected={c.key === column?.key} onPress={() => setSelected(c.key)} />
        ))}
      </ScrollView>
      {column ? (
        <FlatList
          data={column.tasks}
          keyExtractor={(t) => t.id}
          renderItem={({ item }) => (
            <View style={[styles.card, { borderColor: p.border }]}>
              <View style={{ flex: 1 }}>
                <TaskRow
                  task={item}
                  today={today}
                  showDate={by !== 'weekday'}
                  listName={list ? undefined : listLabel(data, item.listId)}
                  progress={children.get(item.id)}
                  tagNames={by === 'tag' ? undefined : item.tagIds.map((id) => tagName.get(id) ?? '').filter(Boolean)}
                />
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Przenieś „${item.title}”`} hitSlop={6} onPress={() => void moveCard(item, column)} style={styles.move}>
                <Text style={{ color: p.accent, fontSize: 18 }}>⇄</Text>
              </Pressable>
            </View>
          )}
          ListEmptyComponent={<Text style={[styles.empty, { color: p.muted }]}>Pusta kolumna.</Text>}
          contentContainerStyle={{ paddingBottom: 48 + insets.bottom }}
        />
      ) : (
        <Text style={[styles.empty, { color: p.muted }]}>{by === 'tag' ? 'Brak tagów.' : 'Brak kolumn.'}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 10 },
  by: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  tabs: { gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  tabBar: { flexGrow: 0, flexShrink: 0 },
  card: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  move: { paddingHorizontal: 14, paddingVertical: 12 },
  empty: { padding: 24, textAlign: 'center' },
});
