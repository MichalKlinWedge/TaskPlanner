/**
 * Zapisany filtr (M4): wyniki, zmiana nazwy, usunięcie. Warunki jako chipy (jak na webie): zmiana
 * działa od razu na wyniki, „Zapisz zmiany” zapisuje ją w filtrze, „Przywróć” wraca do zapisanej.
 */
import { isEmptyFilter, type FilterQuery } from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { EditNameBar, FilterResults } from '@/components/filter-screen';
import { Button, P } from '@/components/ui';
import { useAppData } from '@/lib/app-data';
import { mutate } from '@/lib/sync';

export default function FilterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAppData();
  const { notify } = useTaskActions();
  const filter = data.savedFilters.find((f) => f.id === id);
  // Zmiany na ekranie są ważne dla tej wersji zapisanego filtra; zapis z innego urządzenia je zastępuje.
  const saved = filter ? JSON.stringify(filter.query) : '';
  const [draft, setDraft] = useState<{ key: string; query: FilterQuery } | null>(null);
  const update = (patch: Record<string, unknown>) => void mutate('saved_filters', id, patch).catch((e: unknown) => notify(String(e)));

  if (!filter) {
    return (
      <View style={{ padding: 16 }}>
        <Stack.Screen options={{ title: 'Filtr' }} />
        <P muted>{data.loaded ? 'Tego filtra już nie ma.' : 'Wczytywanie…'}</P>
      </View>
    );
  }
  const key = `${id}:${saved}`;
  const query = draft?.key === key ? draft.query : filter.query;
  const changed = JSON.stringify(query) !== saved;

  return (
    <>
      <Stack.Screen options={{ title: filter.name }} />
      <FilterResults
        query={query}
        quickAdd={{ listId: query.lists?.length === 1 ? query.lists[0] : undefined }}
        onChange={(next) => setDraft({ key, query: next })}
        header={
          <>
            <EditNameBar
              name={filter.name}
              label="Nazwa filtra"
              onSave={(name) => update({ name: name.slice(0, 60) })}
              onDelete={() => {
                update({ deleted_at: new Date().toISOString() });
                router.back();
              }}
              deleteTitle={`Usunąć filtr „${filter.name}”?`}
              deleteMessage="Zadania zostaną bez zmian."
            />
            {changed ? (
              <View style={styles.actions}>
                <Button title="Zapisz zmiany" disabled={isEmptyFilter(query)} onPress={() => update({ query })} />
                <Button title="Przywróć" kind="secondary" onPress={() => setDraft(null)} />
              </View>
            ) : null}
          </>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
});
