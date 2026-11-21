/**
 * Listy przestrzeni (M2): Inbox na górze (bez zmiany nazwy, archiwizacji i usuwania), listy
 * i projekty z nazwą, kolorem, rodzajem, kolejnością i archiwizacją. Szybkie zadanie do Inboxu —
 * do sprawdzenia kryterium MVP-1 (zadanie z trybu samolotowego na serwerze po włączeniu sieci).
 */
import { canEditScope, inboxId, LIST_KIND, plural, PROJECT_STATUS, type ListKind, type ProjectStatus, type ScopeRole } from '@taskplanner/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { EditableItem } from '@/components/editable-item';
import { SharingSection } from '@/components/sharing';
import { SyncIndicator } from '@/components/sync-indicator';
import { Button, Chip, ColorPicker, Field, P, Row, Screen, Section } from '@/components/ui';
import { useLocalQuery } from '@/lib/local-query';
import { createTask } from '@/lib/tasks';
import { archiveList, createList, listItems, moveItem, removeList, updateList, type ListItem } from '@/lib/workspaces';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;
const KINDS = ['list', 'project'] as const satisfies readonly Exclude<ListKind, 'inbox'>[];
const STATUSES = Object.keys(PROJECT_STATUS) as ProjectStatus[];

export default function Workspace() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const workspace = useLocalQuery(
    ['workspaces'],
    async (engine) => (await engine.db.all<{ name: string; role: ScopeRole | null }>('select w.name, s.role from workspaces w left join _scopes s on s.id = w.id where w.id = ?', [id]))[0],
    [id],
  );
  // Przestrzeń udostępniona do podglądu: tylko odczyt (silnik i tak odrzuca zapis).
  const editable = canEditScope(workspace?.role);
  const lists = useLocalQuery(['lists', 'tasks'], (engine) => listItems(engine, id), [id]) ?? [];
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Exclude<ListKind, 'inbox'>>('list');
  const [color, setColor] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const inbox = lists.find((l) => l.kind === 'inbox');
  const active = lists.filter((l) => l.kind !== 'inbox' && !l.archived_at);
  const archived = lists.filter((l) => l.kind !== 'inbox' && l.archived_at);

  const subtitle = (l: ListItem) =>
    [LIST_KIND[l.kind], l.kind === 'project' && l.project_status ? PROJECT_STATUS[l.project_status] : null, plural(l.open, TASKS)].filter(Boolean).join(' · ');

  const row = (l: ListItem, index: number, group: ListItem[]) =>
    !editable ? (
      <EditableItem key={l.id} name={l.name} color={l.color} subtitle={subtitle(l)} archived={!!l.archived_at} onError={onError} />
    ) : (
      <EditableItem
        key={l.id}
        name={l.name}
        color={l.color}
        subtitle={subtitle(l)}
        archived={!!l.archived_at}
        onSave={(patch) => updateList(l, { name: patch.name })}
        onColor={(c) => updateList(l, { color: c })}
        onMoveUp={index > 0 ? () => moveItem('lists', group, index, index - 1) : undefined}
        onMoveDown={index < group.length - 1 ? () => moveItem('lists', group, index, index + 1) : undefined}
        onArchive={(value) => archiveList(l, value)}
        onError={onError}
      >
        <Row>
          {KINDS.map((k) => (
            <Chip key={k} label={LIST_KIND[k]} selected={l.kind === k} onPress={() => void updateList(l, { kind: k }).catch(onError)} />
          ))}
        </Row>
        {l.kind === 'project' ? (
          <Row>
            {STATUSES.map((s) => (
              <Chip key={s} label={PROJECT_STATUS[s]} selected={l.project_status === s} onPress={() => void updateList(l, { project_status: s }).catch(onError)} />
            ))}
          </Row>
        ) : null}
        {l.total === 0 ? (
          <Button
            kind="danger"
            title="Usuń pustą listę"
            onPress={() =>
              Alert.alert(`Usunąć „${l.name}”?`, 'Lista jest pusta.', [
                { text: 'Anuluj', style: 'cancel' },
                { text: 'Usuń', style: 'destructive', onPress: () => void removeList(l).catch(onError) },
              ])
            }
          />
        ) : null}
      </EditableItem>
    );

  return (
    <Screen>
      <Stack.Screen options={{ title: workspace?.name ?? 'Przestrzeń' }} />
      <SyncIndicator />
      {error ? <P tone="bad">{error}</P> : null}

      {editable ? (
        <Section title="Szybkie zadanie do Inboxu">
          <Row>
            <Field label="Tytuł" value={task} onChangeText={setTask} maxLength={500} style={{ minWidth: 200 }} />
          </Row>
          <Button
            title="Dodaj"
            disabled={!task.trim()}
            onPress={() => {
              setError(null);
              createTask({ list_id: inbox?.id ?? inboxId(id), title: task.trim() })
                .then(() => setTask(''))
                .catch(onError);
            }}
          />
        </Section>
      ) : null}

      {inbox ? (
        <EditableItem name={inbox.name} color={inbox.color} subtitle={subtitle(inbox)} onColor={editable ? (c) => updateList(inbox, { color: c }) : undefined} onError={onError}>
          <P muted>Inbox jest jeden na przestrzeń — nie zmienia nazwy i nie da się go usunąć.</P>
        </EditableItem>
      ) : null}
      {active.map((l, i) => row(l, i, active))}

      {editable ? (
        <Section title="Nowa lista">
          <Field label="Nazwa" value={name} onChangeText={setName} placeholder="np. Zakupy, Remont" maxLength={200} />
          <Row>
            {KINDS.map((k) => (
              <Chip key={k} label={LIST_KIND[k]} selected={kind === k} onPress={() => setKind(k)} />
            ))}
          </Row>
          <ColorPicker value={color} onChange={setColor} />
          <Button
            title={`Dodaj: ${LIST_KIND[kind].toLowerCase()}`}
            disabled={!name.trim()}
            onPress={() => {
              setError(null);
              createList(id, { name, kind, color })
                .then(() => setName(''))
                .catch(onError);
            }}
          />
        </Section>
      ) : null}

      {archived.length ? (
        <>
          <Button kind="secondary" title={`${showArchived ? 'Ukryj' : 'Pokaż'} zarchiwizowane (${archived.length})`} onPress={() => setShowArchived(!showArchived)} />
          {showArchived ? archived.map((l, i) => row(l, i, archived)) : null}
        </>
      ) : null}

      <SharingSection workspaceId={id} name={workspace?.name ?? ''} />
    </Screen>
  );
}
