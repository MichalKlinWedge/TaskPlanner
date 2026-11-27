/**
 * Współpracownicy (jak widok „Współpracownicy” na webie): osoby do wskazania jako odpowiedzialne i
 * uczestnicy zadań — tylko informacyjnie, bez dostępu. Dodanie, edycja (nazwa, e-mail, akronim i kolor
 * znaczka przy zadaniu, status — tylko aktywni podpowiadają się przy zadaniach, przestrzenie, w których
 * osoba się podpowiada — jak przy tagach, żadna = wszystkie), usunięcie z „Cofnij”
 * (osoba znika z uczestników, zadania wracają do twórcy).
 *
 * Niżej, tylko do odczytu: konta i zaproszenia z udostępnionych przestrzeni (`workspace_sharing`,
 * wymaga sieci; „+ Dodaj” wypełnia formularz nowej osoby) oraz osoby wpisane przez innych członków
 * (`scope_collaborators`, `shared`).
 */
import { collaboratorBadge, collaboratorBadgeColors, collaboratorSaveOps, collaboratorsByStatus, ownCollaborators, deleteCollaboratorOps, initials, isActiveCollaborator, nameFromEmail, memberSince, plural, SCOPE_ROLE, spacePeople, type Collaborator, type SpaceSharing } from '@taskplanner/core';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { confirm, useTaskActions } from '@/components/actions';
import { ColorPicker } from '@/components/color-picker';
import { Button, Field, P, Row, Screen, Section, usePalette } from '@/components/ui';
import { WorkspaceChips } from '@/components/workspace-chips';
import { useAppData, type AppData } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { workspaceSharing } from '@/lib/sharing';
import { localEngine } from '@/lib/sync';

interface Usage {
  assigned: number;
  participating: number;
}

interface Draft {
  name: string;
  email: string;
  acronym: string;
  color: string | null;
  active: boolean;
  workspaceIds: string[];
}

const EMPTY: Draft = { name: '', email: '', acronym: '', color: null, active: true, workspaceIds: [] };
const draftOf = (person: Collaborator): Draft => ({ name: person.name, email: person.email ?? '', acronym: person.acronym ?? '', color: person.color ?? null, active: isActiveCollaborator(person), workspaceIds: [...(person.workspaceIds ?? [])] });

