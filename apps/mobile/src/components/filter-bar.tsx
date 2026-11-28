/**
 * Chipy filtrów nad listą (M4, jak `FilterBar` na webie): aktywny warunek = chip (dotknięcie
 * zmienia, „×” usuwa), „+ Filtr” dodaje kolejny, „Wyczyść” zdejmuje wszystkie. Wybór w arkuszach
 * `pickOption` / `pickMany`; opis warunków i gotowe zakresy terminu z `core`. Z `save` — „Zapisz jako filtr” (`saved_filters`).
 */
import { ASSIGNEE_CREATOR, ASSIGNEE_CREATOR_LABEL, collaboratorsByStatus, collaboratorsForWorkspace, DUE_PRESETS, duePreset, filterChips, isEmptyFilter, keyBetween, PRIORITY, tagsForWorkspace, TASK_STATUS, uuidv7, type DuePreset, type FilterQuery, type Priority, type TaskStatus } from '@taskplanner/core';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useView } from '@/lib/app-data';

import { useTaskActions } from './actions';
import { pickMany, pickOption } from './pickers';
import { usePalette } from './ui';

export type FilterField = 'tags' | 'priorities' | 'lists' | 'statuses' | 'assignees' | 'due' | 'hasTime';

const FIELD_LABEL: Record<FilterField, string> = {
  tags: 'Tagi',
  priorities: 'Priorytet',
  lists: 'Lista',
  statuses: 'Status',
  assignees: 'Odpowiedzialny',
  due: 'Termin',
  hasTime: 'Godzina',
};

const orUndefined = <T,>(values: T[]): T[] | undefined => (values.length ? values : undefined);

/** Komunikat pustego widoku: przy aktywnym filtrze nie „nic nie ma”, tylko „nic nie pasuje”. */
export function filterEmptyText(query: FilterQuery, text: string): string {
  return isEmptyFilter(query) ? text : 'Żadne zadanie nie pasuje do filtra — „Wyczyść” pokaże wszystkie.';
}

