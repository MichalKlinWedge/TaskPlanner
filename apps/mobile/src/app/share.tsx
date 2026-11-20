/**
 * Udostępnianie z innej aplikacji (Chrome: ⋮ → Udostępnij → Task Planner): pole szybkiego dodawania
 * z tekstem z `core` `sharedText` (Chrome wkłada adres do `text`, czasem tytuł strony do tematu).
 * Link trafia do zadania jako załącznik i `source` (`withLinkOps`, jak Web Share Target na webie);
 * zadanie z samym adresem w tytule dostaje tytuł strony z `link-preview` — offline po synchronizacji.
 */
import { sharedText } from '@taskplanner/core';
import { router } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { QuickAddField } from '@/components/quick-add-field';
import { Button, usePalette } from '@/components/ui';

export default function ShareScreen() {
  const p = usePalette();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  // Komunikat poza polem: reset udostępnienia zmienia `key` i montuje pole od nowa.
  const [saved, setSaved] = useState<string | null>(null);
  const shared = hasShareIntent ? sharedText({ title: shareIntent.meta?.title, text: shareIntent.text, url: shareIntent.webUrl }) : null;

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      {shared?.url ? (
        <View style={[styles.link, { borderColor: p.border, backgroundColor: p.card }]}>
          <Text style={{ color: p.fg, fontWeight: '600' }} numberOfLines={2}>
            {shared.text !== shared.url ? shared.text : 'Udostępniony link — tytuł strony uzupełni się sam'}
          </Text>
          <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={2}>
            {shared.url}
          </Text>
        </View>
      ) : (
        <Text style={{ color: p.muted }}>W Chrome: menu ⋮ → Udostępnij → Task Planner. Albo wpisz zadanie tutaj.</Text>
      )}
      <QuickAddField
        key={shared ? `${shared.url}|${shared.text}` : 'pusty'}
        autoFocus
        initialText={shared?.text ?? ''}
        link={shared?.url}
        placeholder="np. Przeczytać artykuł jutro o 20 !2"
        submitLabel="Dodaj"
        onAdded={() => {
          setSaved(shared ? `Dodano „${shared.text}”.` : 'Dodano.');
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
