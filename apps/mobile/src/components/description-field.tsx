/**
 * Opis zadania (Markdown) — szczegóły zadania i ekran skupienia: podgląd („Edytuj opis”) albo pole tekstowe
 * z paskiem formatowania jak na webie (core `markdownEdit`: przycisk przełącza, Enter kontynuuje listę).
 * Szkic zapisuje „Gotowe”, wyjście z ekranu i przejście aplikacji w tło (system może ją ubić); „Anuluj”
 * przywraca opis sprzed edycji.
 */
import { applyMarkdownEdit, markdownEdit, markdownNewline, toggleMarkdownCheckbox, type MarkdownAction } from '@taskplanner/core';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useLocalQuery } from '@/lib/local-query';

import { useTaskActions } from './actions';
import { MarkdownView } from './markdown-view';
import { usePalette } from './ui';

const FORMATS: { action: MarkdownAction; icon: string; label: string }[] = [
  { action: 'bold', icon: 'B', label: 'Pogrubienie' },
  { action: 'italic', icon: 'I', label: 'Kursywa' },
  { action: 'strike', icon: 'S̶', label: 'Przekreślenie' },
  { action: 'heading', icon: 'H', label: 'Nagłówek' },
  { action: 'bullet', icon: '•', label: 'Lista punktowana' },
  { action: 'numbered', icon: '1.', label: 'Lista numerowana' },
  { action: 'task', icon: '☑', label: 'Lista zadań' },
  { action: 'link', icon: '🔗', label: 'Link' },
  { action: 'quote', icon: '❝', label: 'Cytat' },
  { action: 'code', icon: '</>', label: 'Kod (kilka linii = blok kodu)' },
  { action: 'table', icon: '▦', label: 'Tabela' },
  { action: 'rule', icon: '―', label: 'Linia pozioma' },
];

function Pill({ label, onPress, color, hint }: { label: string; onPress: () => void; color?: string; hint?: string }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={hint ?? label} onPress={onPress} style={({ pressed }) => [styles.pill, { borderColor: color ?? p.border, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ color: color ?? p.fg, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export function DescriptionField({ taskId, readOnly = false }: { taskId: string; readOnly?: boolean }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const saved = useLocalQuery(['tasks'], async (engine) => ((await engine.db.all<{ d: string | null }>('select description_md as d from tasks where id = ?', [taskId]))[0]?.d ?? ''), [taskId]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const selection = useRef({ start: 0, end: 0 });
  // Zaznaczenie po zmianie z przycisku — ustawiane, gdy pole ma już nowy tekst.
  const nextSelection = useRef<{ start: number; end: number } | null>(null);
  const save = (value: string) => {
    const md = value.trim();
    if (md !== (saved ?? '').trim()) void run([{ table: 'tasks', id: taskId, patch: { description_md: md || null } }]);
  };
  // Opis z wejścia w edycję i ostatnio zapisany szkic: nietknięty szkic nie nadpisuje zmiany z innego urządzenia.
  const entry = useRef('');
  const stored = useRef('');
  const flush = useRef<() => void>(() => undefined);
  useEffect(() => {
    flush.current = () => {
      if (!editing || draft.trim() === stored.current.trim()) return;
      stored.current = draft;
      save(draft);
    };
  });
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') flush.current();
    });
    return () => {
      sub.remove();
      flush.current();
    };
  }, []);
  useEffect(() => {
    const next = nextSelection.current;
    if (!next) return;
    nextSelection.current = null;
    selection.current = next;
    input.current?.setSelection(next.start, next.end);
  }, [draft]);

  const change = (text: string, start: number, end: number) => {
    nextSelection.current = { start, end };
    setDraft(text);
  };
  const format = (action: MarkdownAction) => {
    const { start, end } = selection.current;
    const edit = markdownEdit(draft, Math.min(start, draft.length), Math.min(end, draft.length), action);
    input.current?.focus();
    change(applyMarkdownEdit(draft, edit), edit.selStart, edit.selEnd);
  };
  const onChangeText = (text: string) => {
    const continued = markdownNewline(draft, text, selection.current.start);
    if (continued) change(continued.text, continued.cursor, continued.cursor);
    else setDraft(text);
  };

  if (saved === undefined) return null;
  if (!editing) {
    return (
      <View style={{ gap: 8 }}>
        {saved.trim() ? (
          <MarkdownView source={saved} onToggleCheckbox={readOnly ? undefined : (line) => save(toggleMarkdownCheckbox(saved, line))} />
        ) : (
          <Text style={{ color: p.muted, fontSize: 14 }}>Brak opisu.</Text>
        )}
        {readOnly ? null : (
          <View style={styles.pills}>
            <Pill
              label={saved.trim() ? 'Edytuj opis' : '+ Dodaj opis'}
              onPress={() => {
                // Zmiana z innego urządzenia nie przerywa pisania: szkic tylko przy wejściu w edycję.
                entry.current = saved;
                stored.current = saved;
                selection.current = { start: saved.length, end: saved.length };
                setDraft(saved);
                setEditing(true);
              }}
            />
          </View>
        )}
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.formats}>
        {FORMATS.map((f) => (
          <Pill key={f.action} label={f.icon} hint={f.label} onPress={() => format(f.action)} />
        ))}
      </ScrollView>
      <TextInput
        ref={input}
        autoFocus
        multiline
        value={draft}
        onChangeText={onChangeText}
        onSelectionChange={(e) => {
          selection.current = e.nativeEvent.selection;
        }}
        placeholder="Markdown: **pogrubienie**, *kursywa*, - lista, - [ ] pole, [link](https://…)"
        placeholderTextColor={p.muted}
        textAlignVertical="top"
        style={[styles.input, { color: p.fg, borderColor: p.border }]}
      />
      <View style={styles.pills}>
        <Pill
          label="Gotowe"
          color={p.accent}
          onPress={() => {
            flush.current();
            setEditing(false);
          }}
        />
        <Pill
          label="Anuluj"
          onPress={() => {
            if (stored.current !== entry.current) save(entry.current);
            setEditing(false);
          }}
        />
      </View>
      {draft.trim() ? (
        <View style={[styles.preview, { borderColor: p.border }]}>
          <Text style={{ color: p.muted, fontSize: 11, marginBottom: 4 }}>PODGLĄD</Text>
          <MarkdownView source={draft} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  formats: { flexDirection: 'row', gap: 6 },
  pill: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 5 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, minHeight: 140 },
  preview: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10 },
});