export function FilterBar({ query, onChange, hide = [], save }: { query: FilterQuery; onChange: (query: FilterQuery) => void; hide?: readonly FilterField[]; save?: boolean }) {
  const p = usePalette();
  const { data, workspaceId } = useView();
  // Tagi bieżącej przestrzeni + już zaznaczone.
  const tags = tagsForWorkspace(data.tags, workspaceId, query.tags?.ids);
  const names = {
    tags: new Map(data.tags.map((t) => [t.id, t.name])),
    lists: new Map(data.lists.map((l) => [l.id, l.kind === 'inbox' ? `Inbox (${data.workspaces.find((w) => w.id === l.workspaceId)?.name})` : l.name])),
    workspaces: new Map(data.workspaces.map((w) => [w.id, w.name])),
    assignees: new Map(data.collaborators.map((c) => [c.id, c.name])),
  };
  const set = (patch: Partial<FilterQuery>) => onChange({ ...query, ...patch });
  const chips = filterChips(query, names).filter((c) => !hide.includes(c.field as FilterField));
  const unused = (Object.keys(FIELD_LABEL) as FilterField[]).filter((f) => !hide.includes(f) && query[f] === undefined);

  const edit = async (field: FilterField) => {
    switch (field) {
      case 'tags': {
        if (!tags.length) {
          await pickOption('Tagi', [{ label: 'Brak tagów — dodaj je w zadaniu (@tag).', value: null }]);
          return;
        }
        const ids = await pickMany('Tagi', tags.map((t) => ({ label: t.name, value: t.id, selected: !!query.tags?.ids.includes(t.id) })));
        if (!ids) return;
        if (!ids.length) return set({ tags: undefined });
        let match = query.tags?.match ?? 'any';
        if (ids.length > 1) {
          const picked = await pickOption<'any' | 'all'>('Zadanie ma mieć', [
            { label: 'Dowolny z tagów', value: 'any', selected: match === 'any' },
            { label: 'Wszystkie tagi', value: 'all', selected: match === 'all' },
          ]);
          if (picked) match = picked;
        }
        return set({ tags: { ids, match } });
      }
      case 'priorities': {
        const values = await pickMany<Priority>('Priorytet', ([1, 2, 3, 4] as Priority[]).map((v) => ({ label: PRIORITY[v].label, value: v, selected: !!query.priorities?.includes(v) })));
        if (values) set({ priorities: orUndefined(values) });
        return;
      }
      case 'lists': {
        const values = await pickMany(
          'Lista',
          data.lists.map((l) => ({ label: l.kind === 'inbox' ? 'Inbox' : l.name, hint: data.workspaces.find((w) => w.id === l.workspaceId)?.name, value: l.id, selected: !!query.lists?.includes(l.id) })),
        );
        if (values) set({ lists: orUndefined(values) });
        return;
      }
      case 'statuses': {
        const values = await pickMany<TaskStatus>('Status', (Object.keys(TASK_STATUS) as TaskStatus[]).map((s) => ({ label: TASK_STATUS[s], value: s, selected: !!query.statuses?.includes(s) })));
        if (values) set({ statuses: orUndefined(values) });
        return;
      }
      case 'assignees': {
        const values = await pickMany<string>('Odpowiedzialny', [
          { label: ASSIGNEE_CREATOR_LABEL, hint: 'bez wskazanej osoby', value: ASSIGNEE_CREATOR, selected: !!query.assignees?.includes(ASSIGNEE_CREATOR) },
          ...collaboratorsByStatus(collaboratorsForWorkspace(data.collaborators, workspaceId, query.assignees)).map((c) => ({ label: c.name, hint: c.archivedAt ? 'nieaktywny' : undefined, value: c.id, selected: !!query.assignees?.includes(c.id) })),
        ]);
        if (values) set({ assignees: orUndefined(values) });
        return;
      }
      case 'due': {
        const current = duePreset(query.due);
        const key = await pickOption<DuePreset>('Termin', (Object.keys(DUE_PRESETS) as DuePreset[]).map((k) => ({ label: DUE_PRESETS[k].label, value: k, selected: current === k })));
        if (key) set({ due: DUE_PRESETS[key].due });
        return;
      }
      case 'hasTime': {
        const v = await pickOption<boolean>('Godzina', [
          { label: 'Z godziną', value: true, selected: query.hasTime === true },
          { label: 'Bez godziny', value: false, selected: query.hasTime === false },
        ]);
        if (v !== undefined) set({ hasTime: v });
        return;
      }
    }
  };

  const add = async () => {
    const field = await pickOption<FilterField>('Filtruj według', unused.map((f) => ({ label: FIELD_LABEL[f], value: f })));
    if (field) await edit(field);
  };

  return (
    <View style={styles.row} accessibilityLabel="Filtry">
      {chips.map((chip) => (
        <View key={chip.field} style={[styles.chip, { backgroundColor: p.selected }]}>
          <Pressable hitSlop={{ top: 6, bottom: 6 }} accessibilityRole="button" accessibilityLabel={`Zmień filtr: ${chip.label}`} onPress={() => void edit(chip.field as FilterField)} style={styles.chipLabel}>
            <Text style={{ color: p.fg, fontSize: 13 }} numberOfLines={1}>
              {chip.label}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Usuń filtr: ${chip.label}`} hitSlop={8} onPress={() => set({ [chip.field]: undefined })} style={styles.chipX}>
            <Text style={{ color: p.muted, fontSize: 15 }}>×</Text>
          </Pressable>
        </View>
      ))}
      {unused.length ? (
        <Pressable hitSlop={6} accessibilityRole="button" onPress={() => void add()} style={[styles.add, { borderColor: p.border }]}>
          <Text style={{ color: p.muted, fontSize: 13 }}>+ Filtr</Text>
        </Pressable>
      ) : null}
      {!isEmptyFilter(query) ? (
        <Pressable hitSlop={6} accessibilityRole="button" onPress={() => onChange({})} style={styles.clear}>
          <Text style={{ color: p.muted, fontSize: 13 }}>Wyczyść</Text>
        </Pressable>
      ) : null}
      {save && !isEmptyFilter(query) ? <SaveFilter query={query} /> : null}
    </View>
  );
}

/** „Zapisz jako filtr”: nazwa w polu obok chipów, po zapisie otwiera się zapisany filtr. */
function SaveFilter({ query }: { query: FilterQuery }) {
  const p = usePalette();
  const { data } = useView();
  const { run } = useTaskActions();
  const [name, setName] = useState<string | null>(null);
  if (name === null) {
    return (
      <Pressable hitSlop={6} accessibilityRole="button" onPress={() => setName('')} style={styles.clear}>
        <Text style={{ color: p.accent, fontSize: 13 }}>Zapisz jako filtr</Text>
      </Pressable>
    );
  }
  const value = name.trim();
  const submit = async () => {
    if (!value) return;
    const id = uuidv7();
    await run([{ table: 'saved_filters', id, patch: { name: value.slice(0, 60), icon: null, query, sort_key: keyBetween(data.savedFilters.at(-1)?.sortKey) } }], { text: `Zapisano filtr „${value}”` });
    setName(null);
    router.push({ pathname: '/filter/[id]', params: { id } });
  };
  return (
    <View style={styles.save}>
      <TextInput
        autoFocus
        value={name}
        onChangeText={setName}
        placeholder="Nazwa filtra"
        placeholderTextColor={p.muted}
        accessibilityLabel="Nazwa filtra"
        maxLength={60}
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        style={[styles.saveInput, { color: p.fg, borderColor: p.border }]}
      />
      <Pressable accessibilityRole="button" disabled={!value} onPress={() => void submit()} hitSlop={8}>
        <Text style={{ color: p.accent, fontSize: 14, fontWeight: '600', opacity: value ? 1 : 0.4 }}>Zapisz</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Anuluj zapis filtra" onPress={() => setName(null)} hitSlop={8}>
        <Text style={{ color: p.muted, fontSize: 16 }}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, maxWidth: '100%' },
  chipLabel: { paddingLeft: 10, paddingRight: 4, paddingVertical: 5, minHeight: 36, justifyContent: 'center', flexShrink: 1 },
  chipX: { paddingLeft: 4, paddingRight: 10, minHeight: 36, justifyContent: 'center' },
  add: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, minHeight: 36, justifyContent: 'center' },
  clear: { paddingHorizontal: 8, paddingVertical: 5, minHeight: 36, justifyContent: 'center' },
  save: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12 },
  saveInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14 },
});
