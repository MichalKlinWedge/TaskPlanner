/** Kosz (M3): usunięte w ostatnich 30 dniach, przywracanie razem z podzadaniami usuniętymi naraz (`restoreTaskOps`). */
import { descendants, plural, restoreTaskOps, TRASH_DAYS } from '@taskplanner/core';
import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { Button, P, usePalette } from '@/components/ui';
import { listLabel, useAppData } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';

interface Trashed {
  id: string;
  parentId: string | null;
  listId: string;
  title: string;
  deletedAt: string;
}

export default function TrashScreen() {
  const p = usePalette();
  const data = useAppData();
  const { run } = useTaskActions();
  const [since] = useState(() => new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString());
  const trashed =
    useLocalQuery(
      ['tasks'],
      async (engine) =>
        (
          await engine.db.all<{ id: string; parent_id: string | null; list_id: string; title: string; deleted_at: string }>(
            'select id, parent_id, list_id, title, deleted_at from tasks where deleted_at is not null and deleted_at > ? order by deleted_at desc',
            [since],
          )
        ).map((r): Trashed => ({ id: r.id, parentId: r.parent_id, listId: r.list_id, title: r.title, deletedAt: r.deleted_at })),
      [since],
    ) ?? [];
  const byId = new Map(trashed.map((t) => [t.id, t]));
  // Podzadania usunięte razem z rodzicem są pod nim (przywracają się z nim), nie osobno.
  const roots = trashed.filter((t) => !(t.parentId && byId.get(t.parentId)?.deletedAt === t.deletedAt));
  const alive = new Set(data.tasks.map((t) => t.id));

  return (
    <FlatList
      style={{ backgroundColor: p.bg }}
      data={roots}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={
        <View style={{ padding: 12 }}>
          <P muted>{`Usunięte zadania zostają tu ${TRASH_DAYS} dni, potem znikają na stałe.`}</P>
        </View>
      }
      ListEmptyComponent={<Text style={{ color: p.muted, textAlign: 'center', padding: 32 }}>Kosz jest pusty.</Text>}
      renderItem={({ item: t }) => {
        const inside = descendants(trashed, t.id).filter((d) => d.deletedAt === t.deletedAt).length;
        return (
          <View style={[styles.row, { borderColor: p.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: p.fg, fontSize: 15 }}>{t.title}</Text>
              <Text style={{ color: p.muted, fontSize: 12 }}>
                {listLabel(data, t.listId) || 'lista zarchiwizowana'} · {new Date(t.deletedAt).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {inside ? ` · z ${plural(inside, ['podzadaniem', 'podzadaniami', 'podzadaniami'])}` : ''}
              </Text>
            </View>
            <Button kind="secondary" title="Przywróć" onPress={() => void run(restoreTaskOps(trashed, t.id, { parentAlive: !t.parentId || alive.has(t.parentId) }), { text: `Przywrócono „${t.title}”` })} />
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
