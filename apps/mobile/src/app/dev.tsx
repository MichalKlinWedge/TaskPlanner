import { Link, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import { SyncIndicator } from '@/components/sync-indicator';
import { P, Screen, Section, usePalette } from '@/components/ui';
import { serverConfig, sessionUser } from '@/lib/config';
import { perfEnabled, setPerfEnabled } from '@/lib/perf';
import { onSessionChange } from '@/lib/sync';

const ITEMS: { href: Href; title: string; hint: string }[] = [
  { href: '/widget', title: 'Dziś i widżety', hint: 'Lista „Dziś” z lokalnej bazy, dane przykładowe, dodanie widżetów, dziennik kliknięć' },
  { href: '/reminders', title: 'Przypomnienia', hint: '50 przypomnień / 3 dni, dokładne alarmy, akcje, pomiar opóźnień' },
  { href: '/share', title: 'Szybkie dodawanie', hint: 'Cel udostępniania z Chrome (Udostępnij → Task Planner)' },
  { href: '/selftest', title: 'Samosprawdzenie', hint: 'PoC-1/2/3 w Hermes: sync, cykliczność, nawyki, parser' },
];

/** Ekrany PoC-4 i samosprawdzenia (poza właściwą aplikacją). */
export default function DevTools() {
  const p = usePalette();
  const [user, setUser] = useState(sessionUser());
  const [perf, setPerf] = useState(perfEnabled());
  useEffect(() => onSessionChange(() => setUser(sessionUser())), []);

  return (
    <Screen>
      <SyncIndicator />
      <P muted>
        {user.online ? `Konto: ${user.email ?? '—'}` : 'Tryb offline (bez konta)'} · {serverConfig()?.url ?? 'brak adresu serwera'}
      </P>
      {ITEMS.map((item) => (
        <Link key={String(item.href)} href={item.href} asChild>
          <Pressable style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Section title={item.title}>
              <Text style={{ color: p.muted }}>{item.hint}</Text>
            </Section>
          </Pressable>
        </Link>
      ))}
      <Section title="Pomiary czasu">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: p.muted, flex: 1 }}>Start, zakładki, lista, kalendarz, ukończenie i „Cofnij”, odczyt danych, synchronizacja → logcat `[perf]` (docs/WYDAJNOSC.md)</Text>
          <Switch
            accessibilityLabel="Pomiary czasu"
            value={perf}
            onValueChange={(on) => {
              setPerfEnabled(on);
              setPerf(perfEnabled());
            }}
          />
        </View>
      </Section>
    </Screen>
  );
}
