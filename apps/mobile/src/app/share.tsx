import type { QuickAddResult } from '@taskplanner/core';
import { router } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Field, P, Row, Screen, Section, usePalette } from '@/components/ui';
import { createFromQuickAdd, previewQuickAdd } from '@/lib/tasks';
import { refreshTodayWidget } from '@/widget/refresh';

const TOKEN_LABEL: Record<string, string> = {
  date: 'data',
  time: 'godzina',
  duration: 'czas',
  priority: 'priorytet',
  target: 'lista',
  tag: 'tag',
  recurrence: 'cykl',
  reminder: 'przypomnienie',
};

interface Shared {
  url: string | null;
  title: string | null;
  text: string;
}

/** Formularz z udostępnionej treści; nowy udostępniony link = nowy formularz (`key`). */
function QuickAddForm({ shared, onSaved }: { shared: Shared | null; onSaved: () => void }) {
  const p = usePalette();
  const [text, setText] = useState(() => {
    if (!shared) return '';
    return shared.url ? (shared.title ?? shared.text.replace(shared.url, '').trim()) || '' : shared.text;
  });
  const [link, setLink] = useState({ url: shared?.url ?? null, title: shared?.title ?? null });
  const [preview, setPreview] = useState<QuickAddResult | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [receivedAt] = useState(() => (shared ? Date.now() : null));

  useEffect(() => {
    let live = true;
    void previewQuickAdd(text).then((r) => live && setPreview(r));
    return () => {
      live = false;
    };
  }, [text]);

  const save = async () => {
    const { listName, result } = await createFromQuickAdd(text, link);
    setSaved(`Dodano „${result.title || link.title || link.url}” do listy ${listName}${receivedAt ? ` (${Date.now() - receivedAt} ms od odebrania)` : ''}.`);
    setText('');
    setLink({ url: null, title: null });
    onSaved();
    await refreshTodayWidget().catch(() => undefined);
  };

  return (
    <>
      {link.url ? (
        <Section title="Udostępniony link">
          <P mono>{link.url}</P>
          {link.title ? <P muted>{link.title}</P> : null}
        </Section>
      ) : (
        <Section>
          <P muted>W Chrome: menu ⋮ → Udostępnij → TaskPlanner. Albo wpisz zadanie ręcznie.</P>
        </Section>
      )}
      <Field label="Zadanie (gramatyka szybkiego dodawania)" value={text} onChangeText={setText} placeholder="np. Przeczytać artykuł jutro o 20 !2" autoFocus multiline />
      {preview ? (
        <Section title={`Tytuł: ${preview.title || '—'}`}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {preview.tokens.map((t) => (
              <Text key={`${t.start}-${t.kind}`} style={{ borderWidth: 1, borderColor: p.accent, color: p.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontSize: 12 }}>
                {TOKEN_LABEL[t.kind] ?? t.kind}: {t.text}
              </Text>
            ))}
          </View>
          <P mono>{JSON.stringify(preview.fields)}</P>
        </Section>
      ) : null}
      <Row>
        <Button title="Dodaj zadanie" disabled={!text.trim() && !link.url} onPress={() => void save()} />
        <Button kind="secondary" title="Dziś" onPress={() => router.push('/today')} />
      </Row>
      {saved ? <P tone="ok">{saved}</P> : null}
    </>
  );
}

export default function ShareScreen() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  // Chrome wysyła sam URL (czasem tytuł strony w `meta.title`).
  const shared: Shared | null = hasShareIntent ? { url: shareIntent.webUrl ?? null, title: shareIntent.meta?.title ?? null, text: shareIntent.text ?? '' } : null;
  return (
    <Screen>
      <QuickAddForm key={shared ? `${shared.url}|${shared.text}` : 'pusty'} shared={shared} onSaved={() => resetShareIntent()} />
    </Screen>
  );
}
