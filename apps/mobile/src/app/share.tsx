/**
 * Udostępnianie z innej aplikacji (Chrome: ⋮ → Udostępnij → TaskPlanner): pole szybkiego dodawania
 * z tekstem lub tytułem strony, link trafia do opisu (`[tytuł](url)`) i do `source`. Bez tytułu —
 * tytuł strony albo sam adres.
 */
import { router } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { QuickAddField } from '@/components/quick-add-field';
import { Button, usePalette } from '@/components/ui';

interface Shared {
  url: string | null;
  title: string | null;
  text: string;
}

const linkTitle = (shared: Shared) => shared.title || shared.url || 'Udostępniony link';

export default function ShareScreen() {
  const p = usePalette();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  // Komunikat poza polem: reset udostępnienia zmienia `key` i montuje pole od nowa.
  const [saved, setSaved] = useState<string | null>(null);
  // Chrome wysyła sam URL (czasem tytuł strony w `meta.title`).
  const shared: Shared | null = hasShareIntent ? { url: shareIntent.webUrl ?? null, title: shareIntent.meta?.title ?? null, text: shareIntent.text ?? '' } : null;
  const initialText = !shared ? '' : shared.url ? shared.title ?? shared.text.replace(shared.url, '').trim() : shared.text;
  const extra = shared?.url
    ? { description_md: `[${linkTitle(shared)}](${shared.url})`, source: { kind: 'link', url: shared.url, title: shared.title }, fallbackTitle: linkTitle(shared) }
    : undefined;

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      {shared?.url ? (
        <View style={[styles.link, { borderColor: p.border, backgroundColor: p.card }]}>
          <Text style={{ color: p.fg, fontWeight: '600' }} numberOfLines={2}>
            {shared.title ?? 'Udostępniony link'}
          </Text>
          <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={2}>
            {shared.url}
          </Text>
        </View>
      ) : (
        <Text style={{ color: p.muted }}>W Chrome: menu ⋮ → Udostępnij → TaskPlanner. Albo wpisz zadanie tutaj.</Text>
      )}
      <QuickAddField
        key={shared ? `${shared.url}|${shared.text}` : 'pusty'}
        autoFocus
        initialText={initialText}
        extra={extra}
        placeholder="np. Przeczytać artykuł jutro o 20 !2"
        submitLabel="Dodaj"
        onAdded={() => {
          setSaved(shared?.url ? `Dodano „${initialText || linkTitle(shared)}”.` : 'Dodano.');
          resetShareIntent();
        }}
      />
      {saved ? <Text style={{ color: p.ok }}>{saved}</Text> : null}
      <Button kind="secondary" title="Dziś" onPress={() => router.replace('/')} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 12 },
  link: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
});
