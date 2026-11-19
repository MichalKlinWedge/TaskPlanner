/**
 * Podgląd opisu (Markdown) natywnymi komponentami: bloki z `parseMarkdown` (core). Linki otwiera
 * przeglądarka; pole `[ ]` w liście można odhaczyć w podglądzie (`onToggleCheckbox` z numerem linii).
 */
import type { MdBlock, MdSpan } from '@taskplanner/core';
import { parseMarkdown } from '@taskplanner/core';
import * as Linking from 'expo-linking';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { usePalette } from './ui';

function Spans({ spans, style }: { spans: readonly MdSpan[]; style?: TextStyle }) {
  const p = usePalette();
  return (
    <Text style={[styles.text, { color: p.fg }, style]}>
      {spans.map((s, i) => (
        <Text
          key={i}
          onPress={s.href ? () => void Linking.openURL(s.href!).catch(() => undefined) : undefined}
          style={[
            s.bold && styles.bold,
            s.italic && styles.italic,
            s.strike && styles.strike,
            s.code && [styles.code, { backgroundColor: p.border }],
            s.href ? { color: p.accent, textDecorationLine: 'underline' } : null,
          ]}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

const HEADING: Record<number, TextStyle> = { 1: { fontSize: 21 }, 2: { fontSize: 18 }, 3: { fontSize: 16 }, 4: { fontSize: 15 }, 5: { fontSize: 15 }, 6: { fontSize: 15 } };

export function MarkdownView({ source, onToggleCheckbox }: { source: string; onToggleCheckbox?: (line: number) => void }) {
  const p = usePalette();
  const blocks = useMemo<MdBlock[]>(() => parseMarkdown(source), [source]);
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <Spans key={i} spans={b.spans} style={{ ...HEADING[b.level], fontWeight: '700' }} />;
          case 'paragraph':
            return <Spans key={i} spans={b.spans} />;
          case 'quote':
            return (
              <View key={i} style={[styles.quote, { borderColor: p.border }]}>
                <Spans spans={b.spans} style={{ color: p.muted }} />
              </View>
            );
          case 'code':
            return (
              <Text key={i} style={[styles.pre, { color: p.fg, backgroundColor: p.border }]}>
                {b.text}
              </Text>
            );
          case 'rule':
            return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginVertical: 4 }} />;
          case 'list':
            return (
              <View key={i} style={{ gap: 3 }}>
                {b.items.map((item) => (
                  <View key={item.line} style={[styles.item, { paddingLeft: item.depth * 18 }]}>
                    {item.checked !== undefined ? (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: item.checked }}
                        disabled={!onToggleCheckbox}
                        hitSlop={8}
                        onPress={() => onToggleCheckbox?.(item.line)}
                        style={[styles.box, { borderColor: p.muted, backgroundColor: item.checked ? p.accent : 'transparent' }]}
                      >
                        {item.checked ? <Text style={styles.tick}>✓</Text> : null}
                      </Pressable>
                    ) : (
                      <Text style={[styles.text, { color: p.muted, minWidth: 16 }]}>{item.ordered ? `${item.number}.` : '•'}</Text>
                    )}
                    <View style={{ flex: 1 }}>
                      <Spans spans={item.spans} style={item.checked ? { color: p.muted, textDecorationLine: 'line-through' } : undefined} />
                    </View>
                  </View>
                ))}
              </View>
            );
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  text: { fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  code: { fontFamily: 'monospace', fontSize: 13 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  pre: { fontFamily: 'monospace', fontSize: 13, padding: 8, borderRadius: 6 },
  item: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  box: { width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  tick: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
