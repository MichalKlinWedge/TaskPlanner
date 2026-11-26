/**
 * Tag (M4): zadania z tagiem, zmiana nazwy i koloru, przestrzenie, w których się pokazuje (żadna =
 * wszystkie, `tags.workspace_ids`), usunięcie (zadania zostają, tracą tylko tag).
 * Chipy filtra zawężają dalej (jak na webie); usunięcie warunku tagów wraca do tego tagu. Filtr
 * pamiętany per tag do zamknięcia aplikacji (R-06), nie jest zapisywany.
 */
import { tagWorkspacesPatch, type FilterQuery } from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { EditNameBar, FilterResults } from '@/components/filter-screen';
import { P } from '@/components/ui';
import { WorkspaceChips } from '@/components/workspace-chips';
import { useAdhocFilter } from '@/lib/adhoc-filters';
import { useAppData } from '@/lib/app-data';
import { mutate } from '@/lib/sync';

export default function TagScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAppData();
  const { notify } = useTaskActions();
  const tag = data.tags.find((t) => t.id === id);
  const base = useMemo<FilterQuery>(() => ({ tags: { ids: [id], match: 'any' } }), [id]);
  const [extra, setExtra] = useAdhocFilter(data.userId, `tag:${id}`);
  const query = extra.tags ? extra : { ...extra, tags: base.tags };
  const setQuery = (next: FilterQuery) => {
    const full = next.tags ? next : { ...next, tags: base.tags };
    setExtra(JSON.stringify(full) === JSON.stringify(base) ? {} : full);
  };
  const update = (patch: Record<string, unknown>) => void mutate('tags', id, patch).catch((e: unknown) => notify(String(e)));

  return (
    <>
      <Stack.Screen options={{ title: tag ? `@${tag.name}` : 'Tag' }} />
      <FilterResults
        columnsKey="tag"
        query={query}
        save
        quickAdd={tag ? { tag: tag.name } : null}
        exportTitle={tag ? `@${tag.name}` : undefined}
        onChange={setQuery}
        header={
          tag?.shared ? (
            <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
              <P muted>Tag innego członka przestrzeni — nazwę i kolor zmienia jego autor.</P>
            </View>
          ) : tag ? (
            <>
              <EditNameBar
                name={tag.name}
                label="Nazwa tagu"
                color={{ value: tag.color, onChange: (color) => update({ color }), onClear: () => update({ color: null }) }}
                onSave={(name) => update({ name: name.replace(/^[@#]/, '').slice(0, 60) })}
                onDelete={() => {
                  update({ deleted_at: new Date().toISOString() });
                  router.back();
                }}
                deleteTitle={`Usunąć tag „${tag.name}”?`}
                deleteMessage="Zadania zostaną, stracą tylko ten tag."
              />
              <WorkspaceChips ids={tag.workspaceIds} workspaces={data.workspaces} onChange={(ids) => update(tagWorkspacesPatch(ids))} />
            </>
          ) : undefined
        }
      />
    </>
  );
}
