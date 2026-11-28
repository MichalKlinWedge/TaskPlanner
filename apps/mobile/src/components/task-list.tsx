/**
 * Ekran listy zadań: sekcje (Zaległe / Dziś / dni / grupy) na `SectionList` (wirtualizacja przy
 * tysiącach zadań), przycisk „+” szybkiego dodawania i pasek operacji na zaznaczonych (przy jednym
 * zaznaczonym zadaniu także „+ Podzadanie” — jak „+” przy wierszu na webie).
 * Otwarcie: najpierw ekran z pierwszymi wierszami bez gestów (`initialNumToRender`, `RowsInteractive`),
 * reszta wierszy i gesty przesunięcia w pierwszej wolnej chwili po narysowaniu.
 * Kolumny („Kolumny” widoku), które nie mieszczą się obok tytułu, przewijają wiersze w poziomie
 * (`WideList`); nagłówek ekranu i sekcje stoją wtedy w miejscu (`Sticky`).
 */
import { canAddSubtask, keepShownSelection, nudgeTaskOps, type TaskNudge } from '@taskplanner/core';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { BackHandler, Pressable, SectionList, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';

import { useAppData } from '@/lib/app-data';

import { useTaskActions } from './actions';
import { bulkAssignee, bulkDate, bulkTag, pickList, pickPriority } from './task-menus';
import { columnsRowWidth, RowsInteractive, RowsSelectable, Sticky, TaskRow, WideList, type TaskRowProps } from './task-row';
import { usePalette } from './ui';

export interface RowItem extends TaskRowProps {
  key: string;
}

export interface TaskSection {
  key: string;
  title?: string;
  count?: number;
  tone?: 'bad';
  data: RowItem[];
  /** Pod sekcją (np. „+ Dodaj” na dzień). */
  footer?: ReactNode;
  /** Stopka to wyposażenie widoku (np. „Plan dnia”), nie treść — przy braku zadań pod nią i tak stoi komunikat `empty`. */
  chrome?: boolean;
}

export function TaskSections({ sections, header, empty, quickAdd, reorder }: { sections: TaskSection[]; header?: ReactElement; empty?: string; quickAdd?: QuickAddParams | null; reorder?: readonly string[] }) {
  const p = usePalette();
  const visible = useMemo(() => sections.filter((s) => s.data.length || s.footer), [sections]);
  const blank = !visible.some((s) => s.data.length || (s.footer && !s.chrome));
  // Gesty przesunięcia wierszy dopiero po pierwszym narysowaniu (nikt nie przesuwa wiersza w trakcie otwierania ekranu).
  const [interactive, setInteractive] = useState(false);
  useEffect(() => {
    // Pierwsza wolna chwila wątku JS po narysowaniu (najpóźniej po 500 ms).
    const idle = requestIdleCallback(() => setInteractive(true), { timeout: 500 });
    return () => cancelIdleCallback(idle);
  }, []);
  // Zaznaczenie dotyczy tego ekranu — po wyjściu z niego znika. Po akcji grupowej zostaje (R-12, jak na
  // webie), ale zadania, które zniknęły z widoku (przeniesione, ukończone tam, gdzie ukończonych nie widać), wypadają.
  const { selected, setSelected } = useTaskActions();
  useFocusEffect(useCallback(() => () => setSelected([]), [setSelected]));
  const shown = useMemo(() => new Set(sections.flatMap((s) => s.data.map((row) => row.task.id))), [sections]);
  const shownBefore = useRef(shown);
  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = shown;
    if (!selected.size) return;
    const ids = [...selected];
    const kept = keepShownSelection(ids, before, shown);
    if (kept !== ids) setSelected(kept);
  }, [shown, selected, setSelected]);

  // Szeroka lista: wiersze z kolumnami szersze niż ekran → poziome przewijanie całej listy.
  const window = useWindowDimensions().width;
  const [box, setBox] = useState(0);
  const view = box || window;
  const columns = useMemo(() => visible.find((s) => s.data.length)?.data[0]?.columns ?? [], [visible]);
  const need = columns.length ? columnsRowWidth(columns) : 0;
  const width = need > view ? need : 0;
  const x = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    x.value = e.contentOffset.x;
  });
  useEffect(() => {
    if (!width) x.set(0);
  }, [width, x]);
  const wide = useMemo(() => (width ? { x, view, width } : null), [width, view, x]);

  const emptyText =
    empty && blank ? (
      <Sticky>
        <Text style={[styles.empty, { color: p.muted }]}>{empty}</Text>
      </Sticky>
    ) : undefined;

  const list = (
    <SectionList
      style={width ? { width } : undefined}
      sections={visible}
      keyExtractor={(item) => item.key}
      // `key` tylko dla listy — nie w propsach wiersza (React nie pozwala na `key` w spreadzie).
      renderItem={({ item: { key: _key, ...row } }) => <TaskRow {...row} />}
      renderSectionHeader={({ section }) =>
        section.title ? (
          <View style={{ backgroundColor: p.bg }}>
            <Sticky>
              <View style={[styles.header, { borderColor: p.border }]}>
                <Text style={[styles.headerText, { color: section.tone === 'bad' ? p.bad : p.fg }]}>{section.title}</Text>
                {section.count ? <Text style={{ color: p.muted, fontSize: 12 }}>{section.count}</Text> : null}
              </View>
            </Sticky>
          </View>
        ) : null
      }
      renderSectionFooter={({ section }) => (section.footer ? <Sticky>{section.footer}</Sticky> : null)}
      ListHeaderComponent={header ? <Sticky>{header}</Sticky> : undefined}
      ListEmptyComponent={emptyText}
      ListFooterComponent={
        <>
          {visible.length && blank ? emptyText : null}
          <View style={{ height: 120 }} />
        </>
      }
      stickySectionHeadersEnabled
      // Pierwsza klatka: tyle wierszy, ile widać pod nagłówkiem (wiersz ~60 dp); reszta ekranu dochodzi
      // w następnej porcji. Każdy wiersz więcej to dłuższe otwarcie listy (`docs/WYDAJNOSC.md`).
      initialNumToRender={8}
      windowSize={11}
      keyboardShouldPersistTaps="handled"
    />
  );
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }} onLayout={(e) => setBox(e.nativeEvent.layout.width)}>
      <RowsSelectable.Provider value>
        <RowsInteractive.Provider value={interactive}>
          <WideList.Provider value={wide}>
            {width ? (
              <Animated.ScrollView horizontal onScroll={onScroll} scrollEventThrottle={16} overScrollMode="never" keyboardShouldPersistTaps="handled">
                {list}
              </Animated.ScrollView>
            ) : (
              list
            )}
          </WideList.Provider>
        </RowsInteractive.Provider>
      </RowsSelectable.Provider>
      <BottomBar quickAdd={quickAdd} reorder={reorder} />
    </View>
  );
}

