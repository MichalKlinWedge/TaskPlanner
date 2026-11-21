/**
 * Uproszczona tablica kanban (MVP-4, M10 na telefonie): kolumny z `core/kanban.ts`
 * (`boardColumns`) — jedna kolumna na ekranie, przełączana zakładkami z licznikami; kartę
 * przenosi menu „⇄” (do innej kolumny na początek, wyżej / niżej w kolumnie) przez `boardDropOps`,
 * jak przeciąganie na webie (atrybut kolumny + `board_sort_key`, z „Cofnij”). Kolumna bez wartości
 * („Do przypisania” / „Bez terminu” / „Bez tagu”) jest pierwsza i przypięta — przewijają się pozostałe.
 * Tryb „Własne” (tylko tablica listy): kolumny z `lists.board_columns` — dodanie, zmiana nazwy,
 * przesunięcie, usunięcie (z „Cofnij”) jak na webie; „Dodaj kartę” nad kartami ustawia pola kolumny.
 * `?list=` — tablica listy (kryterium w `view_prefs.boardBy`, chipy filtra zapisane w `view_prefs.filter`
 * jak na ekranie listy), bez — bieżącej przestrzeni (chipy filtra w pamięci do zamknięcia aplikacji)
 * (kryterium zapamiętane na urządzeniu).
 */
