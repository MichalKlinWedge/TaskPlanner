/**
 * „Przeglądaj”: wyszukiwarka, przestrzenie → listy i projekty, tagi i zapisane filtry z licznikami
 * otwartych zadań liczonymi jak na webie (`isOpen`, `selectFiltered` z core: wszystkie poziomy drzewa,
 * bez nawyków, tagi w bieżącej przestrzeni), kosz, ustawienia, narzędzia PoC (tylko po włączeniu, `devToolsEnabled`).
 * „Cykliczne” z licznikiem nieodhaczonych na dziś (`habitsForDay`, jak pasek boczny webu); pasek zaproszeń
 * do przestrzeni jak w `ScreenHeader`.
 */
import { habitsForDay, isOpen, LIST_KIND, listShareBadge, selectFiltered, selectOverdue, selectUndated, tagsForWorkspace, VIEW_SECTION, type ListShareBadge } from '@taskplanner/core';
import { router, type Href } from 'expo-router';
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ScopeInvitesBanner } from '@/components/sharing';
import { SyncBanner } from '@/components/sync-banner';
import { ColorDot, usePalette } from '@/components/ui';
import { useLocalMinute, useView } from '@/lib/app-data';
import { devToolsEnabled, onDevToolsChange } from '@/lib/config';
import { perfStart, usePerfReady } from '@/lib/perf';

