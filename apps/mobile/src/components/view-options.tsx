/**
 * Opcje widoku w nagłówku ekranu: chipy „Kolumny” / „Tagi w kolumnie” (ekran listy i widoki zbiorcze)
 * oraz `useSmartView` — ustawienia Inboxu, „Dziś”, „Zaległych” i „Nadchodzących” z `settings.views`
 * profilu (wspólne z webem) z chipem „▦ Tablica” (`/board?view=`).
 */
import { LIST_COLUMN, orderedColumns, smartViewsPatch, tagsForWorkspace, type ListColumn, type SmartView, type SmartViewPrefs, type ViewTask } from '@taskplanner/core';
import { router } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppData } from '@/lib/app-data';
import { updateSettings } from '@/lib/profile';
import { rowMaker } from '@/lib/rows';

import { useTaskActions } from './actions';
import { pickMany } from './pickers';
import { TaskColumnsHeader } from './task-row';
import { usePalette } from './ui';

/** Kolumny widoku: ustalona kolejność i tagi kolumny „Tagi” — wybrane (tylko istniejące) albo `null` = wszystkie. */
export function useColumns(prefs: SmartViewPrefs | undefined, tags: AppData['tags']) {
  const prefColumns = prefs?.columns;
  const columnTagIds = prefs?.columnTags;
  const columns = useMemo(() => orderedColumns(prefColumns), [prefColumns]);
  const columnTags = useMemo(() => {
    const known = (columnTagIds ?? []).filter((id) => tags.some((t) => t.id === id));
    return known.length ? new Set(known) : null;
  }, [columnTagIds, tags]);
  return { columns, columnTags };
}

export function OptionChip({ label, onPress, accessibilityLabel, accent }: { label: string; onPress: () => void; accessibilityLabel?: string; accent?: boolean }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={[styles.chip, { borderColor: p.border }]}>
      <Text style={{ color: accent ? p.accent : p.fg, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export const OptionRow = ({ children }: { children: ReactNode }) => <View style={styles.row}>{children}</View>;

export function ColumnChips({
  columns,
  columnTags,
  tags,
  onChange,
}: {
  columns: readonly ListColumn[];
  columnTags: ReadonlySet<string> | null;
  /** Tagi do wyboru w „Tagi w kolumnie”. */
  tags: readonly { id: string; name: string }[];
  onChange: (patch: { columns: ListColumn[] } | { columnTags: string[] }) => void;
}) {
  return (
    <>
      <OptionChip
        label={`Kolumny${columns.length ? ` (${columns.length})` : ''}`}
        accessibilityLabel={`Kolumny: ${columns.length ? columns.map((c) => LIST_COLUMN[c]).join(', ') : 'brak'}`}
        onPress={() =>
          void pickMany<ListColumn>(
            'Kolumny',
            (Object.keys(LIST_COLUMN) as ListColumn[]).map((c) => ({ label: LIST_COLUMN[c], value: c, selected: columns.includes(c) })),
          ).then((v) => v && onChange({ columns: orderedColumns(v) }))
        }
      />
      {columns.includes('tags') ? (
        <OptionChip
          label={`Tagi w kolumnie: ${columnTags ? columnTags.size : 'wszystkie'}`}
          onPress={() =>
            void pickMany<string>(
              'Tagi w kolumnie (żaden = wszystkie)',
              tags.map((t) => ({ label: `@${t.name}`, value: t.id, selected: !!columnTags?.has(t.id) })),
            ).then((v) => v && onChange({ columnTags: v }))
          }
        />
      ) : null}
    </>
  );
}

/** Wiersze z kolumnami widoku: kolumna „Tagi” pokazuje tylko wybrane tagi. */
export function columnRowMaker(data: AppData, today: string, { columns, columnTags }: ReturnType<typeof useColumns>): ReturnType<typeof rowMaker> {
  const base = rowMaker(data, today);
  if (!columns.length) return base;
  const tagById = new Map(data.tags.map((t) => [t.id, t]));
  const shown = (task: ViewTask) => (columnTags && columns.includes('tags') ? { tagItems: task.tagIds.filter((id) => columnTags.has(id)).flatMap((id) => tagById.get(id) ?? []) } : undefined);
  return (task, props) => base(task, { columns, ...shown(task), ...props });
}

/** Widok zbiorczy: `row` z kolumnami, pasek opcji i nagłówek kolumn. */
export function useSmartView(view: SmartView, data: AppData, today: string, workspaceId: string | null) {
  const { notify } = useTaskActions();
  const prefs = data.settings.views[view];
  const cols = useColumns(prefs, data.tags);
  const setPrefs = (patch: Partial<SmartViewPrefs>) => void updateSettings((s) => ({ views: smartViewsPatch(s.views, view, patch) })).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
  return {
    row: columnRowMaker(data, today, cols),
    options: (
      <OptionRow>
        <ColumnChips {...cols} tags={tagsForWorkspace(data.tags, workspaceId, prefs?.columnTags)} onChange={setPrefs} />
        <OptionChip label="▦ Tablica" accent onPress={() => router.push({ pathname: '/board', params: { view } })} />
      </OptionRow>
    ),
    columnsHeader: <TaskColumnsHeader columns={cols.columns} />,
  };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
});