/** Wynik arkusza wyboru → akcja (bez zwracania wartości do `onPress`). */
const then = <T,>(choice: Promise<T>, act: (value: T) => unknown) => void choice.then((value) => void act(value));

/** Parametry ekranu szybkiego dodawania (lista, termin, rodzic, tag). */
export interface QuickAddParams {
  listId?: string;
  dueDate?: string;
  /** Godzina z dotkniętego miejsca kalendarza (z `dueDate`). */
  dueTime?: string;
  parentId?: string;
  /** Nazwa tagu dokładanego do zadania (widok tagu) — dowolna, także spoza gramatyki „@tag”. */
  tag?: string;
}

export const openQuickAdd = (params: QuickAddParams = {}) =>
  router.push({ pathname: '/quick-add', params: Object.fromEntries(Object.entries(params).filter(([, v]) => v)) } as Href);

/** „+” albo — przy zaznaczonych — pasek operacji grupowych. */
export function BottomBar({ quickAdd, reorder }: { quickAdd?: QuickAddParams | null; reorder?: readonly string[] }) {
  const actions = useTaskActions();
  const { selected } = actions;
  if (selected.size) return <BulkBar reorder={reorder} />;
  if (quickAdd === null) return null;
  return <Fab onPress={() => openQuickAdd(quickAdd)} />;
}

/** `bottom` — odstęp od dołu (ekran bez zakładek: + dolny inset systemu). */
export function Fab({ onPress, label = 'Dodaj zadanie', bottom = 16 }: { onPress: () => void; label?: string; bottom?: number }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.fab, { backgroundColor: p.accent, bottom, opacity: pressed ? 0.8 : 1 }]}
    >
      <Text style={[styles.fabText, { color: p.onAccent }]}>+</Text>
    </Pressable>
  );
}

