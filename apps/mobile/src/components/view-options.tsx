/**
 * Opcje widoku w nagłówku ekranu: chipy „Kolumny” / „Tagi w kolumnie” (ekran listy i widoki zbiorcze)
 * oraz `useSmartView` — ustawienia Inboxu, „Dziś”, „Zaległych”, „Nadchodzących” i „Bez terminu” z `settings.views`
 * profilu (wspólne z webem): „Sortowanie” i „⋯ Widok” (kierunek, kolumny, „▦ Tablica” = `/board?view=`, eksport),
 * żeby rzadkie opcje nie spychały zadań w dół ekranu.
 */
import {
  LIST_COLUMN,
  orderedColumns,
  smartSortChoice,
  smartSortDefault,
  smartSortOptions,
  smartViewsPatch,
  sortDirLabel,
  tagsForWorkspace,
  type ListColumn,
  type SmartView,
  type SmartViewPrefs,
  type SortBy,
  plural,
  type SortDir,
  type TaskExportRow,
  type ViewSettingsKey,
  type ViewTask,
  type XlsxSheet,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppData, type AppData } from '@/lib/app-data';
import { shareTasksXlsx, shareXlsx } from '@/lib/export';
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
    <Pressable hitSlop={6} accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={[styles.chip, { borderColor: p.border }]}>
      <Text style={{ color: accent ? p.accent : p.fg, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export const OptionRow = ({ children }: { children: ReactNode }) => <View style={styles.row}>{children}</View>;

/** Arkusz „Kolumny” (wiele naraz) — wynik w ustalonej kolejności. */
function pickColumns(columns: readonly ListColumn[], onChange: (patch: { columns: ListColumn[] }) => void) {
  void pickMany<ListColumn>(
    'Kolumny',
    (Object.keys(LIST_COLUMN) as ListColumn[]).map((c) => ({ label: LIST_COLUMN[c], value: c, selected: columns.includes(c) })),
  ).then((v) => v && onChange({ columns: orderedColumns(v) }));
}

function pickColumnTags(columnTags: ReadonlySet<string> | null, tags: readonly { id: string; name: string }[], onChange: (patch: { columnTags: string[] }) => void) {
  void pickMany<string>(
    'Tagi w kolumnie (żaden = wszystkie)',
    tags.map((t) => ({ label: `@${t.name}`, value: t.id, selected: !!columnTags?.has(t.id) })),
  ).then((v) => v && onChange({ columnTags: v }));
}

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
        onPress={() => pickColumns(columns, onChange)}
      />
      {columns.includes('tags') ? (
        <OptionChip
          label={`Tagi w kolumnie: ${columnTags ? columnTags.size : 'wszystkie'}`}
          onPress={() => pickColumnTags(columnTags, tags, onChange)}
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
  const sort = smartSort(data, view);
  // Domyślne kryterium widoku (`smartSortDefault`) nie jest zapisywane — jak „Domyślnie” w widokach zbiorczych.
  const setSort = (patch: { sortBy?: SortBy; sortDir?: SortDir }) => setPrefs({ ...patch, ...(patch.sortBy === smartSortDefault(view) && { sortBy: undefined }) });
  const tags = tagsForWorkspace(data.tags, workspaceId, prefs?.columnTags);
  return {
    row: columnRowMaker(data, today, cols),
    chips: <ColumnChips {...cols} tags={tags} onChange={setPrefs} />,
    cols,
    tags,
    setPrefs,
    setSort,
    labels: smartSortOptions(view),
    /** Chipy sortowania (`smartSort`); ekran sortuje nimi zadania sam. */
    sort,
    sortChips: <SortChips by={sort.by} dir={sort.dir} labels={smartSortOptions(view)} onChange={setSort} />,
    columnsHeader: <TaskColumnsHeader columns={cols.columns} />,
  };
}

/**
 * Chipy sortowania: kryterium (`pickOption`) i — poza „Ręcznie” / „Domyślnie” — kierunek (▲ / ▼).
 * Zmiana kryterium wraca do kierunku domyślnego.
 */
export function SortChips({ by, dir, labels, onChange }: { by: SortBy; dir: SortDir; labels: Partial<Record<SortBy, string>>; onChange: (patch: { sortBy?: SortBy; sortDir?: SortDir }) => void }) {
  return (
    <>
      <OptionChip
        label={`Sortowanie: ${labels[by] ?? by}`}
        onPress={() =>
          void pickOption<SortBy>('Sortowanie', (Object.keys(labels) as SortBy[]).map((k) => ({ label: labels[k] ?? k, value: k, selected: k === by }))).then(
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

/** Sortowanie widoku z `settings.views` (wspólne z webem); ekrany sortują nim sekcje (`sortSection`) albo zadania (`sortTasks`). */
export function smartSort(data: AppData, view: ViewSettingsKey): { by: SortBy; dir: SortDir } {
  return smartSortChoice(view, data.settings.views[view]);
}

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export type ExportSource = { rows: () => TaskExportRow[]; sheets?: never } | { sheets: () => { sheets: XlsxSheet[]; count: number }; rows?: never };

/** Eksport XLSX widoku: wiersze liczone dopiero przy wywołaniu (w kolejności widoku), plik przez `lib/export.ts`. */
export function useExport(title: string, source: ExportSource | undefined) {
  const data = useAppData();
  const { notify } = useTaskActions();
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (busy || !source) return;
    const list = source.rows?.();
    const own = source.sheets?.();
    const count = list ? list.length : (own?.count ?? 0);
    if (!count) return notify('Brak zadań do eksportu.');
    setBusy(true);
    (list ? shareTasksXlsx(title, list, data) : shareXlsx(title, own?.sheets ?? [], data.settings.timeZone))
      .then((fileName) => notify(`Zapisano ${fileName}: ${plural(count, TASKS)}.`))
      .catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { busy, run };
}

type ViewMenuItem = 'dir' | 'columns' | 'columnTags' | 'board' | 'export';

/**
 * Widok zbiorczy: `row` z kolumnami, pasek opcji i nagłówek kolumn. W pasku tylko „Sortowanie” (`smartSort`)
 * i „⋯ Widok”; kierunek, kolumny, tablica i eksport (`exportOf`) są w arkuszu „Widok”.
 */
export function useSmartView(view: SmartView, data: AppData, today: string, workspaceId: string | null, exportOf?: { title: string; rows: () => TaskExportRow[] }) {
  const { row, columnsHeader, cols, tags, setPrefs, setSort, sort, labels } = useViewColumns(view, data, today, workspaceId);
  const exporter = useExport(exportOf?.title ?? '', exportOf ? { rows: exportOf.rows } : undefined);
  const menu = () =>
    void pickOption<ViewMenuItem>('Widok', [
      ...(sort.by === 'manual' ? [] : [{ label: `Kierunek: ${sortDirLabel(sort.by, sort.dir)} — odwróć`, value: 'dir' as const }]),
      { label: `Kolumny…${cols.columns.length ? ` (${cols.columns.map((c) => LIST_COLUMN[c]).join(', ')})` : ''}`, value: 'columns' as const },
      ...(cols.columns.includes('tags') ? [{ label: `Tagi w kolumnie: ${cols.columnTags ? cols.columnTags.size : 'wszystkie'}…`, value: 'columnTags' as const }] : []),
      { label: '▦ Pokaż jako tablicę', value: 'board' as const },
      ...(exportOf ? [{ label: 'Eksport XLSX (udostępnij plik)', value: 'export' as const }] : []),
    ]).then((choice) => {
      if (choice === 'dir') setSort({ sortDir: sort.dir === 'desc' ? undefined : 'desc' });
      else if (choice === 'columns') pickColumns(cols.columns, setPrefs);
      else if (choice === 'columnTags') pickColumnTags(cols.columnTags, tags, setPrefs);
      else if (choice === 'board') router.push({ pathname: '/board', params: { view } });
      else if (choice === 'export') exporter.run();
    });
  const sortLabel = `${labels[sort.by] ?? sort.by}${sort.by === 'manual' ? '' : ` ${sort.dir === 'desc' ? '▼' : '▲'}`}`;
  return {
    row,
    options: (
      <OptionRow>
        <OptionChip
          label={`Sortowanie: ${sortLabel}`}
          onPress={() =>
            void pickOption<SortBy>('Sortowanie', (Object.keys(labels) as SortBy[]).map((k) => ({ label: labels[k] ?? k, value: k, selected: k === sort.by }))).then(
              (v) => v && setSort({ sortBy: v, sortDir: undefined }),
            )
          }
        />
        <OptionChip label={exporter.busy ? 'Eksport…' : '⋯ Widok'} accessibilityLabel="Opcje widoku: kierunek sortowania, kolumny, tablica, eksport" onPress={menu} />
      </OptionRow>
    ),
    columnsHeader,
  };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, minHeight: 36, justifyContent: 'center' },
});
