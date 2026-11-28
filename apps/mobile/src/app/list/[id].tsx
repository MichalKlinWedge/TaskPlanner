/**
 * Lista / projekt (M9): drzewo podzadań ze zwijaniem i postępem (kolejność ręczna, bez grupowania)
 * albo grupy po sortowaniu; sortowanie, grupowanie, ukończone i chipy filtra w `view_prefs` listy — jak na webie.
 * „▦ Tablica” otwiera kanban listy (`/board?list=`). „Widok” = `view_prefs.view` jak przełącznik na webie:
 * lista z „Tablica” otwiera się od razu jako tablica (nad ekranem listy — „Wstecz” wraca tu, do przełącznika);
 * „Karteczki” (tylko web) — jako lista. „Eksport XLSX” jak na webie: drzewo z poziomami albo grupy jako sekcje.
 */
import {
  applyFilter,
  buildTree,
  COMPLETED_MODE,
  flattenTree,
  GROUP_BY,
  groupTasks,
  isEmptyFilter,
  isOpen,
  LIST_KIND,
  plural,
  progress,
  READONLY_LIST_NOTE,
  SORT_BY,
  sortDirLabel,
  sortTasks,
  tagsForWorkspace,
  withCompleted,
  type CompletedMode,
  type FilterQuery,
  type GroupBy,
  type SortBy,
  type SortDir,
  type ViewPrefs,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { ExportChip } from '@/components/export-button';
import { FilterBar } from '@/components/filter-bar';
import { SaveTemplateBar } from '@/components/templates';
import { pickOption } from '@/components/pickers';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { TaskColumnsHeader } from '@/components/task-row';
import { usePalette } from '@/components/ui';
import { ColumnChips, columnRowMaker, OptionChip, OptionRow, useColumns } from '@/components/view-options';
import { useListEditable, useListShareBadge, useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';
import { mutate } from '@/lib/sync';

const OPEN = ['otwarte', 'otwarte', 'otwartych'] as const;

/** Tryby listy na telefonie (`view_prefs.view`); „Karteczki” są tylko na webie — tu jak lista. */
type PhoneView = 'list' | 'kanban';
const PHONE_VIEW: Record<PhoneView, string> = { list: 'Lista', kanban: 'Tablica' };

function Pref<T extends string>({ label, value, labels, onChange }: { label: string; value: T; labels: Record<T, string>; onChange: (v: T) => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${labels[value]}`}
      onPress={() => void pickOption<T>(label, (Object.keys(labels) as T[]).map((k) => ({ label: labels[k], value: k, selected: k === value }))).then((v) => v && onChange(v))}
      style={[styles.pref, { borderColor: p.border }]}
    >
      <Text style={{ color: p.fg, fontSize: 13 }}>
        {label}: {labels[value]}
      </Text>
    </Pressable>
  );
}

export default function ListScreen() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, today, ctx } = useView();
  usePerfReady('/list/[id]', data.loaded);
  const { notify } = useTaskActions();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [savingTemplate, setSavingTemplate] = useState(false);
  const list = data.lists.find((l) => l.id === id);
  // Ikona udostępnienia przy tytule: właściciel — ustawienie listy dla gości, gość — jego dostęp.
  const share = useListShareBadge(id);
  const editable = useListEditable(id);
  const sortBy: SortBy = list?.prefs.sortBy ?? 'manual';
  const sortDir: SortDir = list?.prefs.sortDir ?? 'asc';
  const groupBy: GroupBy = list?.prefs.groupBy ?? 'none';
  const completed: CompletedMode = list?.prefs.completed ?? 'today';
  const filter = list?.prefs.filter;
  const { columns, columnTags } = useColumns(list?.prefs, data.tags);
  const phoneView: PhoneView = list?.prefs.view === 'kanban' ? 'kanban' : 'list';
  // Zapamiętana tablica: raz na otwarcie ekranu, gdy lista jest już wczytana.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!list || autoOpened.current) return;
    autoOpened.current = true;
    if (list.prefs.view === 'kanban') router.push({ pathname: '/board', params: { list: list.id } });
  }, [list]);

  const tasks = useMemo(() => {
    const own = data.tasks.filter((t) => t.listId === id);
    return withCompleted(filter && !isEmptyFilter(filter) ? applyFilter(own, filter, today) : own, completed, ctx);
  }, [data.tasks, id, filter, today, completed, ctx]);
  const tree = sortBy === 'manual' && groupBy === 'none';
  const row = columnRowMaker(data, today, { columns, columnTags });

  const sections: TaskSection[] = useMemo(() => {
    if (tree) {
      const nodes = flattenTree(buildTree(tasks), collapsed);
      return [
        {
          key: 'tree',
          data: nodes.map((node) =>
            row(node.task, {
              depth: node.depth,
              progress: node.children.length ? progress(node) : undefined,
              collapsed: node.children.length ? collapsed.has(node.task.id) : undefined,
              onCollapse: () =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(node.task.id)) next.delete(node.task.id);
                  else next.add(node.task.id);
                  return next;
                }),
            }),
          ),
        },
      ];
    }
    return groupTasks(sortTasks(tasks, sortBy, sortDir), groupBy, { lists: data.lists, tags: data.tags }).map((g) => ({
      key: g.key,
      title: g.label || undefined,
      count: g.label ? g.tasks.length : undefined,
      data: g.tasks.map((t) => row(t, { key: `${g.key}:${t.id}` })),
    }));
    // `row` zależy od danych — przeliczane razem z nimi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, tasks, collapsed, sortBy, sortDir, groupBy, data.lists, data.tags, today, columns, columnTags]);

  if (!list) {
    return (
      <>
        <Stack.Screen options={{ title: 'Lista' }} />
        <TaskSections sections={[]} empty={data.loaded ? 'Tej listy już nie ma (usunięta albo zarchiwizowana).' : 'Wczytywanie…'} quickAdd={null} />
      </>
    );
  }

  const setPrefs = (patch: Partial<ViewPrefs>) => void mutate('lists', list.id, { view_prefs: { ...list.prefs, ...patch } }).catch((e: unknown) => notify(String(e)));
  const setFilter = (next: FilterQuery) => {
    const prefs = { ...list.prefs };
    delete prefs.filter;
    if (!isEmptyFilter(next)) prefs.filter = next;
    void mutate('lists', list.id, { view_prefs: prefs }).catch((e: unknown) => notify(String(e)));
  };
  const setColumnPrefs = (patch: Pick<ViewPrefs, 'columns' | 'columnTags'>) => {
    const prefs: ViewPrefs = { ...list.prefs, ...patch };
    if (!prefs.columns?.length) delete prefs.columns;
    if (!prefs.columnTags?.length) delete prefs.columnTags;
    void mutate('lists', list.id, { view_prefs: prefs }).catch((e: unknown) => notify(String(e)));
  };
  const setView = (next: PhoneView) => {
    if (next !== phoneView) {
      if (editable) setPrefs({ view: next });
      else notify(READONLY_LIST_NOTE);
    }
    if (next === 'kanban') router.push({ pathname: '/board', params: { list: list.id } });
  };
  // Eksport jak na webie: drzewo (wszystkie poziomy, także zwinięte) albo grupy sortowania jako sekcje.
  const exportRows = () =>
    tree
      ? flattenTree(buildTree(tasks)).map((n) => ({ task: n.task, depth: n.depth }))
      : groupTasks(sortTasks(tasks, sortBy, sortDir), groupBy, { lists: data.lists, tags: data.tags }).flatMap((g) => g.tasks.map((task) => ({ task, section: g.label || undefined })));
  const workspace = data.workspaces.find((w) => w.id === list.workspaceId)?.name;
  const title = `${list.kind === 'inbox' ? `Inbox · ${workspace ?? ''}` : list.name}${share ? ` ${share.icon}` : ''}`;

  return (
    <>
      <Stack.Screen options={{ title }} />
      <TaskSections
        sections={sections}
        header={
          <ScreenHeader subtitle={`${LIST_KIND[list.kind]}${workspace ? ` · ${workspace}` : ''} · ${plural(tasks.filter(isOpen).length, OPEN)}`}>
            {editable ? null : <Text style={{ color: p.muted, fontSize: 13, paddingHorizontal: 12, paddingTop: 6 }}>{READONLY_LIST_NOTE}</Text>}
            <OptionRow>
              <Pref label="Sortowanie" value={sortBy} labels={SORT_BY} onChange={(v) => setPrefs({ sortBy: v, sortDir: undefined })} />
              {sortBy === 'manual' ? null : (
                <OptionChip
                  label={`${sortDir === 'desc' ? '▼' : '▲'} ${sortDirLabel(sortBy, sortDir)}`}
                  accessibilityLabel={`Kierunek sortowania: ${sortDirLabel(sortBy, sortDir)} — odwróć`}
                  onPress={() => setPrefs({ sortDir: sortDir === 'desc' ? undefined : 'desc' })}
                />
              )}
              <Pref label="Grupy" value={groupBy} labels={GROUP_BY} onChange={(v) => setPrefs({ groupBy: v })} />
              <Pref label="Ukończone" value={completed} labels={COMPLETED_MODE} onChange={(v) => setPrefs({ completed: v })} />
              <ColumnChips columns={columns} columnTags={columnTags} tags={tagsForWorkspace(data.tags, list.workspaceId, list.prefs.columnTags)} onChange={setColumnPrefs} />
              <Pref label="Widok" value={phoneView} labels={PHONE_VIEW} onChange={setView} />
              <OptionChip label="▦ Tablica" accent onPress={() => router.push({ pathname: '/board', params: { list: list.id } })} />
              <ExportChip title={list.kind === 'inbox' ? `Inbox ${workspace ?? ''}`.trim() : list.name} rows={exportRows} />
              {list.kind === 'project' ? (
                <Pressable accessibilityRole="button" onPress={() => setSavingTemplate((v) => !v)} style={[styles.pref, { borderColor: p.border }]}>
                  <Text style={{ color: p.accent, fontSize: 13 }}>⧉ Zapisz jako szablon</Text>
                </Pressable>
              ) : null}
            </OptionRow>
            {savingTemplate && list.kind === 'project' ? <SaveTemplateBar listId={list.id} listName={list.name} onClose={() => setSavingTemplate(false)} /> : null}
            <FilterBar query={filter ?? {}} onChange={setFilter} hide={['lists']} save />
            {tasks.length ? <TaskColumnsHeader columns={columns} /> : null}
          </ScreenHeader>
        }
        empty="Brak zadań."
        quickAdd={editable ? { listId: list.id } : null}
        reorder={tree && editable ? sections[0]?.data.map((r) => r.task.id) : undefined}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pref: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
});
