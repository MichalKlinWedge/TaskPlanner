import { describe, expect, it } from 'vitest';

import {
  addParticipantByNameOps,
  addParticipantOps,
  assigneeOf,
  collaboratorFields,
  collaboratorMatches,
  collaboratorSaveOps,
  creatorLabel,
  deleteCollaboratorOps,
  findCollaborator,
  initials,
  removeParticipantOps,
  sortCollaborators,
  type Collaborator,
} from '../collaborators.ts';
import { collaboratorId, participantId } from '../ids.ts';
import { MODEL } from '../schemas/model.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '01900000-0000-7000-8000-000000000001';
const anna: Collaborator = { id: collaboratorId(USER, 'Anna Nowak'), name: 'Anna Nowak', email: 'anna@example.com' };
const lukasz: Collaborator = { id: collaboratorId(USER, 'Łukasz'), name: 'Łukasz', email: null };
const people = [lukasz, anna];

describe('współpracownicy', () => {
  it('pola formularza: przycięte, pusty e-mail = brak, błędy po polsku', () => {
    expect(collaboratorFields({ name: '  Ola ', email: '  ' })).toEqual({ ok: true, name: 'Ola', email: null });
    expect(collaboratorFields({ name: ' ' })).toEqual({ ok: false, error: 'Nazwa nie może być pusta.' });
    expect(collaboratorFields({ name: 'Ola', email: 'ola@' })).toEqual({ ok: false, error: 'Niepoprawny adres e-mail.' });
  });

  it('id z nazwy: ta sama osoba z dwóch urządzeń to jeden wiersz', () => {
    const a = collaboratorSaveOps(USER, [], { name: 'Łukasz' });
    const b = collaboratorSaveOps(USER, [], { name: ' lukasz ' });
    expect(a.ok && b.ok && a.id === b.id).toBe(true);
    expect(a.ok && a.ops).toEqual([{ table: 'collaborators', id: lukasz.id, patch: { scope_id: USER, name: 'Łukasz', deleted_at: null } }]);
    // Ponowne dodanie (ta sama osoba usunięta albo dodana równolegle) z e-mailem go ustawia, bez — nie kasuje.
    const withEmail = collaboratorSaveOps(USER, [], { name: 'Łukasz', email: 'l@example.com' });
    expect(withEmail.ok && withEmail.ops[0]!.patch.email).toBe('l@example.com');
  });

  it('nowa osoba o nazwie, która już jest — błąd; edycja zmienia tylko różniące się pola', () => {
    expect(collaboratorSaveOps(USER, people, { name: 'anna nowak' })).toEqual({ ok: false, error: '„Anna Nowak” już jest na liście współpracowników.' });
    expect(collaboratorSaveOps(USER, people, { name: 'Anna Nowak', email: 'a@n.pl' }, anna)).toEqual({ ok: true, id: anna.id, ops: [{ table: 'collaborators', id: anna.id, patch: { email: 'a@n.pl' } }] });
    expect(collaboratorSaveOps(USER, people, { name: 'Anna Nowak', email: 'anna@example.com' }, anna)).toEqual({ ok: true, id: anna.id, ops: [] });
    expect(collaboratorSaveOps(USER, people, { name: 'Łukasz' }, anna).ok).toBe(false);
  });

  it('wyszukiwanie bez polskich znaków, po e-mailu, bez wybranych; kolejność alfabetyczna', () => {
    expect(findCollaborator(people, 'lukasz')).toBe(lukasz);
    expect(collaboratorMatches(people, 'luk').map((c) => c.name)).toEqual(['Łukasz']);
    expect(collaboratorMatches(people, 'example').map((c) => c.name)).toEqual(['Anna Nowak']);
    expect(collaboratorMatches(people, '', [anna.id]).map((c) => c.name)).toEqual(['Łukasz']);
    expect(sortCollaborators(people).map((c) => c.name)).toEqual(['Anna Nowak', 'Łukasz']);
  });

  it('usunięcie: zadania wracają do twórcy, uczestnicy znikają; cofnięcie przywraca', () => {
    const part = participantId(TASK, anna.id);
    const { ops, undo } = deleteCollaboratorOps(anna, { assignedTaskIds: [TASK], participantRowIds: [part] }, '2026-11-20T10:00:00Z');
    expect(ops).toEqual([
      { table: 'tasks', id: TASK, patch: { assignee_id: null } },
      { table: 'task_participants', id: part, patch: { deleted_at: '2026-11-20T10:00:00.000Z' } },
      { table: 'collaborators', id: anna.id, patch: { deleted_at: '2026-11-20T10:00:00.000Z' } },
    ]);
    expect(undo).toEqual([
      { table: 'collaborators', id: anna.id, patch: { deleted_at: null } },
      { table: 'task_participants', id: part, patch: { deleted_at: null } },
      { table: 'tasks', id: TASK, patch: { assignee_id: anna.id } },
    ]);
  });

  it('operacje przechodzą schematy wierszy', () => {
    const saved = collaboratorSaveOps(USER, [], { name: 'Ola', email: 'ola@example.com' });
    expect(saved.ok && MODEL.collaborators.safeParse({ id: saved.id, ...saved.ops[0]!.patch }).success).toBe(true);
    const [op] = addParticipantOps(TASK, anna.id);
    expect(MODEL.task_participants.safeParse({ id: op!.id, ...op!.patch }).success).toBe(true);
  });
});

describe('uczestnicy i odpowiedzialny', () => {
  it('uczestnik z nazwy: istniejący współpracownik albo nowy w tej samej paczce', () => {
    expect(addParticipantByNameOps(USER, people, TASK, 'anna nowak')).toEqual({ ok: true, collaboratorId: anna.id, created: false, ops: addParticipantOps(TASK, anna.id) });
    const created = addParticipantByNameOps(USER, people, TASK, 'Ola');
    expect(created.ok && created.created).toBe(true);
    expect(created.ok && created.ops.map((o) => o.table)).toEqual(['collaborators', 'task_participants']);
    expect(addParticipantByNameOps(USER, people, TASK, '  ').ok).toBe(false);
  });

  it('usunięcie uczestnika z cofnięciem, ten sam id wiersza', () => {
    const { ops, undo } = removeParticipantOps(TASK, anna.id, '2026-11-20T10:00:00Z');
    expect(ops[0]!.id).toBe(participantId(TASK, anna.id));
    expect(undo).toEqual([{ table: 'task_participants', id: participantId(TASK, anna.id), patch: { deleted_at: null } }]);
  });

  it('odpowiedzialny: brak / nieznany = twórca; etykieta twórcy', () => {
    expect(assigneeOf(null, people)).toBeNull();
    expect(assigneeOf('01900000-0000-7000-8000-00000000dead', people)).toBeNull();
    expect(assigneeOf(anna.id, people)).toBe(anna);
    expect(creatorLabel(null, USER)).toBe('Ty');
    expect(creatorLabel(USER, USER)).toBe('Ty');
    expect(creatorLabel('00000000-0000-4000-8000-000000000002', USER)).toBe('Twórca zadania');
  });

  it('inicjały', () => {
    expect(initials('Anna Nowak')).toBe('AN');
    expect(initials('łukasz')).toBe('Ł');
    expect(initials('Jan Maria Rokita')).toBe('JM');
  });
});
