/**
 * Opcje widoku w nagłówku ekranu: chipy „Kolumny” / „Tagi w kolumnie” (ekran listy i widoki zbiorcze)
 * oraz `useSmartView` — ustawienia Inboxu, „Dziś”, „Zaległych”, „Nadchodzących” i „Bez terminu” z `settings.views`
 * profilu (wspólne z webem) z chipem „▦ Tablica” (`/board?view=`).
 */
import {
  LIST_COLUMN,
  orderedColumns,
  SMART_SORT_BY,
  smartViewsPatch,
  sortDirLabel,
  tagsForWorkspace,
  type ListColumn,
  type SmartView,
  type SmartViewPrefs,
  type SortBy,
  type SortDir,
  type ViewSettingsKey,
  type ViewTask,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppData } from '@/lib/app-data';
import { updateSettings } from '@/lib/profile';
import { rowMaker } from '@/lib/rows';

import { useTaskActions } from './actions';
import { pickMany, pickOption } from './pickers';
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

/**
 * Kolumny widoku z `settings.views[view]` (wspólne z webem): `row` z kolumnami, chipy i nagłówek kolumn.
 * Widoki zbiorcze i — wspólnie dla wszystkich tagów / zapisanych filtrów — klucze `tag` / `filter`.
 */
export function useViewColumns(view: ViewSettingsKey, data: AppData, today: string, workspaceId: string | null) {
  const { notify } = useTaskActions();
  const prefs = data.settings.views[view];
  const cols = useColumns(prefs, data.tags);
  const setPrefs = (patch: Partial<SmartViewPrefs>) => void updateSettings((s) => ({ views: smartViewsPatch(s.views, view, patch) })).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
  return {
    row: columnRowMaker(data, today, cols),
    chips: <ColumnChips {...cols} tags={tagsForWorkspace(data.tags, workspaceId, prefs?.columnTags)} onChange={setPrefs} />,
    columnsHeader: <TaskColumnsHeader columns={cols.columns} />,
  };
}

/**
 * Chipy sortowania: kryterium (`pickOption`) i — poza „Ręcznie” / „Domyślnie” — kierunek (▲ / ▼).
 * Zmiana kryterium wraca do kierunku domyślnego.
 */
export function SortChips({ by, dir, labels, onChange }: { by: SortBy; dir: SortDir; labels: Record<SortBy, string>; onChange: (patch: { sortBy?: SortBy; sortDir?: SortDir }) => void }) {
  return (
    <>
      <OptionChip
        label={`Sortowanie: ${labels[by]}`}
        onPress={() =>
          void pickOption<SortBy>('Sortowanie', (Object.keys(labels) as SortBy[]).map((k) => ({ label: labels[k], value: k, selected: k === by }))).then(
            (v) => v && onChange({ sortBy: v, sortDir: undefined }),
          )
        }
      />
      {by === 'manual' ? null : (
        <OptionChip
          label={`${dir === 'desc' ? '▼' : '▲'} ${sortDirLabel(by, dir)}`}
          accessibilityLabel={`Kierunek sortowania: ${sortDirLabel(by, dir)} — odwróć`}
          onPress={() => onChange({ sortDir: dir === 'desc' ? undefined : 'desc' })}
        />
      )}
    </>
  );
}

/** Sortowanie widoku zbiorczego z `settings.views` (wspólne z webem); ekrany sortują nim sekcje (`sortSection`). */
export function smartSort(data: AppData, view: SmartView): { by: SortBy; dir: SortDir } {
  const prefs = data.settings.views[view];
  return { by: prefs?.sortBy ?? 'manual', dir: prefs?.sortDir ?? 'asc' };
}

/**
 * Widok zbiorczy: `row` z kolumnami, pasek opcji (z chipami sortowania — `smartSort`; Zaległe bez wyboru,
 * stała kolejność od najstarszego) i nagłówek kolumn. `extra` — dodatkowy chip w wierszu opcji (np. „Eksport XLSX”).
 */
export function useSmartView(view: SmartView, data: AppData, today: string, workspaceId: string | null, extra?: ReactNode) {
  const { row, chips, columnsHeader } = useViewColumns(view, data, today, workspaceId);
  const { notify } = useTaskActions();
  const sort = smartSort(data, view);
  const setSort = (patch: { sortBy?: SortBy; sortDir?: SortDir }) =>
    void updateSettings((s) => ({ views: smartViewsPatch(s.views, view, { ...patch, ...(patch.sortBy === 'manual' && { sortBy: undefined }) }) })).catch((e: unknown) =>
      notify(e instanceof Error ? e.message : String(e)),
    );
  return {
    row,
    options: (
      <OptionRow>
        {view === 'overdue' ? null : <SortChips by={sort.by} dir={sort.dir} labels={SMART_SORT_BY} onChange={setSort} />}
        {chips}
        <OptionChip label="▦ Tablica" accent onPress={() => router.push({ pathname: '/board', params: { view } })} />
        {extra}
      </OptionRow>
    ),
    columnsHeader,
  };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
});
