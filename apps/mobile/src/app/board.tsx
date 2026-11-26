/**
 * Uproszczona tablica kanban (MVP-4, M10 na telefonie): kolumny z `core/kanban.ts`
 * (`boardColumns`) — jedna kolumna na ekranie, przełączana zakładkami z licznikami; kartę
 * przenosi menu „⇄” (do innej kolumny na początek, wyżej / niżej w kolumnie) albo przytrzymanie i
 * przeciągnięcie (`BoardCard`: miejsce w kolumnie — kreska; zakładka innej kolumny — na jej początek;
 * przy krawędzi listy przewija) przez `boardDropOps`, jak przeciąganie na webie (atrybut kolumny +
 * `board_sort_key`, z „Cofnij”). Na tablicy przytrzymanie przeciąga zamiast zaznaczać. Kolumna bez wartości
 * („Do przypisania” / „Bez terminu” / „Bez tagu”) jest pierwsza i przypięta — przewijają się pozostałe.
 * Tryb „Własne” (tylko tablica listy): kolumny z `lists.board_columns` — dodanie, zmiana nazwy,
 * przesunięcie, usunięcie (z „Cofnij”) jak na webie; „Dodaj kartę” nad kartami ustawia pola kolumny.
 * `?list=` — tablica listy (kryterium w `view_prefs.boardBy`, chipy filtra zapisane w `view_prefs.filter`
 * jak na ekranie listy), `?view=` — widoku zbiorczego (`smartBoard`, kryterium w `settings.views`), bez — bieżącej przestrzeni (chipy filtra bez listy pamiętane per widok do zamknięcia aplikacji, wspólne z zakładką widoku — R-06)
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
  SMART_VIEW,
  smartBoard,
  smartViewsPatch,
  tagsForWorkspace,
  type BoardBy,
  type BoardColumn,
  type BoardColumnDef,
  type FilterQuery,
  type LocalDate,
  type SmartView,
  type TaskOp,
  type ViewTask,
} from '@taskplanner/core';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentRef, type ReactNode } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTaskActions } from '@/components/actions';
import { ExportChip } from '@/components/export-button';
import { FilterBar } from '@/components/filter-bar';
import { WorkspaceSwitcher } from '@/components/header';
import { pickOption, type Option } from '@/components/pickers';
import { QuickAddField } from '@/components/quick-add-field';
import { RowsInteractive, TaskRow } from '@/components/task-row';
import { Chip, usePalette } from '@/components/ui';
import { useAdhocFilter } from '@/lib/adhoc-filters';
import { listEditable, listLabel, targetInbox, useLocalMinute, useView } from '@/lib/app-data';
import { updateSettings } from '@/lib/profile';
import { mutate } from '@/lib/sync';

const BY_KEY = 'board.by';
const NO_FILTER: FilterQuery = {};

type Move = { kind: 'column'; key: string } | { kind: 'up' } | { kind: 'down' };
/** Cel przeciągania: miejsce w bieżącej kolumnie (indeks bez przeciąganej karty) albo zakładka innej kolumny. */
type Drop = { kind: 'list'; index: number } | { kind: 'column'; key: string };
type Rect = { x: number; y: number; w: number; h: number };
type ViewRef = ComponentRef<typeof View>;
/** Strefa przy górnej / dolnej krawędzi listy, w której przeciąganie przewija (px). */
const EDGE = 56;

/** Gest karty: z `BoardScreen` przez ref — stałe funkcje, więc gest nie konfiguruje się przy każdym rysowaniu. */
interface DragApi {
  start: (task: ViewTask, card: ViewRef | null, x: number, y: number) => void;
  move: (dx: number, dy: number) => void;
  end: (canceled: boolean) => void;
}

const measure = (view: ViewRef | null | undefined): Promise<Rect | null> =>
  new Promise((resolve) => (view ? view.measureInWindow((x, y, w, h) => resolve({ x, y, w, h })) : resolve(null)));

const dropKey = (d: Drop | null) => (!d ? '' : d.kind === 'list' ? `#${d.index}` : `>${d.key}`);

const inside = (r: Rect, x: number, y: number, slop = 6) => x >= r.x - slop && x <= r.x + r.w + slop && y >= r.y - slop && y <= r.y + r.h + slop;

