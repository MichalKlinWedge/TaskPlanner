/**
 * Sekcja ekranu zadania: karta z tłem i nagłówkiem, który ją zwija / rozwija (jak panel zadania na
 * webie). Stan zwinięcia jest w ustawieniach profilu (`settings.taskPanel.collapsed`) pod tymi samymi
 * kluczami co na webie, więc zostaje między zadaniami i synchronizuje się z innymi urządzeniami.
 * Zwinięta sekcja nie renderuje treści.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { mutate } from '@/lib/sync';

/** Czy sekcja jest zwinięta + przełącznik (zapis do profilu). */
export function useSectionCollapsed(id: string, defaultCollapsed = false): [boolean, () => void] {
  const { data } = useView();
  const { notify } = useTaskActions();
  const collapsed = data.settings.taskPanel.collapsed[id] ?? defaultCollapsed;
  const toggle = () => {
    const next = { ...data.settings.taskPanel.collapsed, [id]: !collapsed };
    // Wartość równa domyślnej nie musi być zapisana — profil nie rośnie od samego dotykania.
    if (next[id] === defaultCollapsed) delete next[id];
    void mutate('profiles', data.userId, { settings: { ...data.settings, taskPanel: { ...data.settings.taskPanel, collapsed: next } } }).catch((e: unknown) => notify(String(e)));
  };
  return [collapsed, toggle];
}

/** Tło paska nagłówka — o ton od karty (jak `--hover` na webie). */
export const useHeadTint = () => (useColorScheme() === 'dark' ? '#27272a' : '#f4f4f5');

export function PanelSection({
  id,
  title,
  count,
  right,
  defaultCollapsed = false,
  children,
}: {
  /** Stały klucz sekcji — ten sam co na webie (wspólny stan zwinięcia). */
  id: string;
  title: string;
  /** Liczba / postęp obok tytułu (widoczna też po zwinięciu). */
  count?: string | number;
  /** Przyciski po prawej stronie nagłówka (działają też przy zwiniętej sekcji). */
  right?: ReactNode;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const p = usePalette();
  const tint = useHeadTint();
  const [collapsed, toggle] = useSectionCollapsed(id, defaultCollapsed);
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <View style={[styles.head, { backgroundColor: tint }, !collapsed && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`${title}${count ? ` · ${count}` : ''} — ${collapsed ? 'rozwiń' : 'zwiń'}`}
          onPress={toggle}
          hitSlop={4}
          style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.chevron, { color: p.muted, transform: [{ rotate: collapsed ? '0deg' : '90deg' }] }]}>▸</Text>
          <Text style={[styles.title, { color: p.fg }]} numberOfLines={1}>
            {title.toUpperCase()}
          </Text>
          {count !== undefined && count !== '' ? <Text style={{ color: p.muted, fontSize: 12 }}>· {count}</Text> : null}
        </Pressable>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
      {collapsed ? null : <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingRight: 8 },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingLeft: 12, alignSelf: 'stretch' },
  chevron: { width: 12, fontSize: 12 },
  title: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, opacity: 0.8, flexShrink: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  body: { padding: 12, gap: 8 },
});
