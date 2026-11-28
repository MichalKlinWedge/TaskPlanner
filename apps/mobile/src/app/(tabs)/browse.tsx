/**
 * „Przeglądaj”: wyszukiwarka, przestrzenie → listy i projekty, tagi i zapisane filtry z licznikami
 * otwartych zadań liczonymi jak na webie (`isOpen`, `selectFiltered` z core: wszystkie poziomy drzewa,
 * bez nawyków, tagi w bieżącej przestrzeni), kosz, ustawienia, narzędzia PoC (tylko po włączeniu, `devToolsEnabled`).
 * „Cykliczne” z licznikiem nieodhaczonych na dziś (`habitsForDay`, jak pasek boczny webu); pasek zaproszeń
 * do przestrzeni jak w `ScreenHeader`. Pod wyszukiwarką skróty (przestrzenie, kosz, współpracownicy, ustawienia),
 * grupy zwijane nagłówkiem (stan w kv-store `browse.collapsed`), nagłówek przestrzeni otwiera jej ekran
 * (listy, „Osoby” / udostępnianie).
 */
import { habitsForDay, isOpen, LIST_KIND, listShareBadge, selectFiltered, selectOverdue, selectUndated, tagsForWorkspace, VIEW_SECTION, type ListShareBadge } from '@taskplanner/core';
import { router, type Href } from 'expo-router';
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ScopeInvitesBanner } from '@/components/sharing';
import { SyncBanner } from '@/components/sync-banner';
import { ColorDot, usePalette } from '@/components/ui';
import { useLocalMinute, useView } from '@/lib/app-data';
import { devToolsEnabled, onDevToolsChange, readJson, writeJson } from '@/lib/config';
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

const COLLAPSED_KEY = 'browse.collapsed';

/** Grupa z nagłówkiem: dotknięcie tytułu zwija ją (pamiętane na urządzeniu); `href` — „›” obok otwiera ekran grupy. */
function Group({ id, title, href, children }: { id?: string; title: string; href?: Href; children: ReactNode }) {
  const p = usePalette();
  const key = id ?? title;
  const [collapsed, setCollapsed] = useState(() => !!readJson<Record<string, boolean>>(COLLAPSED_KEY, {})[key]);
  const toggle = () => {
    const all = readJson<Record<string, boolean>>(COLLAPSED_KEY, {});
    if (collapsed) delete all[key];
    else all[key] = true;
    writeJson(COLLAPSED_KEY, all);
    setCollapsed(!collapsed);
  };
  return (
    <View style={[styles.group, { backgroundColor: p.card, borderColor: p.border }]}>
      <View style={styles.groupHead}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed }} accessibilityLabel={`${title}. ${collapsed ? 'Rozwiń' : 'Zwiń'}`} onPress={toggle} style={styles.groupToggle}>
          <Text style={[styles.groupTitle, { color: p.muted }]} numberOfLines={1}>
            {collapsed ? '▸' : '▾'} {title}
          </Text>
        </Pressable>
        {href ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Otwórz: ${title}`} hitSlop={4} onPress={() => router.push(href)} style={styles.groupLink}>
            <Text style={{ color: p.accent, fontSize: 13 }}>Przestrzeń ›</Text>
          </Pressable>
        ) : null}
      </View>
      {collapsed ? null : children}
    </View>
  );
}

function Shortcut({ label, href }: { label: string; href: Href }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push(href)} style={({ pressed }) => [styles.shortcut, { borderColor: p.border, backgroundColor: pressed ? p.border : p.card }]}>
      <Text style={{ color: p.fg, fontSize: 13 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
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
      <View style={styles.shortcuts}>
        <Shortcut label="Przestrzenie" href="/workspaces" />
        <Shortcut label="Kosz" href="/trash" />
        <Shortcut label="Współpracownicy" href="/collaborators" />
        <Shortcut label="Ustawienia" href="/settings" />
      </View>

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
        <Group key={w.id} id={w.id} title={w.name} href={{ pathname: '/workspace/[id]', params: { id: w.id } }}>
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
        <Item title="Ustawienia" hint="Konto i synchronizacja, profil, powiadomienia, przypomnienia" href="/settings" />
        {devTools ? <Item title="Narzędzia PoC" hint="Widżet, przypomnienia testowe, samosprawdzenie" href="/dev" /> : null}
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 12, paddingBottom: 40 },
  search: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  groupTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  groupHead: { flexDirection: 'row', alignItems: 'center' },
  groupToggle: { flex: 1, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' },
  groupLink: { paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  shortcut: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 12, minHeight: 40, justifyContent: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
