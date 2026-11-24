/**
 * Kosz (M3): usunięte w ostatnich 30 dniach, przywracanie razem z podzadaniami usuniętymi naraz (`restoreTaskOps`).
 * Dotknięcie zadania otwiera jego szczegóły tylko do odczytu (`task/[id].tsx`).
 * Chipy filtra (jak w innych widokach) zawężają zadania główne kosza; filtr trwa do opuszczenia ekranu.
 */
import { isEmptyFilter, matchesFilter, plural, TRASH_DAYS, trashedWith, trashListLabel, trashPreview, trashRoots, type FilterQuery } from '@taskplanner/core';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { PurgeButton } from '@/components/purge-button';
import { Button, P, usePalette } from '@/components/ui';
import { listEditable, listLabel, useView } from '@/lib/app-data';
import { useTrash } from '@/lib/trash';

export default function TrashScreen() {
  const p = usePalette();
  const { data, today } = useView();
  const { run } = useTaskActions();
  const [filter, setFilter] = useState<FilterQuery>({});
  const trashed = useTrash() ?? [];
  const roots = trashRoots(trashed);
  const filtered = !isEmptyFilter(filter);
  const shown = filtered ? roots.filter(matchesFilter(filter, today)) : roots;
  const alive = new Set(data.tasks.map((t) => t.id));

  return (
    <FlatList
      style={{ backgroundColor: p.bg }}
      data={shown}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={
        <View style={{ padding: 12 }}>
          <P muted>{`Usunięte zadania zostają tu ${TRASH_DAYS} dni, potem znikają na stałe. Dotknij zadania, aby zobaczyć szczegóły.`}</P>
          <FilterBar query={filter} onChange={setFilter} />
        </View>
      }
      ListEmptyComponent={<Text style={{ color: p.muted, textAlign: 'center', padding: 32 }}>{filtered && roots.length ? 'Nic w koszu nie pasuje do filtra.' : 'Kosz jest pusty.'}</Text>}
      renderItem={({ item: t }) => {
        const inside = trashedWith(trashed, t.id).length;
        return (
          <View style={[styles.row, { borderColor: p.border }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.title}
              accessibilityHint="Otwiera szczegóły; tylko podgląd"
              style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.6 : 1 })}
              onPress={() => router.push({ pathname: '/task/[id]', params: { id: t.id } })}
            >
              <Text style={{ color: p.fg, fontSize: 15 }}>{t.title}</Text>
              <Text style={{ color: p.muted, fontSize: 12 }}>
                {trashListLabel(t, listLabel(data, t.listId))} · {new Date(t.deletedAt).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {inside ? ` · z ${plural(inside, ['podzadaniem', 'podzadaniami', 'podzadaniami'])}` : ''}
              </Text>
            </Pressable>
            <View style={styles.buttons}>
              <Button kind="secondary" title="Przywróć" disabled={!listEditable(data, t.listId)} onPress={() => void run(trashPreview(trashed, t.id, alive)?.restore ?? [], { text: `Przywrócono „${t.title}”` })} />
              <PurgeButton kind="secondary" task={t} inside={inside} />
            </View>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  buttons: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
