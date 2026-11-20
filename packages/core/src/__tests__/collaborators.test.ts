import { describe, expect, it } from 'vitest';

import {
  addParticipantByNameOps,
  addParticipantOps,
  assigneeChoices,
  assigneeOf,
  collaboratorBadge,
  collaboratorFields,
  collaboratorsByStatus,
  collaboratorMatches,
  collaboratorSaveOps,
  collaboratorsForWorkspace,
  collaboratorVisibleIn,
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
    expect(collaboratorFields({ name: '  Ola ', email: '  ' })).toEqual({ ok: true, name: 'Ola', email: null, acronym: null });
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
    expect(saved.ok && MODEL.collaborators.safeParse({ id: saved.id, acronym: null, archived_at: null, workspace_ids: null, ...saved.ops[0]!.patch }).success).toBe(true);
    const [op] = addParticipantOps(TASK, anna.id);
    expect(MODEL.task_participants.safeParse({ id: op!.id, ...op!.patch }).success).toBe(true);
  });
});

describe('akronim i status', () => {
  const ewa: Collaborator = { id: collaboratorId(USER, 'Ewa Kot'), name: 'Ewa Kot', email: null, acronym: 'EK2', archivedAt: '2026-11-19T10:00:00.000Z' };
  const all = [...people, ewa];

  it('akronim: przycięty, pusty = brak, najwyżej 5 znaków; znaczek = akronim albo inicjały', () => {
    expect(collaboratorFields({ name: 'Ola', acronym: ' OL ' })).toEqual({ ok: true, name: 'Ola', email: null, acronym: 'OL' });
    expect(collaboratorFields({ name: 'Ola', acronym: ' ' })).toMatchObject({ ok: true, acronym: null });
    expect(collaboratorFields({ name: 'Ola', acronym: 'ABCDEF' })).toEqual({ ok: false, error: 'Akronim: najwyżej 5 znaków.' });
    expect(collaboratorBadge(ewa)).toBe('EK2');
    expect(collaboratorBadge(anna)).toBe('AN');
  });

  it('status: zmiana tylko przy różnicy; nowa osoba może być od razu nieaktywna', () => {
    const at = '2026-11-20T10:00:00.000Z';
    expect(collaboratorSaveOps(USER, all, { name: 'Anna Nowak', email: anna.email, active: false }, anna, at)).toMatchObject({ ops: [{ patch: { archived_at: at } }] });
    expect(collaboratorSaveOps(USER, all, { name: 'Ewa Kot', acronym: 'EK2', active: true }, ewa, at)).toMatchObject({ ops: [{ patch: { archived_at: null } }] });
    expect(collaboratorSaveOps(USER, all, { name: 'Ewa Kot', acronym: 'EK2', active: false }, ewa, at)).toMatchObject({ ops: [] });
    expect(collaboratorSaveOps(USER, all, { name: 'Ewa Kot', acronym: '' }, ewa, at)).toMatchObject({ ops: [{ patch: { acronym: null } }] });
    const created = collaboratorSaveOps(USER, [], { name: 'Ola', acronym: 'OL', active: false }, undefined, at);
    expect(created.ok && created.ops[0]!.patch).toMatchObject({ acronym: 'OL', archived_at: at });
    expect(created.ok && MODEL.collaborators.safeParse({ id: created.id, email: null, acronym: null, archived_at: null, workspace_ids: null, ...created.ops[0]!.patch }).success).toBe(true);
  });

  it('podpowiedzi tylko z aktywnych (także po akronimie); odpowiedzialny: aktywni + obecny', () => {
    expect(collaboratorMatches(all, '').map((c) => c.name)).toEqual(['Anna Nowak', 'Łukasz']);
    expect(collaboratorMatches(all, 'ewa')).toEqual([]);
    expect(collaboratorMatches([{ ...ewa, archivedAt: null }], 'ek2').map((c) => c.name)).toEqual(['Ewa Kot']);
    expect(assigneeChoices(all, null).map((c) => c.name)).toEqual(['Anna Nowak', 'Łukasz']);
    expect(assigneeChoices(all, ewa.id).map((c) => c.name)).toEqual(['Anna Nowak', 'Ewa Kot', 'Łukasz']);
    expect(collaboratorsByStatus(all).map((c) => c.name)).toEqual(['Anna Nowak', 'Łukasz', 'Ewa Kot']);
  });
});

describe('przestrzenie', () => {
  const WORK = '01900000-0000-7000-8000-0000000000a1';
  const HOME = '01900000-0000-7000-8000-0000000000a2';
  const piotr: Collaborator = { id: collaboratorId(USER, 'Piotr'), name: 'Piotr', email: null, workspaceIds: [WORK] };
  const all = [...people, piotr];

  it('brak listy = wszędzie; lista = tylko te przestrzenie; bez przestrzeni (widoki zbiorcze) = wszyscy', () => {
    expect(collaboratorVisibleIn(anna, HOME)).toBe(true);
    expect(collaboratorVisibleIn({ workspaceIds: [] }, HOME)).toBe(true);
    expect(collaboratorVisibleIn(piotr, WORK)).toBe(true);
    expect(collaboratorVisibleIn(piotr, HOME)).toBe(false);
    expect(collaboratorVisibleIn(piotr, null)).toBe(true);
    expect(collaboratorsForWorkspace(all, HOME).map((c) => c.name)).toEqual(['Łukasz', 'Anna Nowak']);
    // Już przy zadaniu / zaznaczony w filtrze zostaje.
    expect(collaboratorsForWorkspace(all, HOME, [null, piotr.id]).map((c) => c.name)).toEqual(['Łukasz', 'Anna Nowak', 'Piotr']);
  });

  it('zapis: lista bez powtórzeń, pusta = wszystkie (`null`), zmiana tylko przy różnicy', () => {
    expect(collaboratorSaveOps(USER, all, { name: 'Piotr', workspaceIds: [WORK, WORK] }, piotr)).toMatchObject({ ops: [] });
    expect(collaboratorSaveOps(USER, all, { name: 'Piotr', workspaceIds: [] }, piotr)).toMatchObject({ ops: [{ patch: { workspace_ids: null } }] });
    expect(collaboratorSaveOps(USER, all, { name: 'Piotr', workspaceIds: [HOME, WORK] }, piotr)).toMatchObject({ ops: [{ patch: { workspace_ids: [HOME, WORK] } }] });
    expect(collaboratorSaveOps(USER, all, { name: 'Piotr' }, piotr)).toMatchObject({ ops: [] });
    expect(collaboratorSaveOps(USER, all, { name: 'Anna Nowak', email: anna.email, workspaceIds: [] }, anna)).toMatchObject({ ops: [] });
    const created = collaboratorSaveOps(USER, [], { name: 'Ola', workspaceIds: [HOME] });
    expect(created.ok && created.ops[0]!.patch).toMatchObject({ workspace_ids: [HOME] });
    // Nowa osoba wpisana w zadaniu dostaje przestrzeń zadania; istniejąca zostaje bez zmian.
    const typed = addParticipantByNameOps(USER, all, TASK, 'Ola', HOME);
    expect(typed.ok && typed.ops[0]!.patch).toMatchObject({ name: 'Ola', workspace_ids: [HOME] });
    expect(addParticipantByNameOps(USER, all, TASK, 'Piotr', HOME)).toMatchObject({ created: false, ops: [{ table: 'task_participants' }] });
    const all_ = collaboratorSaveOps(USER, [], { name: 'Ola', workspaceIds: [] });
    expect(all_.ok && 'workspace_ids' in all_.ops[0]!.patch).toBe(false);
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
