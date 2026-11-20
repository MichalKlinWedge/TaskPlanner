/**
 * Współpracownicy (jak Ustawienia → „Współpracownicy” na webie): osoby do wskazania jako
 * odpowiedzialne i uczestnicy zadań — tylko informacyjnie, bez dostępu. Dodanie, edycja (nazwa,
 * e-mail), usunięcie z „Cofnij” (osoba znika z uczestników, zadania wracają do twórcy).
 */
import { collaboratorSaveOps, deleteCollaboratorOps, plural, type Collaborator } from '@taskplanner/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { confirm, useTaskActions } from '@/components/actions';
import { Button, Field, P, Row, Screen, Section, usePalette } from '@/components/ui';
import { useAppData } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { localEngine } from '@/lib/sync';

interface Usage {
  assigned: number;
  participating: number;
}

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
  const [draft, setDraft] = useState({ name: '', email: '' });
  const [editing, setEditing] = useState<{ id: string; name: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const result = collaboratorSaveOps(data.userId, data.collaborators, draft);
    if (!result.ok) return setError(result.error);
    setError(null);
    setDraft({ name: '', email: '' });
    void run(result.ops, { text: `Dodano „${draft.name.trim()}”` });
  };
  const save = (person: Collaborator) => {
    if (!editing) return;
    const result = collaboratorSaveOps(data.userId, data.collaborators, editing, person);
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
    void run(ops, { text: `Usunięto „${person.name}”`, undo });
  };

  return (
    <Screen>
      <Section title="Osoby">
        <P muted>Do wskazania jako odpowiedzialne i uczestnicy zadań. Tylko informacyjnie — nie dostają dostępu do zadań ani powiadomień.</P>
        {data.collaborators.map((person) => {
          const count = usage.get(person.id);
          const info = [
            count?.assigned ? `odpowiada za ${plural(count.assigned, ['zadanie', 'zadania', 'zadań'])}` : null,
            count?.participating ? `uczestnik ${plural(count.participating, ['zadania', 'zadań', 'zadań'])}` : null,
          ].filter(Boolean);
          return editing?.id === person.id ? (
            <View key={person.id} style={[styles.person, { borderColor: p.border }]}>
              <Field label="Nazwa" value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} maxLength={100} autoFocus />
              <Field label="E-mail (opcjonalnie)" value={editing.email} onChangeText={(email) => setEditing({ ...editing, email })} maxLength={254} autoCapitalize="none" keyboardType="email-address" />
              <Row>
                <Button title="Zapisz" onPress={() => save(person)} />
                <Button title="Anuluj" kind="secondary" onPress={() => setEditing(null)} />
              </Row>
            </View>
          ) : (
            <View key={person.id} style={[styles.person, styles.line, { borderColor: p.border }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Edytuj ${person.name}`}
                style={{ flex: 1, gap: 2 }}
                onPress={() => setEditing({ id: person.id, name: person.name, email: person.email ?? '' })}
              >
                <Text style={{ color: p.fg, fontSize: 16 }}>{person.name}</Text>
                {person.email ? <Text style={{ color: p.muted, fontSize: 13 }}>{person.email}</Text> : null}
                {info.length ? <Text style={{ color: p.muted, fontSize: 12 }}>{info.join(' · ')}</Text> : null}
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Usuń ${person.name}`} hitSlop={10} onPress={() => void remove(person)}>
                <Text style={{ color: p.muted, fontSize: 18 }}>✕</Text>
              </Pressable>
            </View>
          );
        })}
        {!data.collaborators.length ? <P muted>Brak współpracowników — dodaj osobę poniżej albo wpisz nazwę w polu „+ osoba” w zadaniu.</P> : null}
      </Section>

      <Section title="Nowa osoba">
        <Field label="Imię i nazwisko" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} maxLength={100} />
        <Field label="E-mail (opcjonalnie)" value={draft.email} onChangeText={(email) => setDraft({ ...draft, email })} maxLength={254} autoCapitalize="none" keyboardType="email-address" />
        <Button title="Dodaj" disabled={!draft.name.trim()} onPress={add} />
        {error ? <P tone="bad">{error}</P> : null}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  person: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
