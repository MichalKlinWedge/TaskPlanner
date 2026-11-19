/**
 * Wyszukiwarka (M17): indeks w pamięci z `core/search.ts` (bez FTS5 — decyzja w SPECYFIKACJA M17)
 * nad zadaniami (tytuł, tagi, lista, opis), listami, przestrzeniami, tagami i filtrami. Bez polskich
 * znaków i wielkości liter; ostatnio otwierane wyżej. Działa offline na lokalnej bazie.
 */
import { buildSearchIndex, LIST_KIND, search, taskSearchItem, type SearchItem } from '@taskplanner/core';
import { router, Stack, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { TaskRow } from '@/components/task-row';
import { usePalette } from '@/components/ui';
import { listLabel, setCurrentWorkspace, useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { readRecent, rememberRecent } from '@/lib/recent';

const KIND_LABEL: Record<string, string> = { list: 'Lista', workspace: 'Przestrzeń', tag: 'Tag', filter: 'Filtr' };

export default function SearchScreen() {
  const p = usePalette();
  const { data, today } = useView();
  const [query, setQuery] = useState('');
  // Opisy tylko na tym ekranie (dane widoków ich nie trzymają).
  const descriptions = useLocalQuery(['tasks'], async (engine) => {
    const rows = await engine.db.all<{ id: string; d: string }>("select id, description_md as d from tasks where deleted_at is null and description_md is not null and description_md <> ''");
    return new Map(rows.map((r) => [r.id, r.d]));
  });

  const index = useMemo(() => {
    const listName = new Map(data.lists.map((l) => [l.id, listLabel(data, l.id)]));
    const tagName = new Map(data.tags.map((t) => [t.id, t.name]));
    const wsName = new Map(data.workspaces.map((w) => [w.id, w.name]));
    const items: SearchItem[] = data.tasks.map((t) =>
      taskSearchItem(t, { description: descriptions?.get(t.id), listName: listName.get(t.listId), tagNames: t.tagIds.map((id) => tagName.get(id) ?? '') }),
    );
    for (const l of data.lists) if (l.kind !== 'inbox') items.push({ id: `list:${l.id}`, kind: 'list', title: l.name, listName: wsName.get(l.workspaceId), keywords: [LIST_KIND[l.kind]] });
    for (const w of data.workspaces) items.push({ id: `workspace:${w.id}`, kind: 'workspace', title: w.name });
    for (const t of data.tags) items.push({ id: `tag:${t.id}`, kind: 'tag', title: t.name, keywords: ['tag'] });
    for (const f of data.savedFilters) items.push({ id: `filter:${f.id}`, kind: 'filter', title: f.name, keywords: ['filtr'] });
    return buildSearchIndex(items);
  }, [data, descriptions]);

  const results = useMemo(() => (query.trim() ? search(index, query, { limit: 40, recent: readRecent() }) : []), [index, query]);
  const byId = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);

  const openItem = (item: SearchItem) => {
    rememberRecent(item.id);
    const [kind, id] = item.id.includes(':') ? (item.id.split(':') as [string, string]) : ['task', item.id];
    const href: Href | null =
      kind === 'list' ? { pathname: '/list/[id]', params: { id } } : kind === 'tag' ? { pathname: '/tag/[id]', params: { id } } : kind === 'filter' ? { pathname: '/filter/[id]', params: { id } } : null;
    if (kind === 'workspace') {
      setCurrentWorkspace(id);
      router.back();
    } else if (href) router.push(href);
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title: 'Szukaj' }} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        autoFocus
        placeholder="Zadania, listy, tagi, filtry…"
        placeholderTextColor={p.muted}
        returnKeyType="search"
        autoCorrect={false}
        style={[styles.input, { color: p.fg, borderColor: p.border, backgroundColor: p.card }]}
      />
      <FlatList
        data={results}
        keyExtractor={(r) => r.item.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={[styles.empty, { color: p.muted }]}>{query.trim() ? 'Nic nie znaleziono.' : 'Wpisz początek słowa — „zolw” znajdzie „Żółw”.'}</Text>}
        renderItem={({ item: { item } }) => {
          const task = item.kind === 'task' ? byId.get(item.id) : undefined;
          if (task) return <TaskRow task={task} today={today} listName={item.listName} />;
          return (
            <Pressable accessibilityRole="button" onPress={() => openItem(item)} style={({ pressed }) => [styles.item, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}>
              <Text style={{ color: p.muted, fontSize: 12, width: 72 }}>{KIND_LABEL[item.kind] ?? item.kind}</Text>
              <Text style={{ color: p.fg, fontSize: 16, flex: 1 }} numberOfLines={1}>
                {item.kind === 'tag' ? `@${item.title}` : item.title}
              </Text>
              {item.listName ? <Text style={{ color: p.muted, fontSize: 12 }}>{item.listName}</Text> : null}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  input: { margin: 12, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 17 },
  empty: { textAlign: 'center', padding: 32, fontSize: 14 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
});
