/**
 * Listy przestrzeni (M2): Inbox na górze (bez zmiany nazwy, archiwizacji i usuwania), listy
 * i projekty z nazwą, kolorem, rodzajem, kolejnością i archiwizacją. Szybkie zadanie do Inboxu —
 * do sprawdzenia kryterium MVP-1 (zadanie z trybu samolotowego na serwerze po włączeniu sieci).
 */
import { canEditScope, GUEST_ACCESS, GUEST_ACCESS_HINT, GUEST_ACCESS_NOTE, inboxId, LIST_KIND, listAccess, plural, PROJECT_STATUS, type GuestAccess, type ListKind, type ProjectStatus, type ScopeRole } from '@taskplanner/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { ColorPicker } from '@/components/color-picker';
import { EditableItem } from '@/components/editable-item';
import { SharingSection } from '@/components/sharing';
import { SyncIndicator } from '@/components/sync-indicator';
import { TemplateFields, TemplatesSection, type TemplateChoice } from '@/components/templates';
import { Button, Chip, Field, P, Row, Screen, Section } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { createTask } from '@/lib/tasks';
import { createProjectFromTemplate, useProjectTemplates } from '@/lib/templates';
import { archiveList, createList, listItems, moveItem, removeList, updateList, type ListItem } from '@/lib/workspaces';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;
const KINDS = ['list', 'project'] as const satisfies readonly Exclude<ListKind, 'inbox'>[];
const STATUSES = Object.keys(PROJECT_STATUS) as ProjectStatus[];
const ACCESS: GuestAccess[] = ['edit', 'view', 'hidden'];

export default function Workspace() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const workspace = useLocalQuery(
    ['workspaces'],
    async (engine) => (await engine.db.all<{ name: string; role: ScopeRole | null }>('select w.name, s.role from workspaces w left join _scopes s on s.id = w.id where w.id = ?', [id]))[0],
    [id],
  );
  // Przestrzeń udostępniona do podglądu: tylko odczyt (silnik i tak odrzuca zapis).
  const editable = canEditScope(workspace?.role);
  const owner = !workspace?.role || workspace.role === 'owner';
  // Gość: lista tylko do podglądu (`lists.guest_access`) jest zablokowana jak cała przestrzeń.
  const listEditable = (l: ListItem) => editable && listAccess(workspace?.role, l.guest_access ?? 'edit') === 'edit';
  const lists = useLocalQuery(['lists', 'tasks'], (engine) => listItems(engine, id), [id]) ?? [];
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Exclude<ListKind, 'inbox'>>('list');
  const [color, setColor] = useState<string | null>(null);
  const { data, today } = useView();
  const templates = useProjectTemplates();
  const [template, setTemplate] = useState<TemplateChoice | null>(null);
  // Szablon usunięty w międzyczasie (inne urządzenie) — pusty projekt.
  const chosen = kind === 'project' && template && templates.some((t) => t.id === template.template.id) ? template : null;
  const [task, setTask] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const inbox = lists.find((l) => l.kind === 'inbox');
  const active = lists.filter((l) => l.kind !== 'inbox' && !l.archived_at);
  const archived = lists.filter((l) => l.kind !== 'inbox' && l.archived_at);

  const subtitle = (l: ListItem) =>
    [
      LIST_KIND[l.kind],
      l.kind === 'project' && l.project_status ? PROJECT_STATUS[l.project_status] : null,
      plural(l.open, TASKS),
      owner && (l.guest_access ?? 'edit') !== 'edit' ? `dla gości: ${GUEST_ACCESS[l.guest_access!].toLowerCase()}` : null,
      !owner && editable && !listEditable(l) ? 'tylko podgląd' : null,
    ]
      .filter(Boolean)
      .join(' · ');

  /** Dostęp gości (tylko właściciel). */
  const access = (l: ListItem) =>
    owner ? (
      <>
        <P muted>Dla gości: {GUEST_ACCESS_HINT[l.guest_access ?? 'edit']}.</P>
        <Row>
          {ACCESS.map((a) => (
            <Chip key={a} label={GUEST_ACCESS[a]} selected={(l.guest_access ?? 'edit') === a} onPress={() => void updateList(l, { guest_access: a }).catch(onError)} />
          ))}
        </Row>
      </>
    ) : null;

  const row = (l: ListItem, index: number, group: ListItem[]) =>
    !listEditable(l) ? (
      <EditableItem key={l.id} name={l.name} maxLength={200} color={l.color} subtitle={subtitle(l)} archived={!!l.archived_at} onError={onError} />
    ) : (
      <EditableItem
        key={l.id}
        name={l.name}
        maxLength={200}
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
        {access(l)}
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

      {inbox && listEditable(inbox) ? (
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
        <EditableItem name={inbox.name} maxLength={200} color={inbox.color} subtitle={subtitle(inbox)} onColor={listEditable(inbox) ? (c) => updateList(inbox, { color: c }) : undefined} onError={onError}>
          <P muted>Inbox jest jeden na przestrzeń — nie zmienia nazwy i nie da się go usunąć.</P>
          {access(inbox)}
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
          {kind === 'project' ? <TemplateFields templates={templates} value={chosen} onChange={setTemplate} today={today} /> : null}
          <ColorPicker value={color} onChange={setColor} />
          <Button
            title={chosen ? 'Dodaj projekt z szablonu' : `Dodaj: ${LIST_KIND[kind].toLowerCase()}`}
            disabled={!name.trim()}
            onPress={() => {
              setError(null);
              (chosen
                ? createProjectFromTemplate({ template: chosen.template, anchor: chosen.anchor, workspaceId: id, name, color, userId: data.userId, tags: data.tags })
                : createList(id, { name, kind, color })
              )
                .then(() => {
                  setName('');
                  setTemplate(null);
                })
                .catch(onError);
            }}
          />
        </Section>
      ) : null}
      <TemplatesSection />

      {archived.length ? (
        <>
          <Button kind="secondary" title={`${showArchived ? 'Ukryj' : 'Pokaż'} zarchiwizowane (${archived.length})`} onPress={() => setShowArchived(!showArchived)} />
          {showArchived ? archived.map((l, i) => row(l, i, archived)) : null}
        </>
      ) : null}

      {owner ? <P muted>{GUEST_ACCESS_NOTE} Ustawisz go przy każdej liście („Edytuj”).</P> : null}
      <SharingSection workspaceId={id} name={workspace?.name ?? ''} />
    </Screen>
  );
}