import {
  addBoardColumnOps,
  applyFilter,
  BOARD_BY,
  boardColumns,
  boardDropOps,
  isEmptyFilter,
  moveBoardColumnOps,
  removeBoardColumnOps,
  renameBoardColumnOps,
  tagsForWorkspace,
  type BoardBy,
  type BoardColumn,
  type BoardColumnDef,
  type FilterQuery,
  type LocalDate,
  type TaskOp,
  type ViewTask,
} from '@taskplanner/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { pickOption, type Option } from '@/components/pickers';
import { QuickAddField } from '@/components/quick-add-field';
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
  // Własne kolumny należą do listy — tablica przestrzeni (bez `?list=`) ich nie ma.
  const savedBy: BoardBy = list ? (list.prefs.boardBy ?? 'status') : localBy;
  const by: BoardBy = savedBy === 'custom' && !list ? 'status' : savedBy;
  const defs = useMemo(() => (by === 'custom' ? (list?.boardColumns ?? []) : []), [by, list?.boardColumns]);
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
  const columns = useMemo(() => boardColumns(tasks, by, { today, firstDayOfWeek: ctx.firstDayOfWeek }, { tags, lists, columns: defs }), [tasks, by, today, ctx.firstDayOfWeek, tags, lists, defs]);
  const [selected, setSelected] = useState<string | null>(null);
  // Na start pierwsza kolumna z wartością (dzień / tag / własna), nie przypięta kolumna bez wartości.
  const column = columns.find((c) => c.key === selected) ?? columns.find((c) => c.key !== 'none') ?? columns[0];
  const pinned = columns[0]?.key === 'none' ? columns[0] : undefined;
  const scrolled = pinned ? columns.slice(1) : columns;

  // Kolumny po ostatniej własnej zmianie: dwie zmiany szybciej niż odświeżenie danych nie nadpisują się.
  const latest = useRef<readonly BoardColumnDef[]>(defs);
  useEffect(() => {
    latest.current = defs;
  }, [defs]);
  const editColumns = (make: (current: readonly BoardColumnDef[]) => TaskOp[] | { ops: TaskOp[]; undo?: TaskOp[] }, text?: string): boolean => {
    try {
      const result = make(latest.current);
      const { ops, undo } = Array.isArray(result) ? { ops: result, undo: undefined } : result;
      const next = ops.find((op) => op.table === 'lists')?.patch.board_columns;
      if (next !== undefined) latest.current = (next as BoardColumnDef[] | null) ?? [];
      if (ops.length) void run(ops, text ? { text, undo } : undefined);
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  // Pole nazwy: nowa kolumna (`id` = null) albo zmiana nazwy wybranej.
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  const saveName = () => {
    if (!list || !naming) return;
    const { id, name } = naming;
    const ok = id
      ? editColumns((current) => renameBoardColumnOps(list.id, current, id, name))
      : editColumns((current) => {
          const added = addBoardColumnOps(list.id, current, name);
          setSelected(added.id);
          return added.ops;
        });
    if (ok) setNaming(null);
  };
  const customColumn = by === 'custom' && list && column && column.key !== 'none' ? column : undefined;
  const customIndex = customColumn ? defs.findIndex((d) => d.id === customColumn.key) : -1;

  // Dodanie w kolumnie dostaje jej atrybut (status / priorytet / dzień / tag / lista / własna kolumna).
  const addProps = !column
    ? {}
    : by === 'status'
      ? { defaults: { status: column.key } }
      : by === 'priority'
        ? { defaults: { priority: Number(column.key) } }
        : by === 'weekday'
          ? { dueDate: column.key === 'none' ? null : (column.key as LocalDate) }
          : by === 'tag' && column.key !== 'none'
            ? { defaults: { tagNames: [column.label] } }
            : by === 'list'
              ? { listId: column.key }
              : by === 'custom' && column.key !== 'none'
                ? { defaults: { boardColumnId: column.key } }
                : {};

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
          onPress={() => void pickOption<BoardBy>('Kolumny według', (Object.keys(BOARD_BY) as BoardBy[]).filter((k) => k !== 'custom' || list).map((k) => ({ label: BOARD_BY[k], value: k, selected: k === by }))).then((v) => v && setBy(v))}
          style={[styles.by, { borderColor: p.border }]}
        >
          <Text style={{ color: p.fg, fontSize: 13 }}>Kolumny: {BOARD_BY[by]}</Text>
        </Pressable>
        {by === 'status' ? <Text style={{ color: p.muted, fontSize: 12 }}>„Gotowe” z ostatnich 7 dni</Text> : null}
      </View>
      <FilterBar query={filter} onChange={setFilter} hide={list ? ['lists'] : []} />
      <View style={styles.tabRow}>
        {pinned ? (
          <View style={[styles.pinned, { borderColor: p.border }]}>
            <Chip label={`${pinned.label} ${pinned.tasks.length}`} selected={pinned.key === column?.key} onPress={() => setSelected(pinned.key)} />
          </View>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={[styles.tabs, pinned ? { paddingLeft: 8 } : null]}>
          {scrolled.map((c) => (
            <Chip key={c.key} label={`${c.label} ${c.tasks.length}`} selected={c.key === column?.key} onPress={() => setSelected(c.key)} />
          ))}
          {by === 'custom' && list ? <Chip label="+ Kolumna" onPress={() => setNaming({ id: null, name: '' })} /> : null}
        </ScrollView>
      </View>
      {naming ? (
        <View style={styles.naming}>
          <TextInput
            value={naming.name}
            onChangeText={(name) => setNaming({ ...naming, name })}
            placeholder={naming.id ? 'Nazwa kolumny' : 'Nazwa nowej kolumny'}
            placeholderTextColor={p.muted}
            autoFocus
            maxLength={60}
            returnKeyType="done"
            onSubmitEditing={saveName}
            style={[styles.nameInput, { color: p.fg, borderColor: p.border, backgroundColor: p.card }]}
          />
          <Pressable accessibilityRole="button" onPress={saveName} hitSlop={6}>
            <Text style={{ color: p.accent, fontWeight: '600' }}>{naming.id ? 'Zapisz' : 'Dodaj'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setNaming(null)} hitSlop={6}>
            <Text style={{ color: p.muted }}>Anuluj</Text>
          </Pressable>
        </View>
      ) : customColumn && list ? (
        <View style={styles.columnTools}>
          <Text style={{ color: p.muted, fontSize: 12, flex: 1 }} numberOfLines={1}>
            Kolumna „{customColumn.label}”
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Zmień nazwę kolumny" hitSlop={6} onPress={() => setNaming({ id: customColumn.key, name: customColumn.label })}>
            <Text style={[styles.tool, { color: p.accent }]}>✎</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Przesuń kolumnę w lewo"
            disabled={customIndex <= 0}
            hitSlop={6}
            onPress={() => editColumns((current) => moveBoardColumnOps(list.id, current, customColumn.key, customIndex - 1))}
          >
            <Text style={[styles.tool, { color: customIndex <= 0 ? p.muted : p.accent }]}>←</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Przesuń kolumnę w prawo"
            disabled={customIndex >= defs.length - 1}
            hitSlop={6}
            onPress={() => editColumns((current) => moveBoardColumnOps(list.id, current, customColumn.key, customIndex + 1))}
          >
            <Text style={[styles.tool, { color: customIndex >= defs.length - 1 ? p.muted : p.accent }]}>→</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Usuń kolumnę"
            hitSlop={6}
            onPress={() => {
              setSelected(null);
              editColumns((current) => removeBoardColumnOps(list.id, current, customColumn.key, data.tasks), `Usunięto kolumnę „${customColumn.label}”`);
            }}
          >
            <Text style={[styles.tool, { color: p.bad }]}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      {column ? (
        <FlatList
          ListHeaderComponent={
            <View style={styles.addCard}>
              <QuickAddField key={`${by}:${column.key}`} listId={list?.id} placeholder="Dodaj kartę" {...addProps} />
            </View>
          }
          keyboardShouldPersistTaps="handled"
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
  tabBar: { flexGrow: 1, flexShrink: 1 },
  tabRow: { flexDirection: 'row', alignItems: 'center' },
  pinned: { paddingLeft: 12, paddingRight: 8, borderRightWidth: StyleSheet.hairlineWidth },
  naming: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingBottom: 8 },
  nameInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14 },
  columnTools: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 12, paddingBottom: 6 },
  tool: { fontSize: 17, paddingHorizontal: 2 },
  addCard: { paddingHorizontal: 12 },
  card: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  move: { paddingHorizontal: 14, paddingVertical: 12 },
  empty: { padding: 24, textAlign: 'center' },
});
