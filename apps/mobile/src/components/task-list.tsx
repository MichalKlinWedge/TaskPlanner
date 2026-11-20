/**
 * Ekran listy zadań: sekcje (Zaległe / Dziś / dni / grupy) na `SectionList` (wirtualizacja przy
 * tysiącach zadań), przycisk „+” szybkiego dodawania i pasek operacji na zaznaczonych.
 */
import { router, type Href } from 'expo-router';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { useAppData } from '@/lib/app-data';

import { useTaskActions } from './actions';
import { bulkDate, pickList, pickPriority } from './task-menus';
import { TaskRow, type TaskRowProps } from './task-row';
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
}

export function TaskSections({ sections, header, empty, quickAdd }: { sections: TaskSection[]; header?: ReactElement; empty?: string; quickAdd?: QuickAddParams | null }) {
  const p = usePalette();
  const visible = useMemo(() => sections.filter((s) => s.data.length || s.footer), [sections]);
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <SectionList
        sections={visible}
        keyExtractor={(item) => item.key}
        // `key` tylko dla listy — nie w propsach wiersza (React nie pozwala na `key` w spreadzie).
        renderItem={({ item: { key: _key, ...row } }) => <TaskRow {...row} />}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={[styles.header, { backgroundColor: p.bg, borderColor: p.border }]}>
              <Text style={[styles.headerText, { color: section.tone === 'bad' ? p.bad : p.fg }]}>{section.title}</Text>
              {section.count ? <Text style={{ color: p.muted, fontSize: 12 }}>{section.count}</Text> : null}
            </View>
          ) : null
        }
        renderSectionFooter={({ section }) => (section.footer ? <View>{section.footer}</View> : null)}
        ListHeaderComponent={header}
        ListEmptyComponent={empty ? <Text style={[styles.empty, { color: p.muted }]}>{empty}</Text> : undefined}
        ListFooterComponent={<View style={{ height: 120 }} />}
        stickySectionHeadersEnabled
        initialNumToRender={20}
        windowSize={11}
        keyboardShouldPersistTaps="handled"
      />
      <BottomBar quickAdd={quickAdd} />
    </View>
  );
}

/** Wynik arkusza wyboru → akcja (bez zwracania wartości do `onPress`). */
const then = <T,>(choice: Promise<T>, act: (value: T) => unknown) => void choice.then((value) => void act(value));

/** Parametry ekranu szybkiego dodawania (lista, termin, rodzic). */
export interface QuickAddParams {
  listId?: string;
  dueDate?: string;
  parentId?: string;
}

export const openQuickAdd = (params: QuickAddParams = {}) =>
  router.push({ pathname: '/quick-add', params: Object.fromEntries(Object.entries(params).filter(([, v]) => v)) } as Href);

/** „+” albo — przy zaznaczonych — pasek operacji grupowych. */
export function BottomBar({ quickAdd }: { quickAdd?: QuickAddParams | null }) {
  const actions = useTaskActions();
  const { selected } = actions;
  if (selected.size) return <BulkBar />;
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
      <Text style={styles.fabText}>+</Text>
    </Pressable>
  );
}

function BulkBar() {
  const p = usePalette();
  const data = useAppData();
  const actions = useTaskActions();
  const { selected, setSelected, bulk } = actions;
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
    { label: '🗑', tone: 'bad', onPress: () => void bulk({ kind: 'delete' }) },
  ];
  return (
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
          <Text style={{ color: item.tone === 'bad' ? p.bad : p.accent, fontWeight: '700', fontSize: 15 }}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const BULK_LABEL: Record<string, string> = {
  '✓': 'Ukończ zaznaczone',
  Dziś: 'Na dziś',
  Jutro: 'Na jutro',
  '📅': 'Wybierz termin',
  '!': 'Zmień priorytet',
  '→': 'Przenieś do listy',
  '🗑': 'Przenieś do kosza',
};

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  headerText: { fontSize: 14, fontWeight: '700' },
  empty: { textAlign: 'center', paddingVertical: 40, fontSize: 15 },
  fab: { position: 'absolute', right: 18, width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', elevation: 5 },
  fabText: { color: '#fff', fontSize: 32, lineHeight: 34, fontWeight: '400' },
  bulk: { position: 'absolute', left: 10, right: 10, bottom: 12, flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 6, elevation: 6 },
  bulkCount: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 12 },
  bulkButton: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
});
