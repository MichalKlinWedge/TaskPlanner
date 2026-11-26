/**
 * Wyszukiwarka (M17): indeks w pamięci z `core/search.ts` (bez FTS5 — decyzja w SPECYFIKACJA M17)
 * nad zadaniami (tytuł, tagi, lista, opis), listami, przestrzeniami, tagami, filtrami i poleceniami,
 * które telefon umie wykonać (`phoneCommandSearchItems`: widoki, przeglądy, szybkie dodawanie,
 * skupienie, przestrzeń, nowy projekt). Bez polskich znaków i wielkości liter; trafienia w tytułach
 * wyróżnione, ostatnio otwierane wyżej, a przy pustym polu — jako jedyna lista (jak paleta na webie).
 * Działa offline na lokalnej bazie. Chipy filtra (jak w widokach) zawężają wyniki do pasujących
 * zadań (bez poleceń); filtr trwa do opuszczenia ekranu.
 */
import { applyFilter, buildSearchIndex, canEditScope, isEmptyFilter, LIST_KIND, phoneCommandSearchItems, search, taskSearchItem, type FilterQuery, type SearchItem } from '@taskplanner/core';
import { router, Stack, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { pickOption } from '@/components/pickers';
import { openQuickAdd } from '@/components/task-list';
import { Highlighted, TaskRow } from '@/components/task-row';
import { usePalette } from '@/components/ui';
import { listLabel, setCurrentWorkspace, targetInbox, useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { readRecent, rememberRecent } from '@/lib/recent';

const KIND_LABEL: Record<string, string> = { list: 'Lista', workspace: 'Przestrzeń', tag: 'Tag', filter: 'Filtr', view: 'Widok', action: 'Akcja' };

/** Widoki-polecenia: zakładki (powrót do nich) albo ekrany na stosie. */
const VIEW_ROUTE: Record<string, { tab: boolean; href: Href }> = {
  'view.home': { tab: true, href: '/' },
  'view.today': { tab: true, href: '/today' },
  'view.inbox': { tab: true, href: '/inbox' },
  'view.upcoming': { tab: true, href: '/upcoming' },
  'view.overdue': { tab: false, href: '/overdue' },
  'view.kanban': { tab: false, href: '/board' },
  'view.calendar': { tab: false, href: '/calendar' },
  'view.timeline': { tab: false, href: '/timeline' },
  'view.habits': { tab: false, href: '/habits' },
  'review.daily': { tab: false, href: '/review/daily' },
  'review.weekly': { tab: false, href: '/review/weekly' },
  'focus.start': { tab: false, href: '/focus' },
};

export default function SearchScreen() {
  const p = usePalette();
  const { data, today, workspaceId } = useView();
  const { notify } = useTaskActions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterQuery>({});
  const filtered = !isEmptyFilter(filter);
  // Ostatnio otwierane — odczytane od nowa po każdym powrocie na ekran.
  const [recent, setRecent] = useState(readRecent);
  useFocusEffect(useCallback(() => setRecent(readRecent()), []));
  // Opisy tylko na tym ekranie (dane widoków ich nie trzymają).
  const descriptions = useLocalQuery(['tasks'], async (engine) => {
    const rows = await engine.db.all<{ id: string; d: string }>("select id, description_md as d from tasks where deleted_at is null and description_md is not null and description_md <> ''");
    return new Map(rows.map((r) => [r.id, r.d]));
  });

  const focus = data.settings.focus.enabled;
  const index = useMemo(() => {
    const listName = new Map(data.lists.map((l) => [l.id, listLabel(data, l.id)]));
    const tagName = new Map(data.tags.map((t) => [t.id, t.name]));
    const wsName = new Map(data.workspaces.map((w) => [w.id, w.name]));
    // Z filtrem tylko pasujące zadania — listy, tagi, filtry i polecenia nie mają tych warunków.
    const tasks = filtered ? applyFilter(data.tasks, filter, today) : data.tasks;
    const items: SearchItem[] = tasks.map((t) =>
      taskSearchItem(t, { description: descriptions?.get(t.id), listName: listName.get(t.listId), tagNames: t.tagIds.map((id) => tagName.get(id) ?? '') }),
    );
    if (filtered) return buildSearchIndex(items);
    for (const l of data.lists) if (l.kind !== 'inbox') items.push({ id: `list:${l.id}`, kind: 'list', title: l.name, listName: wsName.get(l.workspaceId), keywords: [LIST_KIND[l.kind]] });
    for (const w of data.workspaces) items.push({ id: `workspace:${w.id}`, kind: 'workspace', title: w.name });
    for (const t of data.tags) items.push({ id: `tag:${t.id}`, kind: 'tag', title: t.name, keywords: ['tag'] });
    for (const f of data.savedFilters) items.push({ id: `filter:${f.id}`, kind: 'filter', title: f.name, keywords: ['filtr'] });
    items.push(...phoneCommandSearchItems({ focus }));
    return buildSearchIndex(items);
  }, [data, descriptions, filtered, filter, today, focus]);

  // Szukanie po ~2 000 zadaniach przy każdym znaku — odroczone, żeby pisanie nie czekało na wyniki.
  // Puste pole = ostatnio otwierane (`search` bez słów).
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => search(index, deferredQuery, { limit: 40, recent }), [index, deferredQuery, recent]);
  const showingRecent = !deferredQuery.trim() && results.length > 0;
  const byId = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);

  const switchWorkspace = async () => {
    const choice = await pickOption<string>('Przestrzeń', [
      { label: 'Wszystkie przestrzenie', value: '', selected: !workspaceId },
      ...data.workspaces.map((w) => ({ label: w.name, value: w.id, selected: w.id === workspaceId })),
    ]);
    if (choice === undefined) return;
    setCurrentWorkspace(choice || null);
    router.back();
  };

  // Nowy projekt: ekran przestrzeni z sekcją „Nowa lista” (rodzaj „Projekt”, opcjonalnie z szablonu).
  const newProject = async () => {
    const editable = data.workspaces.filter((w) => canEditScope(w.role));
    if (!editable.length) return notify('Żadna przestrzeń nie pozwala dodawać list.');
    const current = editable.find((w) => w.id === workspaceId);
    const id =
      current?.id ??
      (editable.length === 1 ? editable[0]!.id : await pickOption<string>('Nowy projekt w przestrzeni', editable.map((w) => ({ label: w.name, value: w.id }))));
    if (!id) return;
    router.push({ pathname: '/workspace/[id]', params: { id } });
    notify('Projekt dodasz w sekcji „Nowa lista” — wybierz rodzaj „Projekt”.');
  };

  const runCommand = (id: string) => {
    const route = VIEW_ROUTE[id];
    if (route) return route.tab ? router.dismissTo(route.href) : router.push(route.href);
    if (id === 'task.quick_add') return openQuickAdd({ listId: targetInbox(data, workspaceId)?.id });
    if (id === 'workspace.switch') return void switchWorkspace();
    if (id === 'list.new_project') return void newProject();
  };

  const openItem = (item: SearchItem) => {
    rememberRecent(item.id);
    if (item.kind === 'view' || item.kind === 'action') return runCommand(item.id);
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
        placeholder="Zadania, listy, tagi, filtry, polecenia…"
        placeholderTextColor={p.muted}
        returnKeyType="search"
        autoCorrect={false}
        style={[styles.input, { color: p.fg, borderColor: p.border, backgroundColor: p.card }]}
      />
      <View style={styles.filters}>
        <FilterBar query={filter} onChange={setFilter} />
      </View>
      <FlatList
        data={results}
        keyExtractor={(r) => r.item.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={showingRecent ? <Text style={[styles.section, { color: p.muted }]}>Ostatnio otwierane</Text> : undefined}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: p.muted }]}>
            {query.trim() ? (filtered ? 'Żadne pasujące do filtra zadanie tego nie zawiera.' : 'Nic nie znaleziono.') : 'Wpisz początek słowa — „zolw” znajdzie „Żółw”. Ostatnio otwierane pojawią się tutaj.'}
          </Text>
        }
        renderItem={({ item: { item, highlights } }) => {
          const task = item.kind === 'task' ? byId.get(item.id) : undefined;
          if (task) return <TaskRow task={task} today={today} listName={item.listName} highlights={highlights} onOpen={() => rememberRecent(item.id)} />;
          if (item.kind === 'task') return null;
          return (
            <Pressable accessibilityRole="button" onPress={() => openItem(item)} style={({ pressed }) => [styles.item, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}>
              <Text style={{ color: p.muted, fontSize: 12, width: 72 }}>{KIND_LABEL[item.kind] ?? item.kind}</Text>
              <Text style={{ color: p.fg, fontSize: 16, flex: 1 }} numberOfLines={1}>
                {item.kind === 'tag' ? '@' : ''}
                <Highlighted text={item.title} ranges={highlights} />
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
  filters: { paddingHorizontal: 12, marginTop: -4, marginBottom: 4 },
  input: { margin: 12, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 17 },
  empty: { textAlign: 'center', padding: 32, fontSize: 14 },
  section: { fontSize: 12, fontWeight: '600', paddingHorizontal: 14, paddingTop: 4, paddingBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
});
