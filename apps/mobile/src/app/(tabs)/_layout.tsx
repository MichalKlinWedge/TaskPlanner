/** Zakładki MVP-3: Dziś, Inbox, Nadchodzące, Przeglądaj (przestrzenie, listy, tagi, filtry, ustawienia). */
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';

import { HeaderRight } from '@/components/header';
import { usePalette } from '@/components/ui';
import { perfStart } from '@/lib/perf';

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  const p = usePalette();
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
      <Tabs.Screen name="index" options={{ title: 'Dziś', tabBarIcon: icon('☀') }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox', tabBarIcon: icon('📥') }} />
      <Tabs.Screen name="upcoming" options={{ title: 'Nadchodzące', tabBarIcon: icon('📅') }} />
      <Tabs.Screen name="browse" options={{ title: 'Przeglądaj', tabBarIcon: icon('☰') }} />
    </Tabs>
  );
}