export default function BoardScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { list: listId, view: viewParam } = useLocalSearchParams<{ list?: string; view?: string }>();
  const view = !listId && viewParam && viewParam in SMART_VIEW ? (viewParam as SmartView) : null;
  const { data, today, ctx } = useView();
  const { run, notify } = useTaskActions();
  const list = listId ? data.lists.find((l) => l.id === listId) : undefined;
  const now = useLocalMinute(ctx.timeZone);
  const inboxIds = useMemo(() => new Set(data.lists.filter((l) => l.kind === 'inbox').map((l) => l.id)), [data.lists]);
  // Inbox jednej przestrzeni ma własne kolumny swojej listy.
  const inboxes = view === 'inbox' ? data.lists.filter((l) => l.kind === 'inbox' && (!ctx.workspaceId || l.workspaceId === ctx.workspaceId)) : [];
  const owner = list ?? (inboxes.length === 1 ? inboxes[0] : undefined);
  // Lista tylko do podglądu (gość): bez dodawania kart i zmian kolumn.
  const locked = owner ? !listEditable(data, owner.id) : false;
  const [localBy, setLocalBy] = useState<BoardBy>(() => (Storage.getItemSync(BY_KEY) as BoardBy | null) ?? 'status');
  // Własne kolumny należą do listy — tablica przestrzeni (bez `?list=`) ich nie ma.
  const savedBy: BoardBy = list ? (list.prefs.boardBy ?? 'status') : view ? (data.settings.views[view]?.boardBy ?? (view === 'upcoming' ? 'weekday' : 'status')) : localBy;
  const by: BoardBy = savedBy === 'custom' && !owner ? 'status' : savedBy;
  const defs = useMemo(() => (by === 'custom' ? (owner?.boardColumns ?? []) : []), [by, owner?.boardColumns]);
  const setBy = (next: BoardBy) => {
    if (list) void mutate('lists', list.id, { view_prefs: { ...list.prefs, boardBy: next } }).catch((e: unknown) => notify(String(e)));
    else if (view) void updateSettings((s) => ({ views: smartViewsPatch(s.views, view, { boardBy: next }) })).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
    else {
      Storage.setItemSync(BY_KEY, next);
      setLocalBy(next);
    }
  };

  // Tablica widoku dzieli filtr doraźny z jego zakładką (R-06).
  const [localFilter, setLocalFilter] = useAdhocFilter(data.userId, view ?? 'board');
  const filter = list ? (list.prefs.filter ?? NO_FILTER) : localFilter;
  const setFilter = (next: FilterQuery) => {
    if (!list) return setLocalFilter(next);
    const prefs = { ...list.prefs };
    delete prefs.filter;
    if (!isEmptyFilter(next)) prefs.filter = next;
    void mutate('lists', list.id, { view_prefs: prefs }).catch((e: unknown) => notify(String(e)));
  };
  // Minuta liczy się tylko dla „Zaległych” — inne tablice nie przeliczają się z zegarem.
  const minute = view === 'overdue' ? now : '';
  const { tasks, smart } = useMemo(() => {
    const own = view ? data.tasks : data.tasks.filter((t) => (listId ? t.listId === listId : !ctx.workspaceId || t.workspaceId === ctx.workspaceId));
    const shown = isEmptyFilter(filter) ? own : applyFilter(own, filter, today);
    const smart = view ? smartBoard(view, shown, ctx, { inboxIds, now: minute }) : null;
    return { tasks: smart?.tasks ?? shown, smart };
  }, [data.tasks, listId, view, ctx, inboxIds, minute, filter, today]);
  const canAdd = !locked && (!smart || smart.addDue !== undefined);
  const doneNote = smart ? smart.doneNote : '„Gotowe” z ostatnich 7 dni';
  const newListId = list?.id ?? (view ? targetInbox(data, ctx.workspaceId ?? null)?.id : undefined);
  const lists = useMemo(() => {
    const used = new Set(tasks.map((t) => t.listId));
    return data.lists.filter((l) => used.has(l.id) || l.id === listId).map((l) => ({ ...l, name: listLabel(data, l.id) }));
  }, [data, tasks, listId]);
  // Kolumny tagów: tagi przestrzeni tablicy (wybranej albo wspólnej dla jej list) + użyte na kartach.
  const tags = useMemo(() => {
    const space = ctx.workspaceId ?? (lists.length && lists.every((l) => l.workspaceId === lists[0]!.workspaceId) ? lists[0]!.workspaceId : null);
    return tagsForWorkspace(data.tags, space, tasks.flatMap((t) => t.tagIds));
  }, [data.tags, ctx.workspaceId, lists, tasks]);
  const columns = useMemo(() => boardColumns(tasks, by, { today, firstDayOfWeek: ctx.firstDayOfWeek, ...smart?.options }, { tags, lists, columns: defs }), [tasks, by, today, ctx.firstDayOfWeek, smart, tags, lists, defs]);
  const [selected, setSelected] = useState<string | null>(null);
  // Na start pierwsza kolumna z wartością (dzień / tag / własna), nie przypięta kolumna bez wartości.
  // Widok zbiorczy otwiera się na pierwszej kolumnie z kartami.
  const column = columns.find((c) => c.key === selected) ?? (view ? columns.find((c) => c.tasks.length) : undefined) ?? columns.find((c) => c.key !== 'none') ?? columns[0];
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
    if (!owner || !naming) return;
    const { id, name } = naming;
    const ok = id
      ? editColumns((current) => renameBoardColumnOps(owner.id, current, id, name))
      : editColumns((current) => {
          const added = addBoardColumnOps(owner.id, current, name);
          setSelected(added.id);
          return added.ops;
        });
    if (ok) setNaming(null);
  };
  const customColumn = by === 'custom' && owner && column && column.key !== 'none' ? column : undefined;
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

  // Szary wiersz karty: rodzic podzadania (widoki zbiorcze) i lista, gdy tablica ma ich kilka.
  const cardNote = (task: ViewTask) => {
    const parent = task.parentId && smart?.options.subtasks ? data.tasks.find((t) => t.id === task.parentId) : undefined;
    const name = owner ? undefined : listLabel(data, task.listId);
    return parent ? `↑ ${parent.title}${name ? ` · ${name}` : ''}` : name;
  };
  const moveCard = async (task: ViewTask, from: BoardColumn) => {
    const at = from.tasks.findIndex((t) => t.id === task.id);
    const options: Option<Move>[] = [
      ...(at > 0 ? [{ label: '↑ Wyżej', value: { kind: 'up' } as Move }] : []),
      ...(at < from.tasks.length - 1 ? [{ label: '↓ Niżej', value: { kind: 'down' } as Move }] : []),
      ...columns.filter((c) => c.key !== from.key && !c.fixed).map((c) => ({ label: `→ ${c.label}`, hint: `${c.tasks.length}`, value: { kind: 'column', key: c.key } as Move })),
    ];
    const move = await pickOption(`„${task.title}”`, options);
    if (!move) return;
    const target = move.kind === 'column' ? columns.find((c) => c.key === move.key) : from;
    if (!target) return;
    dropCard(task, from, target, move.kind === 'column' ? 0 : move.kind === 'up' ? at - 1 : at + 1);
  };
  const dropCard = (task: ViewTask, from: BoardColumn, target: BoardColumn, index: number) => {
    if (by === 'tag' && target.key !== from.key && target.key !== 'none' && task.tagIds.includes(target.key)) return notify('Zadanie ma już ten tag.');
    if (target.fixed && target.key !== from.key) return notify(`Na kolumnę „${target.label}” nie da się przenieść — wybierz dzień.`);
    const { ops, undo } = boardDropOps(task, data.tasks, by, from.key, target.key, target.tasks, index, { today, now: new Date(), timeZone: ctx.timeZone });
    void run(ops, target.key === from.key ? undefined : { text: `„${task.title}” → ${target.label}`, undo });
  };

  // ── Przeciąganie karty ──────────────────────────────────────────────────────────────────────
  // Wszystko we współrzędnych okna (`measureInWindow`): karta, zakładki, lista; palec = karta +
  // miejsce chwytu + przesunięcie gestu. Miejsce w kolumnie liczy się w treści listy (położenia
  // komórek z `onLayout`, przewinięcie od startu), więc działa też w trakcie przewijania.
  const [drag, setDrag] = useState<ViewTask | null>(null);
  const [drop, setDropState] = useState<Drop | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const setDrop = (next: Drop | null) => {
    if (dropKey(dropRef.current) === dropKey(next)) return;
    dropRef.current = next;
    setDropState(next);
  };
  const listRef = useRef<FlatList<ViewTask>>(null);
  const rootRef = useRef<ViewRef>(null);
  const listBox = useRef<ViewRef>(null);
  // Zmienne mapy (nie do rysowania): zakładki kolumn i położenia kart z komórek listy.
  const [chipViews] = useState(() => new Map<string, ViewRef>());
  const [cells] = useState(() => new Map<string, { y: number; h: number }>());
  const scroll = useRef(0);
  const ghostY = useSharedValue(0);
  const ghost = useAnimatedStyle(() => ({ transform: [{ translateY: ghostY.value }] }));
  const session = useRef<{
    task: ViewTask;
    from: BoardColumn;
    card: Rect;
    root: Rect;
    list: Rect;
    chips: { key: string; rect: Rect }[];
    grab: { x: number; y: number };
    cellY: number;
    scroll0: number;
    t: { x: number; y: number };
    frame: number | null;
  } | null>(null);

  const locate = () => {
    const s = session.current;
    if (!s) return;
    const fx = s.card.x + s.grab.x + s.t.x;
    const fy = s.card.y + s.grab.y + s.t.y;
    ghostY.set(s.card.y - s.root.y + s.t.y);
    const chip = s.chips.find((c) => inside(c.rect, fx, fy));
    if (chip) return setDrop(chip.key === s.from.key ? null : { kind: 'column', key: chip.key });
    if (fy < s.list.y - EDGE) return setDrop(null);
    // Środek palca w treści listy → liczba kart (bez przeciąganej) nad nim.
    const contentY = s.cellY + s.grab.y + s.t.y + (scroll.current - s.scroll0);
    let index = 0;
    for (const t of s.from.tasks) {
      if (t.id === s.task.id) continue;
      const cell = cells.get(t.id);
      if (!cell || cell.y + cell.h / 2 > contentY) break;
      index++;
    }
    setDrop({ kind: 'list', index });
  };
  // Przewijanie przy krawędzi listy — co klatkę, szybciej im bliżej krawędzi.
  const tick = () => {
    const s = session.current;
    if (!s) return;
    const fy = s.card.y + s.grab.y + s.t.y;
    const top = s.list.y + EDGE - fy;
    const bottom = fy - (s.list.y + s.list.h - EDGE);
    const speed = top > 0 ? -Math.min(top, EDGE) / 4 : bottom > 0 ? Math.min(bottom, EDGE) / 4 : 0;
    if (speed && !(speed < 0 && scroll.current <= 0)) {
      scroll.current = Math.max(0, scroll.current + speed);
      listRef.current?.scrollToOffset({ offset: scroll.current, animated: false });
      locate();
    }
    s.frame = requestAnimationFrame(tick);
  };
  const dragApi = useRef<DragApi>(null!);
  useLayoutEffect(() => {
    dragApi.current = {
      start: (task, card, x, y) => {
        if (!column) return;
        const from = column;
        void Haptics.selectionAsync().catch(() => undefined);
        void Promise.all([measure(card), measure(rootRef.current), measure(listBox.current), ...[...chipViews].map(async ([key, v]) => ({ key, rect: await measure(v) }))]).then(
          ([cardRect, root, list, ...chips]) => {
            if (!cardRect || !root || !list) return;
            const t = session.current?.t ?? { x: 0, y: 0 };
            session.current = {
              task,
              from,
              card: cardRect,
              root,
              list,
              chips: chips.flatMap((c) => (c.rect ? [{ key: c.key, rect: c.rect }] : [])),
              grab: { x, y },
              cellY: cells.get(task.id)?.y ?? 0,
              scroll0: scroll.current,
              t,
              frame: null,
            };
            setDrag(task);
            locate();
            session.current.frame = requestAnimationFrame(tick);
          },
        );
      },
      move: (dx, dy) => {
        if (!session.current) return;
        session.current.t = { x: dx, y: dy };
        locate();
      },
      end: (canceled) => {
        const s = session.current;
        const target = dropRef.current;
        session.current = null;
        if (s?.frame != null) cancelAnimationFrame(s.frame);
        setDrag(null);
        setDrop(null);
        if (!s || canceled || !target) return;
        if (target.kind === 'column') {
          const to = columns.find((c) => c.key === target.key);
          if (to) dropCard(s.task, s.from, to, 0);
          return;
        }
        const at = s.from.tasks.filter((t) => t.id !== s.task.id).length;
        const was = s.from.tasks.findIndex((t) => t.id === s.task.id);
        if (target.index !== was) dropCard(s.task, s.from, s.from, Math.min(target.index, at));
      },
    };
  });
  const rest = drag && column ? column.tasks.filter((t) => t.id !== drag.id) : (column?.tasks ?? []);
  const insertBefore = drop?.kind === 'list' ? (rest[drop.index]?.id ?? null) : undefined;
  const hover = drop?.kind === 'column' ? drop.key : null;
  const chipRef = (key: string) => (v: ViewRef | null) => {
    if (v) chipViews.set(key, v);
    else chipViews.delete(key);
  };

  // Przestrzeń wybiera przełącznik w nagłówku (tablica listy jej nie używa); nazwa jest w nim, nie w tytule.
  const title = list ? `Tablica · ${list.name}` : view ? `Tablica · ${SMART_VIEW[view]}` : 'Tablica';

  return (
    <View ref={rootRef} collapsable={false} style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title, headerRight: list ? undefined : () => <WorkspaceSwitcher /> }} />
      <View style={styles.top}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Kolumny: ${BOARD_BY[by]}`}
          onPress={() => void pickOption<BoardBy>('Kolumny według', (Object.keys(BOARD_BY) as BoardBy[]).filter((k) => k !== 'custom' || owner).map((k) => ({ label: BOARD_BY[k], value: k, selected: k === by }))).then((v) => v && setBy(v))}
          style={[styles.by, { borderColor: p.border }]}
        >
          <Text style={{ color: p.fg, fontSize: 13 }}>Kolumny: {BOARD_BY[by]}</Text>
        </Pressable>
        {by === 'status' && doneNote ? <Text style={{ color: p.muted, fontSize: 12 }}>{doneNote}</Text> : null}
        <ExportChip title={title} rows={() => columns.flatMap((c) => c.tasks.map((task) => ({ task, section: c.label })))} />
      </View>
      <FilterBar query={filter} onChange={setFilter} hide={list || view === 'inbox' ? ['lists'] : []} save />
      <View style={styles.tabRow}>
        {pinned ? (
          <View style={[styles.pinned, { borderColor: p.border }]}>
            <View ref={chipRef(pinned.key)} collapsable={false}>
              <Chip label={`${pinned.label} ${pinned.tasks.length}`} selected={pinned.key === column?.key || hover === pinned.key} onPress={() => setSelected(pinned.key)} />
            </View>
          </View>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={[styles.tabs, pinned ? { paddingLeft: 8 } : null]}>
          {scrolled.map((c) => (
            <View key={c.key} ref={chipRef(c.key)} collapsable={false}>
              <Chip label={`${c.label} ${c.tasks.length}`} selected={c.key === column?.key || hover === c.key} onPress={() => setSelected(c.key)} />
            </View>
          ))}
          {by === 'custom' && owner && !locked ? <Chip label="+ Kolumna" onPress={() => setNaming({ id: null, name: '' })} /> : null}
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
      ) : customColumn && owner && !locked ? (
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
            onPress={() => editColumns((current) => moveBoardColumnOps(owner.id, current, customColumn.key, customIndex - 1))}
          >
            <Text style={[styles.tool, { color: customIndex <= 0 ? p.muted : p.accent }]}>←</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Przesuń kolumnę w prawo"
            disabled={customIndex >= defs.length - 1}
            hitSlop={6}
            onPress={() => editColumns((current) => moveBoardColumnOps(owner.id, current, customColumn.key, customIndex + 1))}
          >
            <Text style={[styles.tool, { color: customIndex >= defs.length - 1 ? p.muted : p.accent }]}>→</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Usuń kolumnę"
            hitSlop={6}
            onPress={() => {
              setSelected(null);
              editColumns((current) => removeBoardColumnOps(owner.id, current, customColumn.key, data.tasks), `Usunięto kolumnę „${customColumn.label}”`);
            }}
          >
            <Text style={[styles.tool, { color: p.bad }]}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      {column ? (
        <View ref={listBox} collapsable={false} style={{ flex: 1 }}>
          <CellLayouts.Provider value={cells}>
            <FlatList
              ref={listRef}
              ListHeaderComponent={
                !canAdd || column.fixed ? undefined : (
                  <View style={styles.addCard}>
                    <QuickAddField key={`${by}:${column.key}`} listId={newListId} dueDate={smart?.addDue} placeholder="Dodaj kartę" {...addProps} />
                  </View>
                )
              }
              keyboardShouldPersistTaps="handled"
              data={column.tasks}
              extraData={insertBefore}
              keyExtractor={(t) => t.id}
              CellRendererComponent={Cell}
              onScroll={(e) => (scroll.current = e.nativeEvent.contentOffset.y)}
              scrollEventThrottle={16}
              scrollEnabled={!drag}
              renderItem={({ item }) => (
                <BoardCard task={item} api={dragApi} enabled={listEditable(data, item.listId)}>
                  {insertBefore === item.id ? <View style={[styles.dropLine, { backgroundColor: p.accent }]} /> : null}
                  <View style={[styles.card, { borderColor: p.border, opacity: drag?.id === item.id ? 0.3 : 1 }]}>
                    <View style={{ flex: 1 }}>
                      <TaskRow
                        task={item}
                        today={today}
                        showDate={by !== 'weekday'}
                        listName={cardNote(item)}
                        progress={children.get(item.id)}
                        tagNames={by === 'tag' ? undefined : item.tagIds.map((id) => tagName.get(id) ?? '').filter(Boolean)}
                      />
                    </View>
                    {listEditable(data, item.listId) ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={`Przenieś „${item.title}”`} hitSlop={6} onPress={() => void moveCard(item, column)} style={styles.move}>
                        <Text style={{ color: p.accent, fontSize: 18 }}>⇄</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </BoardCard>
              )}
              ListFooterComponent={insertBefore === null ? <View style={[styles.dropLine, { backgroundColor: p.accent }]} /> : undefined}
              ListEmptyComponent={<Text style={[styles.empty, { color: p.muted }]}>Pusta kolumna.</Text>}
              contentContainerStyle={{ paddingBottom: 48 + insets.bottom }}
            />
          </CellLayouts.Provider>
        </View>
      ) : (
        <Text style={[styles.empty, { color: p.muted }]}>{by === 'tag' ? 'Brak tagów.' : 'Brak kolumn.'}</Text>
      )}
      {drag ? (
        <Animated.View pointerEvents="none" style={[styles.ghost, { backgroundColor: p.bg, borderColor: p.accent }, ghost]}>
          <RowsInteractive.Provider value={false}>
            <TaskRow task={drag} today={today} showDate={by !== 'weekday'} progress={children.get(drag.id)} />
          </RowsInteractive.Provider>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Położenia kart w treści listy (y, wysokość) — z komórek `FlatList`, dla miejsca upuszczenia. */
const CellLayouts = createContext<Map<string, { y: number; h: number }> | null>(null);

function Cell({ item, onLayout, onFocusCapture, style, children }: {
  item: ViewTask;
  onLayout?: (e: LayoutChangeEvent) => void;
  onFocusCapture?: ComponentProps<typeof View>['onFocusCapture'];
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const layouts = useContext(CellLayouts);
  return (
    <View
      style={style}
      onFocusCapture={onFocusCapture}
      onLayout={(e) => {
        layouts?.set(item.id, { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height });
        onLayout?.(e);
      }}
    >
      {children}
    </View>
  );
}

/** Karta tablicy z gestem przeciągania: przytrzymanie (300 ms, przed zaznaczaniem wiersza po 350 ms), potem ruch. */
function BoardCard({ task, api, enabled, children }: { task: ViewTask; api: { current: DragApi }; enabled: boolean; children: ReactNode }) {
  const ref = useRef<ViewRef>(null);
  const pan = usePanGesture({
    enabled,
    runOnJS: true,
    activateAfterLongPress: 300,
    onActivate: (e) => api.current.start(task, ref.current, e.x, e.y),
    onUpdate: (e) => api.current.move(e.translationX, e.translationY),
    onDeactivate: (e) => api.current.end(e.canceled),
  });
  return (
    <GestureDetector gesture={pan}>
      <View ref={ref} collapsable={false}>
        {children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 10 },
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
  dropLine: { height: 3, marginHorizontal: 8, borderRadius: 2 },
  ghost: { position: 'absolute', top: 0, left: 6, right: 6, borderWidth: 1.5, borderRadius: 8, overflow: 'hidden', elevation: 8, opacity: 0.95 },
  empty: { padding: 24, textAlign: 'center' },
});