/** `reorder` — widoczne wiersze drzewa z ręczną kolejnością (ekran listy): jedno zaznaczone zadanie można przesuwać. */
function BulkBar({ reorder }: { reorder?: readonly string[] }) {
  const p = usePalette();
  const data = useAppData();
  const actions = useTaskActions();
  const { selected, setSelected, bulk, run, notify } = actions;
  const single = selected.size === 1 ? [...selected][0]! : null;
  // Podzadanie do jednego zaznaczonego (zaznaczyć da się tylko zadanie z listy do edycji).
  const singleTask = single ? data.tasks.find((t) => t.id === single) : undefined;
  const parent = singleTask?.kind === 'task' && canAddSubtask(data.tasks, singleTask.id) ? singleTask : null;
  const nudgeable = !!single && !!reorder?.includes(single);
  // Systemowe „Wstecz” najpierw zdejmuje zaznaczenie.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        setSelected([]);
        return true;
      });
      return () => sub.remove();
    }, [setSelected]),
  );
  const nudge = (move: TaskNudge) => {
    const ops = single && reorder ? nudgeTaskOps(data.tasks, reorder, single, move) : null;
    if (!ops) return notify('Tu nie można przesunąć: brak miejsca w tym kierunku albo ponad 4 poziomy zadań.');
    if (ops.length) void run(ops);
  };
  const items: { label: string; onPress: () => void; tone?: 'bad' }[] = [
    { label: '✓', onPress: () => void bulk({ kind: 'complete' }) },
    { label: 'Dziś', onPress: () => void bulk({ kind: 'today' }) },
    { label: 'Jutro', onPress: () => void bulk({ kind: 'tomorrow' }) },
    { label: '📅', onPress: () => void bulkDate(actions, data) },
    {
      label: '!',
      onPress: () =>
        then(pickPriority(`Priorytet: ${selected.size} zaznaczonych`), (priority) => priority && bulk({ kind: 'priority', priority })),
    },
    { label: '→', onPress: () => then(pickList(data, `Przenieś ${selected.size} zaznaczonych do`), (listId) => listId && bulk({ kind: 'move', listId })) },
    { label: '#', onPress: () => void bulkTag(actions, data) },
    { label: '👤', onPress: () => void bulkAssignee(actions, data) },
    { label: '🗑', tone: 'bad', onPress: () => void bulk({ kind: 'delete' }) },
  ];
  const bar = (
    <View style={[styles.bulk, { backgroundColor: p.card, borderColor: p.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Anuluj zaznaczenie" hitSlop={8} onPress={() => setSelected([])} style={styles.bulkCount}>
        <Text style={{ color: p.muted, fontSize: 16 }}>✕</Text>
        <Text style={{ color: p.fg, fontWeight: '700', fontSize: 16 }}>{selected.size}</Text>
      </Pressable>
      {items.map((item) => (
        <Pressable
          key={item.label}
          accessibilityRole="button"
          accessibilityLabel={BULK_LABEL[item.label]}
          onPress={item.onPress}
          style={({ pressed }) => [styles.bulkButton, { backgroundColor: pressed ? p.border : 'transparent' }]}
        >
          <Text style={{ color: item.tone === 'bad' ? p.bad : p.accent, fontWeight: '700', fontSize: 15 }} numberOfLines={1} adjustsFontSizeToFit>
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
  return (
    <View style={styles.bars}>
      {nudgeable || parent ? (
        <View style={[styles.bulk, { backgroundColor: p.card, borderColor: p.border }]}>
          {nudgeable
            ? NUDGES.map(([move, label]) => (
                <Pressable key={move} accessibilityRole="button" onPress={() => nudge(move)} style={({ pressed }) => [styles.bulkButton, { backgroundColor: pressed ? p.border : 'transparent' }]}>
                  <Text style={{ color: p.accent, fontWeight: '600', fontSize: 14 }}>{label}</Text>
                </Pressable>
              ))
            : null}
          {parent ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Dodaj podzadanie do „${parent.title}”`}
              onPress={() => {
                setSelected([]);
                openQuickAdd({ parentId: parent.id });
              }}
              style={({ pressed }) => [styles.bulkButton, { flex: nudgeable ? 1.3 : 1, backgroundColor: pressed ? p.border : 'transparent' }]}
            >
              <Text style={{ color: p.accent, fontWeight: '600', fontSize: 14 }} numberOfLines={1} adjustsFontSizeToFit>
                + Podzadanie
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {bar}
    </View>
  );
}

const NUDGES: [TaskNudge, string][] = [
  ['up', '↑ wyżej'],
  ['down', '↓ niżej'],
  ['in', '⇥ w głąb'],
  ['out', '⇤ w górę'],
];

const BULK_LABEL: Record<string, string> = {
  '✓': 'Ukończ zaznaczone',
  Dziś: 'Na dziś',
  Jutro: 'Na jutro',
  '📅': 'Wybierz termin',
  '!': 'Zmień priorytet',
  '→': 'Przenieś do listy',
  '#': 'Dodaj albo zdejmij tag',
  '👤': 'Zmień odpowiedzialnego',
  '🗑': 'Przenieś do kosza',
};

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  headerText: { fontSize: 14, fontWeight: '700' },
  empty: { textAlign: 'center', paddingVertical: 40, fontSize: 15 },
  fab: { position: 'absolute', right: 18, width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', elevation: 5 },
  fabText: { color: '#fff', fontSize: 32, lineHeight: 34, fontWeight: '400' },
  bars: { position: 'absolute', left: 10, right: 10, bottom: 12, gap: 8 },
  bulk: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 6, elevation: 6 },
  bulkCount: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 12 },
  bulkButton: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
});
