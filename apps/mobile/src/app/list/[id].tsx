/**
 * Lista / projekt (M9): drzewo podzadań ze zwijaniem i postępem (kolejność ręczna, bez grupowania)
 * albo grupy po sortowaniu; sortowanie, grupowanie, ukończone i chipy filtra w `view_prefs` listy — jak na webie.
 * „▦ Tablica” otwiera kanban listy (`/board?list=`).
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
  SORT_BY,
  sortTasks,
  withCompleted,
  type CompletedMode,
  type FilterQuery,
  type GroupBy,
  type SortBy,
  type ViewPrefs,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { pickOption } from '@/components/pickers';
import { ScreenHeader } from '@/components/sync-banner';
import { TaskSections, type TaskSection } from '@/components/task-list';
import { usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { usePerfReady } from '@/lib/perf';
import { rowMaker } from '@/lib/rows';
import { mutate } from '@/lib/sync';

const OPEN = ['otwarte', 'otwarte', 'otwartych'] as const;

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
  const list = data.lists.find((l) => l.id === id);
  const sortBy: SortBy = list?.prefs.sortBy ?? 'manual';
  const groupBy: GroupBy = list?.prefs.groupBy ?? 'none';
  const completed: CompletedMode = list?.prefs.completed ?? 'today';
  const filter = list?.prefs.filter;

  const tasks = useMemo(() => {
    const own = data.tasks.filter((t) => t.listId === id);
    return withCompleted(filter && !isEmptyFilter(filter) ? applyFilter(own, filter, today) : own, completed, ctx);
  }, [data.tasks, id, filter, today, completed, ctx]);
  const tree = sortBy === 'manual' && groupBy === 'none';
  const row = rowMaker(data, today);

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
    return groupTasks(sortTasks(tasks, sortBy), groupBy, { lists: data.lists, tags: data.tags }).map((g) => ({
      key: g.key,
      title: g.label || undefined,
      count: g.label ? g.tasks.length : undefined,
      data: g.tasks.map((t) => row(t, { key: `${g.key}:${t.id}` })),
    }));
    // `row` zależy od danych — przeliczane razem z nimi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, tasks, collapsed, sortBy, groupBy, data.lists, data.tags, today]);

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
  const workspace = data.workspaces.find((w) => w.id === list.workspaceId)?.name;
  const title = list.kind === 'inbox' ? `Inbox · ${workspace ?? ''}` : list.name;

  return (
    <>
      <Stack.Screen options={{ title }} />
      <TaskSections
        sections={sections}
        header={
          <ScreenHeader subtitle={`${LIST_KIND[list.kind]}${workspace ? ` · ${workspace}` : ''} · ${plural(tasks.filter(isOpen).length, OPEN)}`}>
            <View style={styles.prefs}>
              <Pref label="Sortowanie" value={sortBy} labels={SORT_BY} onChange={(v) => setPrefs({ sortBy: v })} />
              <Pref label="Grupy" value={groupBy} labels={GROUP_BY} onChange={(v) => setPrefs({ groupBy: v })} />
              <Pref label="Ukończone" value={completed} labels={COMPLETED_MODE} onChange={(v) => setPrefs({ completed: v })} />
              <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/board', params: { list: list.id } })} style={[styles.pref, { borderColor: p.border }]}>
                <Text style={{ color: p.accent, fontSize: 13 }}>▦ Tablica</Text>
              </Pressable>
            </View>
            <FilterBar query={filter ?? {}} onChange={setFilter} hide={['lists']} />
          </ScreenHeader>
        }
        empty="Brak zadań."
        quickAdd={{ listId: list.id }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  prefs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  pref: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
});
