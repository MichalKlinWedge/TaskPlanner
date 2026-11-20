/**
 * Tag (M4): zadania z tagiem, zmiana nazwy i koloru, przestrzenie, w których się pokazuje (żadna =
 * wszystkie, `tags.workspace_ids`), usunięcie (zadania zostają, tracą tylko tag).
 * Chipy filtra zawężają dalej (jak na webie); usunięcie warunku tagów wraca do tego tagu. Filtr
 * trwa do opuszczenia ekranu, nie jest zapisywany.
 */
import { tagWorkspacesPatch, type FilterQuery } from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { EditNameBar, FilterResults } from '@/components/filter-screen';
import { Chip, usePalette } from '@/components/ui';
import { useAppData, type AppData, type Tag } from '@/lib/app-data';
import { mutate } from '@/lib/sync';

export default function TagScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAppData();
  const { notify } = useTaskActions();
  const tag = data.tags.find((t) => t.id === id);
  const base = useMemo<FilterQuery>(() => ({ tags: { ids: [id], match: 'any' } }), [id]);
  const [state, setState] = useState<{ id: string; query: FilterQuery }>({ id, query: base });
  const query = state.id === id ? state.query : base;
  const setQuery = (next: FilterQuery) => setState({ id, query: next.tags ? next : { ...next, tags: base.tags } });
  const update = (patch: Record<string, unknown>) => void mutate('tags', id, patch).catch((e: unknown) => notify(String(e)));

  return (
    <>
      <Stack.Screen options={{ title: tag ? `@${tag.name}` : 'Tag' }} />
      <FilterResults
        query={query}
        onChange={setQuery}
        header={
          tag ? (
            <>
              <EditNameBar
                name={tag.name}
                label="Nazwa tagu"
                color={{ value: tag.color, onChange: (color) => update({ color }) }}
                onSave={(name) => update({ name: name.replace(/^[@#]/, '').slice(0, 60) })}
                onDelete={() => {
                  update({ deleted_at: new Date().toISOString() });
                  router.back();
                }}
                deleteTitle={`Usunąć tag „${tag.name}”?`}
                deleteMessage="Zadania zostaną, stracą tylko ten tag."
              />
              <TagWorkspaces tag={tag} workspaces={data.workspaces} onChange={(ids) => update(tagWorkspacesPatch(ids))} />
            </>
          ) : undefined
        }
      />
    </>
  );
}

/** Przestrzenie, w których tag się pokazuje i podpowiada; żadna zaznaczona = wszystkie. */
function TagWorkspaces({ tag, workspaces, onChange }: { tag: Tag; workspaces: AppData['workspaces']; onChange: (ids: string[]) => void }) {
  const p = usePalette();
  const chosen = (tag.workspaceIds ?? []).filter((id) => workspaces.some((w) => w.id === id));
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 6 }}>
      <Text style={{ color: p.muted, fontSize: 13 }}>Widoczny w:</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="wszystkich przestrzeniach" selected={!chosen.length} onPress={() => onChange([])} />
        {workspaces.map((w) => {
          const on = chosen.includes(w.id);
          return <Chip key={w.id} label={w.name} selected={on} onPress={() => onChange(on ? chosen.filter((id) => id !== w.id) : [...chosen, w.id])} />;
        })}
      </View>
    </View>
  );
}
