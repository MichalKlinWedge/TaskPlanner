/** Klocki ekranów: kolory (jasny / ciemny), ekran, sekcja, tekst, przyciski, pola, chipy, kropka koloru. */
import Storage from 'expo-sqlite/kv-store';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * `onAccent` / `onBad` / `onOk` — tekst na wypełnieniu w tym kolorze (w ciemnym motywie wypełnienia są jasne,
 * więc tekst ciemny — biały miał kontrast ~2,5:1). `inverseAccent` — akcent na odwróconym tle (dymek z „Cofnij”).
 */
export function usePalette() {
  const dark = useColorScheme() === 'dark';
  return dark
    ? { bg: '#09090b', card: '#18181b', fg: '#fafafa', muted: '#a1a1aa', border: '#3f3f46', accent: '#60a5fa', ok: '#4ade80', bad: '#f87171', selected: '#1e293b', onAccent: '#0b1220', onBad: '#1f0a0a', onOk: '#052e16', inverseAccent: '#1d4ed8', warnBg: '#422006', warnFg: '#fde68a' }
    : { bg: '#fafafa', card: '#ffffff', fg: '#18181b', muted: '#71717a', border: '#e4e4e7', accent: '#2563eb', ok: '#16a34a', bad: '#dc2626', selected: '#e0e7ff', onAccent: '#ffffff', onBad: '#ffffff', onOk: '#ffffff', inverseAccent: '#93c5fd', warnBg: '#fef3c7', warnFg: '#92400e' };
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const p = usePalette();
  const body = <View style={styles.body}>{children}</View>;
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.screen, { backgroundColor: p.bg }]}>
      {/* `handled`: przy otwartej klawiaturze stuknięcie w przycisk działa od razu (zamiast tylko chować klawiaturę). */}
      {scroll ? (
        // Jak ekran zadania: pole na dole długiego ekranu (np. „Usuń konto”) przewija się nad klawiaturę.
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            {body}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

/**
 * Ekran z sekcjami zwijanymi nagłówkiem (Ustawienia). Stan zwinięcia jest urządzenia (kv-store, klucz = `id`
 * albo tytuł sekcji, `true` = zwinięta, `false` = rozwinięta); bez zapisu sekcja startuje zwinięta, żeby długi
 * ekran był spisem treści. Zwinięta sekcja nie renderuje treści.
 */
const CollapsibleContext = createContext(false);
export const CollapsibleSections = CollapsibleContext.Provider;

// Nowy klucz: w starym brak wpisu znaczył „rozwinięta”, teraz znaczy „zwinięta”.
const COLLAPSED_KEY = 'ui.collapsedSections.v2';

function readCollapsed(): Record<string, boolean> {
  try {
    return (JSON.parse(Storage.getItemSync(COLLAPSED_KEY) ?? '{}') as Record<string, boolean>) ?? {};
  } catch {
    return {};
  }
}

export function Section({ id, title, alwaysOpen, children }: { id?: string; title?: string; alwaysOpen?: boolean; children: ReactNode }) {
  const p = usePalette();
  const collapsible = useContext(CollapsibleContext) && !!title && !alwaysOpen;
  const key = id ?? title ?? '';
  const [collapsed, setCollapsed] = useState(() => readCollapsed()[key] ?? true);
  const shut = collapsible && collapsed;
  const toggle = () => {
    const all = readCollapsed();
    all[key] = !collapsed;
    Storage.setItemSync(COLLAPSED_KEY, JSON.stringify(all));
    setCollapsed(!collapsed);
  };
  return (
    <View style={[styles.section, { backgroundColor: p.card, borderColor: p.border }]}>
      {collapsible ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: !shut }} accessibilityLabel={`${title}. ${shut ? 'Rozwiń' : 'Zwiń'}`} hitSlop={6} onPress={toggle} style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { color: p.fg, flex: 1 }]}>{title}</Text>
          <Text style={{ color: p.muted, fontSize: 14 }}>{shut ? '▸' : '▾'}</Text>
        </Pressable>
      ) : title ? (
        <Text style={[styles.sectionTitle, { color: p.fg }]}>{title}</Text>
      ) : null}
      {shut ? null : children}
    </View>
  );
}

export function P({ children, muted, tone, mono, onPress }: { children: ReactNode; muted?: boolean; tone?: 'ok' | 'bad'; mono?: boolean; onPress?: () => void }) {
  const p = usePalette();
  const color = tone ? p[tone] : muted ? p.muted : p.fg;
  return (
    <Text style={[styles.p, { color }, mono && styles.mono]} onPress={onPress}>
      {children}
    </Text>
  );
}

export function Button({ title, onPress, disabled, kind = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'danger' }) {
  const p = usePalette();
  const bg = kind === 'primary' ? p.accent : kind === 'danger' ? p.bad : 'transparent';
  const fg = kind === 'secondary' ? p.fg : kind === 'danger' ? p.onBad : p.onAccent;
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
      hitSlop={4}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: selected ? p.accent : p.border, backgroundColor: selected ? p.accent : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.chipText, { color: selected ? p.onAccent : p.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function ColorDot({ color, size = 12 }: { color: string | null; size?: number }) {
  const p = usePalette();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? 'transparent', borderWidth: 1, borderColor: color ?? p.border }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingBottom: 32 },
  body: { flex: 1, padding: 16, gap: 12 },
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '600' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  p: { fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: 'monospace', fontSize: 12, lineHeight: 16 },
  button: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { gap: 4 },
  label: { fontSize: 12 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12, minHeight: 40, justifyContent: 'center' },
  chipText: { fontSize: 14 },
});
