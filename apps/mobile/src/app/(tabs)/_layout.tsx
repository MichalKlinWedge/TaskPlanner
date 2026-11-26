/**
 * Zakładki MVP-3: Dziś, Inbox, Nadchodzące, Przeglądaj (przestrzenie, listy, tagi, filtry, ustawienia).
 * Liczniki jak w pasku bocznym webu (`selectInbox`, `selectToday` z core, bieżąca przestrzeń): Inbox,
 * Dziś = zaległe + dzisiejsze — czerwony, gdy są zaległe. Licznik cyklicznych stoi w Przeglądaj.
 */
import { selectInbox, selectToday } from '@taskplanner/core';
import { Tabs } from 'expo-router';
import { useMemo } from 'react';
import { Text, type ColorValue } from 'react-native';

import { HeaderRight } from '@/components/header';
import { usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { perfStart } from '@/lib/perf';

const badge = (n: number) => (n ? (n > 99 ? '99+' : n) : undefined);

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  const p = usePalette();
  const { data, ctx } = useView();
  const counts = useMemo(() => {
    const inboxIds = new Set(data.lists.filter((l) => l.kind === 'inbox').map((l) => l.id));
    const view = selectToday(data.tasks, ctx, { completed: 'hidden' });
    return { inbox: selectInbox(data.tasks, inboxIds, ctx).length, today: view.overdue.length + view.today.length, overdue: view.overdue.length };
  }, [data.tasks, data.lists, ctx]);
  // Zwykły licznik — stonowany; czerwony tylko przy zaległych (jak na webie).
  const neutral = { backgroundColor: p.border, color: p.fg, fontSize: 11 };
  return (
    <Tabs
      screenListeners={({ route }) => ({ tabPress: () => perfStart(`tab:${route.name}`) })}
      screenOptions={{
        headerRight: () => <HeaderRight />,
        headerStyle: { backgroundColor: p.card },
        headerTintColor: p.fg,
        tabBarStyle: { backgroundColor: p.card, borderTopColor: p.border },
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.muted,
        sceneStyle: { backgroundColor: p.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dziś',
          tabBarIcon: icon('☀'),
          tabBarBadge: badge(counts.today),
          tabBarBadgeStyle: counts.overdue ? { backgroundColor: p.bad, color: p.bg, fontSize: 11 } : neutral,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{ title: 'Inbox', tabBarIcon: icon('📥'), tabBarBadge: badge(counts.inbox), tabBarBadgeStyle: neutral }}
      />
      <Tabs.Screen name="upcoming" options={{ title: 'Nadchodzące', tabBarIcon: icon('📅') }} />
      <Tabs.Screen name="browse" options={{ title: 'Przeglądaj', tabBarIcon: icon('☰') }} />
    </Tabs>
  );
}
