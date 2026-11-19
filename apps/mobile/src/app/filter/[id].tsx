/** Zapisany filtr (M4): wyniki, zmiana nazwy, usunięcie. Warunki zmienia się na webie (chipy filtra). */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useTaskActions } from '@/components/actions';
import { EditNameBar, FilterResults } from '@/components/filter-screen';
import { P } from '@/components/ui';
import { useAppData } from '@/lib/app-data';
import { mutate } from '@/lib/sync';

export default function FilterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAppData();
  const { notify } = useTaskActions();
  const filter = data.savedFilters.find((f) => f.id === id);
  const update = (patch: Record<string, unknown>) => void mutate('saved_filters', id, patch).catch((e: unknown) => notify(String(e)));

  if (!filter) {
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
        query={filter.query}
        header={
          <EditNameBar
            name={filter.name}
            label="Nazwa filtra"
            onSave={(name) => update({ name: name.slice(0, 100) })}
            onDelete={() => {
              update({ deleted_at: new Date().toISOString() });
              router.back();
            }}
            deleteTitle={`Usunąć filtr „${filter.name}”?`}
            deleteMessage="Zadania zostaną bez zmian."
          />
        }
      />
    </>
  );
}
