/**
 * Kosz (M3): usunięte w ostatnich 30 dniach, przywracanie razem z podzadaniami usuniętymi naraz (`restoreTaskOps`).
 * Chipy filtra (jak w innych widokach) zawężają zadania główne kosza; filtr trwa do opuszczenia ekranu.
 */
import { descendants, isEmptyFilter, matchesFilter, plural, restoreTaskOps, toViewTask, TRASH_DAYS, type FilterQuery, type LocalTaskRow, type ViewTask } from '@taskplanner/core';
import type { SqlRow } from '@taskplanner/sync';
import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { FilterBar } from '@/components/filter-bar';
import { Button, P, usePalette } from '@/components/ui';
import { listLabel, TASK_COLUMNS, useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';

type Trashed = ViewTask & { deletedAt: string };

export default function TrashScreen() {
  const p = usePalette();
  const { data, today } = useView();
  const { run } = useTaskActions();
  const [since] = useState(() => new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString());
  const [filter, setFilter] = useState<FilterQuery>({});
  const trashed =
    useLocalQuery(
      ['tasks', 'task_tags'],
      async (engine) => {
        const [rows, tags] = await Promise.all([
          engine.db.all<SqlRow>(`select ${TASK_COLUMNS}, t.deleted_at from tasks t where t.deleted_at is not null and t.deleted_at > ? order by t.deleted_at desc`, [since]),
          // Usunięcie zadania nie usuwa jego tagów — filtr po tagach działa też w koszu.
          engine.db.all<{ task_id: string; tag_id: string }>(
            'select tt.task_id, tt.tag_id from task_tags tt join tasks t on t.id = tt.task_id where tt.deleted_at is null and t.deleted_at > ? order by tt.rowid',
            [since],
          ),
        ]);
        const tagsOf = new Map<string, string[]>();
        for (const { task_id, tag_id } of tags) tagsOf.set(task_id, [...(tagsOf.get(task_id) ?? []), tag_id]);
        return rows.map((r): Trashed => ({ ...toViewTask(r as unknown as LocalTaskRow, tagsOf.get(String(r.id)) ?? []), deletedAt: String(r.deleted_at) }));
      },
      [since],
    ) ?? [];
  const byId = new Map(trashed.map((t) => [t.id, t]));
  // Podzadania usunięte razem z rodzicem są pod nim (przywracają się z nim), nie osobno.
  const roots = trashed.filter((t) => !(t.parentId && byId.get(t.parentId)?.deletedAt === t.deletedAt));
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
          <P muted>{`Usunięte zadania zostają tu ${TRASH_DAYS} dni, potem znikają na stałe.`}</P>
          <FilterBar query={filter} onChange={setFilter} />
        </View>
      }
      ListEmptyComponent={<Text style={{ color: p.muted, textAlign: 'center', padding: 32 }}>{filtered && roots.length ? 'Nic w koszu nie pasuje do filtra.' : 'Kosz jest pusty.'}</Text>}
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