export default function Collaborators() {
  const p = usePalette();
  const data = useAppData();
  const { run } = useTaskActions();
  const usage =
    useLocalQuery(['collaborators', 'tasks', 'task_participants'], async (engine) => {
      const rows = await engine.db.all<{ id: string; assigned: number; participating: number }>(
        `select c.id,
                (select count(*) from tasks t where t.assignee_id = c.id and t.deleted_at is null) as assigned,
                (select count(*) from task_participants p join tasks t on t.id = p.task_id
                  where p.collaborator_id = c.id and p.deleted_at is null and t.deleted_at is null) as participating
           from collaborators c where c.deleted_at is null`,
      );
      return new Map(rows.map((r): [string, Usage] => [r.id, { assigned: Number(r.assigned), participating: Number(r.participating) }]));
    }) ?? new Map<string, Usage>();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const people = collaboratorsByStatus(ownCollaborators(data.collaborators));
  const shared = collaboratorsByStatus(data.collaborators.filter((c) => c.shared));
  const spaces = useSpaceSharing(data.workspaces);
  const accounts = useMemo(() => (spaces.list ? spacePeople(spaces.list, data.collaborators) : []), [spaces.list, data.collaborators]);

  const add = () => {
    const result = collaboratorSaveOps(data.userId, data.collaborators, draft);
    if (!result.ok) return setError(result.error);
    setError(null);
    setDraft(EMPTY);
    void run(result.ops, { text: `Dodano „${draft.name.trim()}”` });
  };
  const save = (person: Collaborator) => {
    if (!editing) return;
    const result = collaboratorSaveOps(data.userId, data.collaborators, editing.draft, person);
    if (!result.ok) return setError(result.error);
    setError(null);
    setEditing(null);
    if (result.ops.length) void run(result.ops);
  };
  const remove = async (person: Collaborator) => {
    const count = usage.get(person.id);
    const uses = (count?.assigned ?? 0) + (count?.participating ?? 0);
    if (uses && !(await confirm(`Usunąć „${person.name}”?`, 'Osoba zniknie z uczestników zadań, a zadania, za które odpowiada, wrócą do twórcy.', 'Usuń', 'Anuluj'))) return;
    const engine = await localEngine();
    const [assigned, participants] = await Promise.all([
      engine.db.all<{ id: string }>('select id from tasks where assignee_id = ?', [person.id]),
      engine.db.all<{ id: string }>('select id from task_participants where collaborator_id = ? and deleted_at is null', [person.id]),
    ]);
    const { ops, undo } = deleteCollaboratorOps(person, { assignedTaskIds: assigned.map((r) => r.id), participantRowIds: participants.map((r) => r.id) }, new Date());
    setEditing(null);
    void run(ops, { text: `Usunięto „${person.name}”`, undo });
  };

  return (
    <Screen>
      <Section title="Osoby">
        <P muted>Do wskazania jako odpowiedzialne i uczestnicy zadań. Tylko informacyjnie — nie dostają dostępu do zadań ani powiadomień. Nieaktywni nie podpowiadają się przy zadaniach.</P>
        {people.map((person) => {
          const count = usage.get(person.id);
          const active = isActiveCollaborator(person);
          const spaces = (person.workspaceIds ?? []).map((id) => data.workspaces.find((w) => w.id === id)?.name).filter(Boolean);
          const info = [
            person.email,
            spaces.length ? `tylko: ${spaces.join(', ')}` : null,
            count?.assigned ? `odpowiada za ${plural(count.assigned, ['zadanie', 'zadania', 'zadań'])}` : null,
            count?.participating ? `uczestnik ${plural(count.participating, ['zadania', 'zadań', 'zadań'])}` : null,
          ].filter(Boolean);
          return editing?.id === person.id ? (
            <View key={person.id} style={[styles.person, { borderColor: p.border }]}>
              <PersonFields draft={editing.draft} onChange={(next) => setEditing({ id: person.id, draft: next })} workspaces={data.workspaces} />
              <Row>
                <Button title="Zapisz" onPress={() => save(person)} />
                <Button title="Anuluj" kind="secondary" onPress={() => setEditing(null)} />
                <Button title="Usuń" kind="danger" onPress={() => void remove(person)} />
              </Row>
            </View>
          ) : (
            <Pressable
              key={person.id}
              accessibilityRole="button"
              accessibilityLabel={`Edytuj ${person.name}`}
              style={[styles.person, styles.line, { borderColor: p.border, opacity: active ? 1 : 0.55 }]}
              onPress={() => {
                setError(null);
                setEditing({ id: person.id, draft: draftOf(person) });
              }}
            >
              <PersonBadge person={person} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: p.fg, fontSize: 16 }}>
                  {person.name}
                  {active ? '' : '  · nieaktywny'}
                </Text>
                {info.length ? <Text style={{ color: p.muted, fontSize: 12 }}>{info.join(' · ')}</Text> : null}
              </View>
            </Pressable>
          );
        })}
        {!people.length ? <P muted>Brak współpracowników — dodaj osobę poniżej albo wpisz nazwę w polu „+ osoba” w zadaniu.</P> : null}
      </Section>

      {accounts.length || spaces.error ? (
        <Section title="Osoby w udostępnionych przestrzeniach">
          {spaces.error ? <P muted>{spaces.error}</P> : null}
          {accounts.map((person) => (
            <View key={person.email} style={[styles.person, styles.line, { borderColor: p.border }]}>
              <View style={[styles.badge, { backgroundColor: p.ok }]}>
                <Text style={styles.badgeText}>{initials(nameFromEmail(person.email) || person.email)}</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: p.fg, fontSize: 15 }} numberOfLines={1}>
                  {person.email}
                </Text>
                <Text style={{ color: p.muted, fontSize: 12 }}>
                  {person.spaces.map((s) => `${s.workspace} — ${s.pending ? `zaproszenie (${SCOPE_ROLE[s.role].toLowerCase()})` : [SCOPE_ROLE[s.role].toLowerCase(), memberSince(s.joinedAt)].filter(Boolean).join(', ')}`).join(' · ')}
                </Text>
              </View>
              {person.collaboratorId ? (
                <Text style={{ color: p.muted, fontSize: 12 }}>na liście</Text>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Dodaj ${person.email} do współpracowników`}
                  onPress={() => {
                    setError(null);
                    setDraft({ ...EMPTY, name: nameFromEmail(person.email), email: person.email, workspaceIds: person.spaces.map((s) => s.workspaceId) });
                  }}
                  style={[styles.add, { borderColor: p.border }]}
                >
                  <Text style={{ color: p.accent, fontSize: 13 }}>+ Dodaj</Text>
                </Pressable>
              )}
            </View>
          ))}
          {accounts.some((a) => !a.collaboratorId) ? <P muted>„+ Dodaj” wypełnia formularz „Nowa osoba” poniżej.</P> : null}
        </Section>
      ) : null}

      {shared.length ? (
        <Section title="Wpisani przez innych członków przestrzeni">
          <P muted>Można ich wskazać w zadaniach tych przestrzeni; zmienia ich osoba, która ich wpisała.</P>
          {shared.map((person) => (
            <View key={person.id} style={[styles.person, styles.line, { borderColor: p.border, opacity: isActiveCollaborator(person) ? 1 : 0.55 }]}>
              <PersonBadge person={person} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: p.fg, fontSize: 16 }}>
                  {person.name}
                  {isActiveCollaborator(person) ? '' : '  · nieaktywny'}
                </Text>
                <Text style={{ color: p.muted, fontSize: 12 }}>
                  {(person.workspaceIds ?? [])
                    .map((id) => data.workspaces.find((w) => w.id === id)?.name)
                    .filter(Boolean)
                    .join(', ')}
                </Text>
              </View>
            </View>
          ))}
        </Section>
      ) : null}

      <Section title="Nowa osoba">
        <PersonFields draft={draft} onChange={setDraft} workspaces={data.workspaces} />
        <Button title="Dodaj" disabled={!draft.name.trim()} onPress={add} />
        {error ? <P tone="bad">{error}</P> : null}
      </Section>
    </Screen>
  );
}

/** Członkowie i zaproszenia przestrzeni udostępnionych albo własnych — z serwera, bez sieci komunikat. */
function useSpaceSharing(workspaces: AppData['workspaces']): { list: SpaceSharing[] | null; error: string | null } {
  const targets = workspaces.filter((w) => w.role === 'owner' || (w.members ?? 1) > 1).map((w) => ({ id: w.id, name: w.name, members: w.members ?? 1 }));
  const key = JSON.stringify(targets);
  const [state, setState] = useState<{ key: string; list: SpaceSharing[] | null; error: string | null }>({ key: '', list: null, error: null });
  useEffect(() => {
    const list: { id: string; name: string }[] = JSON.parse(key);
    if (!list.length) return;
    let cancelled = false;
    Promise.all(list.map(async (w): Promise<SpaceSharing> => ({ workspaceId: w.id, workspace: w.name, ...(await workspaceSharing(w.id)) })))
      .then((result) => !cancelled && setState({ key, list: result, error: null }))
      .catch(() => !cancelled && setState({ key, list: null, error: 'Osoby z udostępnionych przestrzeni widać tylko z połączeniem z serwerem.' }));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state.key === key ? state : { list: null, error: null };
}

/** Znaczek osoby w jej kolorze (`collaborators.color`); bez koloru — akcent aplikacji. */
function PersonBadge({ person }: { person: Pick<Collaborator, 'name' | 'acronym' | 'color'> }) {
  const p = usePalette();
  const own = collaboratorBadgeColors(person, p.card, p.fg);
  return (
    <View style={[styles.badge, { backgroundColor: own?.fill ?? p.accent }]}>
      <Text style={[styles.badgeText, own && { color: own.ink }]}>{collaboratorBadge(person)}</Text>
    </View>
  );
}

function PersonFields({ draft, onChange, workspaces }: { draft: Draft; onChange: (draft: Draft) => void; workspaces: AppData['workspaces'] }) {
  const p = usePalette();
  return (
    <>
      <Field label="Nazwa" value={draft.name} onChangeText={(name) => onChange({ ...draft, name })} maxLength={100} />
      <Field label="E-mail (opcjonalnie)" value={draft.email} onChangeText={(email) => onChange({ ...draft, email })} maxLength={254} autoCapitalize="none" keyboardType="email-address" />
      <Field
        label="Akronim (znaczek przy zadaniu, puste = inicjały)"
        value={draft.acronym}
        onChangeText={(acronym) => onChange({ ...draft, acronym })}
        maxLength={5}
        autoCapitalize="characters"
        placeholder={draft.name.trim() ? initials(draft.name) : 'np. AN'}
      />
      <Text style={{ color: p.muted, fontSize: 13 }}>Kolor znaczka (odróżnia osoby przy zadaniach; widzą go też pozostali członkowie przestrzeni)</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <PersonBadge person={{ name: draft.name.trim() || 'A N', acronym: draft.acronym.trim() || null, color: draft.color }} />
        <View style={{ flex: 1 }}>
          <ColorPicker value={draft.color} onChange={(color) => onChange({ ...draft, color })} onClear={() => onChange({ ...draft, color: null })} />
        </View>
      </View>
      <Row>
        <Button title="Aktywny" kind={draft.active ? 'primary' : 'secondary'} onPress={() => onChange({ ...draft, active: true })} />
        <Button title="Nieaktywny" kind={draft.active ? 'secondary' : 'primary'} onPress={() => onChange({ ...draft, active: false })} />
      </Row>
      {workspaces.length > 1 ? <WorkspaceChips ids={draft.workspaceIds} workspaces={workspaces} inset={false} onChange={(workspaceIds) => onChange({ ...draft, workspaceIds })} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  person: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { minWidth: 32, height: 32, borderRadius: 16, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  add: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
});
