/**
 * Zapisany filtr (M4): wyniki, zmiana nazwy, usunięcie. Warunki jako chipy (jak na webie): zmiana
 * działa od razu na wyniki, „Zapisz zmiany” zapisuje ją w filtrze, „Przywróć” wraca do zapisanej.
 */
import { isEmptyFilter, type FilterQuery } from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { useDiscardChanges } from '@/components/confirm-leave';
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
  const key = `${id}:${saved}`;
  const query = filter && draft?.key === key ? draft.query : filter?.query;
  const changed = !!filter && JSON.stringify(query) !== saved;
  // Zmienione warunki bez „Zapisz zmiany”: „Wstecz” pyta, czy je zachować.
  const allowLeave = useDiscardChanges(changed, {
    title: 'Zapisać zmiany filtra?',
    message: 'Warunki filtra zostały zmienione, ale nie zapisane.',
    save:
      query && !isEmptyFilter(query)
        ? () => {
            update({ query });
            return true;
          }
        : undefined,
  });

  if (!filter || !query) {
    return (
      <View style={{ padding: 16 }}>
        <Stack.Screen options={{ title: 'Filtr' }} />
        <P muted>{data.loaded ? 'Tego filtra już nie ma.' : 'Wczytywanie…'}</P>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: filter.name }} />
      <FilterResults
        columnsKey="filter"
        query={query}
        quickAdd={{ listId: query.lists?.length === 1 ? query.lists[0] : undefined }}
        exportTitle={filter.name}
        onChange={(next) => setDraft({ key, query: next })}
        header={
          <>
            <EditNameBar
              name={filter.name}
              label="Nazwa filtra"
              onSave={(name) => update({ name: name.slice(0, 60) })}
              onDelete={() => {
                update({ deleted_at: new Date().toISOString() });
                allowLeave();
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
