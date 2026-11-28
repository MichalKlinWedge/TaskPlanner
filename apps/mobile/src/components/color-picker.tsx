/** Wybór koloru: paleta `COLORS`, z `onClear` także „bez koloru” (∅), na końcu „Inny kolor” (arkusz `pickColor`). */
import { COLORS, isPaletteColor } from '@taskplanner/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { pickColor } from './pickers';
import { usePalette } from './ui';

export function ColorPicker({ value, onChange, onClear }: { value: string | null; onChange: (color: string) => void; onClear?: () => void }) {
  const p = usePalette();
  const current = value?.toUpperCase() ?? null;
  const custom = current && !isPaletteColor(current) ? current : null;
  return (
    <View style={styles.row}>
      {onClear ? (
        <Pressable
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Bez koloru"
          accessibilityState={{ selected: !value }}
          onPress={onClear}
          style={[styles.swatch, styles.center, { borderColor: !value ? p.fg : p.border }]}
        >
          <Text style={{ color: p.muted, fontSize: 14 }}>∅</Text>
        </Pressable>
      ) : null}
      {COLORS.map((c) => (
        <Pressable
          hitSlop={4}
          key={c.value}
          accessibilityRole="button"
          accessibilityLabel={c.label}
          accessibilityState={{ selected: current === c.value }}
          onPress={() => onChange(c.value)}
          style={[styles.swatch, { backgroundColor: c.value, borderColor: current === c.value ? p.fg : 'transparent' }]}
        />
      ))}
      <Pressable
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel="Inny kolor"
        accessibilityState={{ selected: !!custom }}
        onPress={() => void pickColor({ title: 'Inny kolor', value }).then((color) => color && onChange(color))}
        style={[styles.swatch, styles.center, { backgroundColor: custom ?? 'transparent', borderColor: custom ? p.fg : p.border }]}
      >
        {custom ? null : <Text style={{ color: p.fg, fontSize: 14, lineHeight: 18 }}>+</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatch: { width: 38, height: 38, borderRadius: 19, borderWidth: 3 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
