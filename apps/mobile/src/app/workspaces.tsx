/** Przestrzenie (M2): tworzenie, nazwa, kolor, kolejność, archiwizacja; wskaźnik synchronizacji. */
import { canEditScope, COLORS, plural, SCOPE_ROLE } from '@taskplanner/core';
import { router } from 'expo-router';
import { useState } from 'react';

import { EditableItem } from '@/components/editable-item';
import { SyncIndicator } from '@/components/sync-indicator';
import { Button, ColorPicker, Field, P, Screen, Section } from '@/components/ui';
import { useLocalQuery } from '@/lib/local-query';
import { archiveWorkspace, createWorkspace, moveItem, updateWorkspace, workspaceItems, type WorkspaceItem } from '@/lib/workspaces';

const LISTS = ['lista', 'listy', 'list'] as const;

export default function Workspaces() {
  const items = useLocalQuery(['workspaces', 'lists'], workspaceItems) ?? [];
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(COLORS[0]!.value);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = items.filter((w) => !w.archived_at);
  const archived = items.filter((w) => w.archived_at);
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // Podgląd tylko czyta; archiwizacja zmienia przestrzeń wszystkim członkom — tylko właściciel.
  const row = (w: WorkspaceItem, index: number, group: WorkspaceItem[]) => {
    const editable = canEditScope(w.role);
    const shared = w.role === 'editor' || w.role === 'viewer';
    return (
      <EditableItem
        key={w.id}
        name={w.name}
        maxLength={100}
        color={w.color}
        subtitle={[plural(w.lists, LISTS), shared ? `udostępniona · ${SCOPE_ROLE[w.role!].toLowerCase()}` : null].filter(Boolean).join(' · ')}
        archived={!!w.archived_at}
        onOpen={() => router.push({ pathname: '/workspace/[id]', params: { id: w.id } })}
        onSave={editable ? (patch) => updateWorkspace(w.id, { name: patch.name }) : undefined}
        onColor={editable ? (c) => updateWorkspace(w.id, { color: c }) : undefined}
        onMoveUp={editable && index > 0 ? () => moveItem('workspaces', group, index, index - 1) : undefined}
        onMoveDown={editable && index < group.length - 1 ? () => moveItem('workspaces', group, index, index + 1) : undefined}
        onArchive={shared ? undefined : (value) => archiveWorkspace(w.id, value)}
        onError={onError}
      />
    );
  };

  return (
    <Screen>
      <SyncIndicator />
      {error ? <P tone="bad">{error}</P> : null}
      {active.length ? active.map((w, i) => row(w, i, active)) : <P muted>Brak aktywnych przestrzeni.</P>}

      <Section title="Nowa przestrzeń">
        <Field label="Nazwa" value={name} onChangeText={setName} placeholder="np. Dom, Studia" maxLength={100} />
        <ColorPicker value={color} onChange={setColor} />
        <Button
          title="Dodaj przestrzeń"
          disabled={!name.trim()}
          onPress={() => {
            setError(null);
            createWorkspace(name, color)
              .then(() => setName(''))
              .catch(onError);
          }}
        />
      </Section>

      {archived.length ? (
        <>
          <Button kind="secondary" title={`${showArchived ? 'Ukryj' : 'Pokaż'} zarchiwizowane (${archived.length})`} onPress={() => setShowArchived(!showArchived)} />
          {showArchived ? archived.map((w, i) => row(w, i, archived)) : null}
        </>
      ) : null}
    </Screen>
  );
}
