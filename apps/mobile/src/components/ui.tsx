/** Klocki ekranów: kolory (jasny / ciemny), ekran, sekcja, tekst, przyciski, pola, chipy, kolory. */
import { COLORS } from '@taskplanner/core';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function usePalette() {
  const dark = useColorScheme() === 'dark';
  return dark
    ? { bg: '#09090b', card: '#18181b', fg: '#fafafa', muted: '#a1a1aa', border: '#3f3f46', accent: '#60a5fa', ok: '#4ade80', bad: '#f87171', selected: '#1e293b' }
    : { bg: '#fafafa', card: '#ffffff', fg: '#18181b', muted: '#71717a', border: '#e4e4e7', accent: '#2563eb', ok: '#16a34a', bad: '#dc2626', selected: '#e0e7ff' };
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const p = usePalette();
  const body = <View style={styles.body}>{children}</View>;
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.screen, { backgroundColor: p.bg }]}>
      {scroll ? <ScrollView contentContainerStyle={styles.scroll}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const p = usePalette();
  return (
    <View style={[styles.section, { backgroundColor: p.card, borderColor: p.border }]}>
      {title ? <Text style={[styles.sectionTitle, { color: p.fg }]}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function P({ children, muted, tone, mono }: { children: ReactNode; muted?: boolean; tone?: 'ok' | 'bad'; mono?: boolean }) {
  const p = usePalette();
  const color = tone ? p[tone] : muted ? p.muted : p.fg;
  return <Text style={[styles.p, { color }, mono && styles.mono]}>{children}</Text>;
}

export function Button({ title, onPress, disabled, kind = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'danger' }) {
  const p = usePalette();
  const bg = kind === 'primary' ? p.accent : kind === 'danger' ? p.bad : 'transparent';
  const fg = kind === 'secondary' ? p.fg : '#ffffff';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: kind === 'secondary' ? p.border : bg, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const p = usePalette();
  const { label, style, ...rest } = props;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: p.muted }]}>{label}</Text>
      <TextInput placeholderTextColor={p.muted} {...rest} style={[styles.input, { color: p.fg, borderColor: p.border }, style]} />
    </View>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

/** Wybór z kilku wartości (dzień tygodnia, rodzaj listy, czas trwania). */
export function Chip({ label, selected, onPress, disabled }: { label: string; selected?: boolean; onPress: () => void; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: selected ? p.accent : p.border, backgroundColor: selected ? p.accent : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.chipText, { color: selected ? '#ffffff' : p.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function ColorDot({ color, size = 12 }: { color: string | null; size?: number }) {
  const p = usePalette();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? 'transparent', borderWidth: 1, borderColor: color ?? p.border }} />;
}

/** Paleta kolorów z `@taskplanner/core` (`COLORS`). */
export function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: string) => void }) {
  const p = usePalette();
  return (
    <View style={styles.row}>
      {COLORS.map((c) => (
        <Pressable
          key={c.value}
          accessibilityRole="button"
          accessibilityLabel={c.label}
          accessibilityState={{ selected: value?.toUpperCase() === c.value }}
          onPress={() => onChange(c.value)}
          style={[styles.swatch, { backgroundColor: c.value, borderColor: value?.toUpperCase() === c.value ? p.fg : 'transparent' }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingBottom: 32 },
  body: { flex: 1, padding: 16, gap: 12 },
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '600' },
  p: { fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: 'monospace', fontSize: 12, lineHeight: 16 },
  button: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { gap: 4 },
  label: { fontSize: 12 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  chipText: { fontSize: 14 },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 3 },
});
