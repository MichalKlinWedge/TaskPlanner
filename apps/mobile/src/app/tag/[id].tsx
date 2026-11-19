/** Tag (M4): zadania z tagiem, zmiana nazwy i koloru, usunięcie (zadania zostają, tracą tylko tag). */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { useTaskActions } from '@/components/actions';
import { EditNameBar, FilterResults } from '@/components/filter-screen';
import { useAppData } from '@/lib/app-data';
import { mutate } from '@/lib/sync';

export default function TagScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAppData();
  const { notify } = useTaskActions();
  const tag = data.tags.find((t) => t.id === id);
  const query = useMemo(() => ({ tags: { ids: [id], match: 'any' as const } }), [id]);
  const update = (patch: Record<string, unknown>) => void mutate('tags', id, patch).catch((e: unknown) => notify(String(e)));

  return (
    <>
      <Stack.Screen options={{ title: tag ? `@${tag.name}` : 'Tag' }} />
      <FilterResults
        query={query}
        header={
          tag ? (
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
          ) : undefined
        }
      />
    </>
  );
}