function Item({ title, hint, count, alert, color, href, indent, badge }: { title: string; hint?: string; count?: number; alert?: boolean; color?: string | null; href: Href; indent?: boolean; badge?: ListShareBadge | null }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        perfStart(typeof href === 'string' ? href : href.pathname);
        router.push(href);
      }}
      style={({ pressed }) => [styles.item, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent', paddingLeft: indent ? 34 : 14 }]}
    >
      {color !== undefined ? <ColorDot color={color} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={{ color: p.fg, fontSize: 16 }} numberOfLines={1}>
          {title}
        </Text>
        {hint ? <Text style={{ color: p.muted, fontSize: 12 }}>{hint}</Text> : null}
      </View>
      {badge ? (
        <Text accessibilityLabel={badge.label} style={{ fontSize: 13, opacity: 0.75 }}>
          {badge.icon}
        </Text>
      ) : null}
      {count ? <Text style={{ color: alert ? p.bad : p.muted, fontSize: 14, fontWeight: alert ? '600' : 'normal' }}>{count}</Text> : null}
      <Text style={{ color: p.muted, fontSize: 18 }}>›</Text>
    </Pressable>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const p = usePalette();
  return (
    <View style={[styles.group, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={[styles.groupTitle, { color: p.muted }]}>{title}</Text>
      {children}
    </View>
  );
}

export default function BrowseScreen() {
  const p = usePalette();
  const { data, ctx, today, workspaceId } = useView();
  const devTools = useSyncExternalStore(onDevToolsChange, devToolsEnabled);
  usePerfReady('tab:browse', data.loaded);
  const counts = useMemo(() => {
    const byList = new Map<string, number>();
    const byTag = new Map<string, number>();
    for (const t of data.tasks) {
      if (!isOpen(t) || t.kind !== 'task') continue;
      byList.set(t.listId, (byList.get(t.listId) ?? 0) + 1);
      if (!workspaceId || t.workspaceId === workspaceId) for (const tag of t.tagIds) byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    }
    const byFilter = new Map(data.savedFilters.map((f) => [f.id, selectFiltered(data.tasks, f.query, ctx).length]));
    return { byList, byTag, byFilter };
  }, [data.tasks, data.savedFilters, ctx, workspaceId]);
  const now = useLocalMinute(ctx.timeZone);
  const overdue = useMemo(() => {
    const view = selectOverdue(data.tasks, ctx, now);
    return view.today.length + view.earlier.length;
  }, [data.tasks, ctx, now]);
  const undated = useMemo(() => selectUndated(data.tasks, ctx).length, [data.tasks, ctx]);
  const habits = useMemo(() => habitsForDay(data.tasks, data.habitCompletions, today, today, workspaceId).filter((h) => !h.settled).length, [data.tasks, data.habitCompletions, today, workspaceId]);
  const workspaces = data.workspaces.filter((w) => !workspaceId || w.id === workspaceId);
  // Jak na webie: przy „Wszystkich przestrzeniach” zakładka Inbox to suma, więc Inbox każdej przestrzeni
  // stoi na czele jej grupy; przy jednej przestrzeni zakładka Inbox jest właśnie nim — bez powtórki.
  const sectionLists = (id: string) => {
    const own = data.lists.filter((l) => l.workspaceId === id);
    const inbox = workspaceId ? [] : own.filter((l) => l.kind === 'inbox');
    return [...inbox, ...own.filter((l) => l.kind !== 'inbox')];
  };
  // Tagi przypisane do innych przestrzeni chowają się.
  const tags = tagsForWorkspace(data.tags, workspaceId);

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.body}>
      <SyncBanner />
      <ScopeInvitesBanner />
      <Pressable accessibilityRole="search" onPress={() => router.push('/search')} style={[styles.search, { borderColor: p.border, backgroundColor: p.card }]}>
        <Text style={{ color: p.muted, fontSize: 16 }}>⌕ Szukaj zadań, list, tagów…</Text>
      </Pressable>

      <Group title="Planowanie">
        <Item title={VIEW_SECTION.overdue} hint="Po terminie, także dzisiejsze po godzinie" count={overdue} alert href="/overdue" />
        <Item title={VIEW_SECTION.noDate} hint="Otwarte zadania do zaplanowania, według list" count={undated} href="/undated" />
        <Item title="Kalendarz" hint="Dzień z przeciąganiem bloków, tydzień, miesiąc" href="/calendar" />
        <Item title="Cykliczne" hint="Nawyki i zadania z powtarzaniem" count={habits} href="/habits" />
        {data.settings.focus.enabled ? <Item title="Skupienie" hint="Pomodoro i stoper, czas pracy" href="/focus" /> : null}
        <Item title="Tablica" hint="Kanban bieżącej przestrzeni" href="/board" />
        <Item title="Oś czasu" hint="Projekty i zadania na osi dni, tygodni, miesięcy" href="/timeline" />
        <Item title="Przegląd dnia" hint="Zaległe i dzisiejsze — gesty na karcie" href="/review/daily" />
        <Item title="Przegląd tygodnia" hint="Inbox, projekty, oczekujące, tydzień, nawyki" href="/review/weekly" />
      </Group>

      {workspaces.map((w) => (
        <Group key={w.id} title={w.name}>
          {sectionLists(w.id).map((l) => (
              <Item
                key={l.id}
                title={l.kind === 'inbox' ? 'Inbox' : l.name}
                hint={l.kind === 'inbox' ? undefined : LIST_KIND[l.kind]}
                color={l.color ?? w.color}
                count={counts.byList.get(l.id)}
                badge={listShareBadge(w.role, l.guestAccess, w.members)}
                href={{ pathname: '/list/[id]', params: { id: l.id } }}
              />
          ))}
        </Group>
      ))}

      {data.savedFilters.length ? (
        <Group title="Filtry">
          {data.savedFilters.map((f) => (
            <Item key={f.id} title={f.name} count={counts.byFilter.get(f.id)} href={{ pathname: '/filter/[id]', params: { id: f.id } }} />
          ))}
        </Group>
      ) : null}

      {tags.length ? (
        <Group title="Tagi">
          {tags.map((t) => (
            <Item key={t.id} title={`@${t.name}`} color={t.color} count={counts.byTag.get(t.id)} href={{ pathname: '/tag/[id]', params: { id: t.id } }} />
          ))}
        </Group>
      ) : null}

      <Group title="Więcej">
        <Item title="Przestrzenie i listy" hint="Tworzenie, nazwy, kolory, kolejność, archiwum" href="/workspaces" />
        <Item title="Współpracownicy" hint="Osoby do wskazania w zadaniach (tylko informacyjnie)" href="/collaborators" />
        <Item title="Kosz" hint="Usunięte w ostatnich 30 dniach" href="/trash" />
        <Item title="Konto i synchronizacja" hint="Logowanie, stan synchronizacji, przypomnienia" href="/settings" />
        {devTools ? <Item title="Narzędzia PoC" hint="Widżet, przypomnienia testowe, samosprawdzenie" href="/dev" /> : null}
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 12, paddingBottom: 40 },
  search: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  groupTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
