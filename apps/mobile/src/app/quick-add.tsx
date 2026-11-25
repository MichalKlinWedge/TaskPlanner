/**
 * Okno szybkiego dodawania (przycisk „+”, skrót aplikacji z ekranu głównego, widżet, `taskplanner://quick-add`).
 * Parametry: `listId`, `dueDate`, `dueTime` (z `dueDate`: dotknięte miejsce kalendarza), `parentId` (podzadanie), `tag` (dokładany do zadania), `text` (początkowy tekst), `voice=1`
 * (mikrofon z widżetu: podpowiedź dyktowania — mikrofon jest na klawiaturze, która otwiera się od razu).
 */
import { relativeDay, type LocalDate, type LocalTime, type QuickAddSlot } from '@taskplanner/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QuickAddField } from '@/components/quick-add-field';
import { usePalette } from '@/components/ui';
import { listLabel, useView } from '@/lib/app-data';

export default function QuickAddScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { data, today } = useView();
  const params = useLocalSearchParams<{ listId?: string; dueDate?: string; dueTime?: string; parentId?: string; tag?: string; text?: string; voice?: string }>();
  const voice = params.voice === '1';
  const [more, setMore] = useState(false);
  const parentTask = params.parentId ? data.tasks.find((t) => t.id === params.parentId) : undefined;
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(params.dueDate ?? '') ? (params.dueDate as LocalDate) : null;
  const slot = useMemo(
    (): QuickAddSlot | null => (dueDate && /^\d{2}:\d{2}$/.test(params.dueTime ?? '') ? { date: dueDate, time: params.dueTime as LocalTime } : null),
    [dueDate, params.dueTime],
  );
  const defaults = useMemo(() => (params.tag ? { tagNames: [params.tag] } : undefined), [params.tag]);
  const context = [params.tag ? `@${params.tag}` : '', dueDate ? relativeDay(dueDate, today) : '', slot?.time ?? ''].filter(Boolean).join(' · ');
  const parent = parentTask ? { id: parentTask.id, listId: parentTask.listId } : undefined;
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View style={[styles.body, { backgroundColor: p.card, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: p.fg }]} numberOfLines={1}>
          {parentTask ? `Podzadanie: ${parentTask.title}` : params.listId ? `Dodaj do: ${listLabel(data, params.listId)}` : 'Nowe zadanie'}
          {context ? ` · ${context}` : ''}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Zamknij" hitSlop={10} onPress={close}>
          <Text style={{ color: p.muted, fontSize: 18 }}>✕</Text>
        </Pressable>
      </View>
      {data.loaded ? (
        <QuickAddField
          autoFocus
          listId={params.listId}
          dueDate={dueDate}
          slot={slot}
          defaults={defaults}
          parent={parent}
          initialText={params.text ?? ''}
          submitLabel="Dodaj"
          placeholder={voice ? 'Dotknij 🎤 na klawiaturze i powiedz zadanie' : 'np. Zapłacić rachunek jutro o 10 #dom !2 @telefon'}
          onAdded={() => !more && close()}
        />
      ) : (
        <Text style={{ color: p.muted }}>Wczytywanie…</Text>
      )}
      {voice ? (
        <Text style={{ color: p.accent, fontSize: 13 }}>
          Dyktowanie: dotknij mikrofonu na klawiaturze. Słowa jak „jutro o 10” albo „co tydzień” zostaną rozpoznane tak samo jak wpisane.
        </Text>
      ) : null}
      <View style={styles.more}>
        <Switch value={more} onValueChange={setMore} />
        <Text style={{ color: p.muted, fontSize: 13, flex: 1 }}>Dodawaj kolejne (okno zostaje otwarte)</Text>
      </View>
      <Text style={{ color: p.muted, fontSize: 12 }}>
        Daty („jutro”, „pt”, „za 3 dni”), godziny („o 10”), czas („~30m”), priorytet („!1”), lista („#Praca”), tagi („@dom”), powtarzanie („co tydzień”), przypomnienia
        („^30m”, „przypomnij 30 min przed”). Dotknij chipa, żeby cofnąć rozpoznanie.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, fontSize: 17, fontWeight: '600' },
  more: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
