import { Link, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { P, Screen, Section, usePalette } from '@/components/ui';
import { serverConfig, sessionUser } from '@/lib/config';
import { lastSyncError, localEngine } from '@/lib/sync';

const ITEMS: { href: Href; title: string; hint: string }[] = [
  { href: '/today', title: 'Dziś i widżet', hint: 'Lista „Dziś” z lokalnej bazy, dane przykładowe, dodanie widżetu' },
  { href: '/reminders', title: 'Przypomnienia', hint: '50 przypomnień / 3 dni, dokładne alarmy, akcje, pomiar opóźnień' },
  { href: '/share', title: 'Szybkie dodawanie', hint: 'Cel udostępniania z Chrome (Udostępnij → TaskPlanner)' },
  { href: '/calendar', title: 'Kalendarz', hint: 'expo-calendar + @howljs/calendar-kit, przeciąganie bloku' },
  { href: '/timeline', title: 'Oś dnia (własna)', hint: 'Wariant awaryjny: Reanimated + Gesture Handler' },
  { href: '/selftest', title: 'Samosprawdzenie', hint: 'PoC-1/2/3 w Hermes: sync, cykliczność, nawyki, parser' },
  { href: '/settings', title: 'Serwer i konto', hint: 'Adres Supabase, logowanie, synchronizacja' },
];

export default function Home() {
  const p = usePalette();
  const [status, setStatus] = useState('…');

  useFocusEffect(
    useCallback(() => {
      const user = sessionUser();
      localEngine()
        .then(async (engine) => {
          const pending = await engine.pendingCount();
          const rejected = (await engine.rejectedOps()).length;
          const server = serverConfig()?.url ?? 'brak adresu serwera';
          setStatus(
            `${user.online ? `Konto: ${user.email}` : 'Tryb offline (bez konta)'} · ${server}\nOutbox: ${pending} oczekujących, ${rejected} odrzuconych${lastSyncError ? `\nOstatni błąd: ${lastSyncError}` : ''}`,
          );
        })
        .catch((error) => setStatus(`Błąd lokalnej bazy: ${String(error)}`));
    }, []),
  );

  return (
    <Screen>
      <Section>
        <P muted>{status}</P>
      </Section>
      {ITEMS.map((item) => (
        <Link key={String(item.href)} href={item.href} asChild>
          <Pressable style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Section title={item.title}>
              <Text style={{ color: p.muted }}>{item.hint}</Text>
            </Section>
          </Pressable>
        </Link>
      ))}
    </Screen>
  );
}
