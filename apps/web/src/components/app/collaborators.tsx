"use client";

/**
 * Widok „Współpracownicy” (`#/people`, link w pasku bocznym): książka adresowa osób, które można
 * wskazać jako odpowiedzialne i uczestników zadań (tylko informacyjnie — nikt nie dostaje dostępu).
 * Kliknięcie osoby otwiera edycję: nazwa, e-mail, akronim (znaczek przy zadaniu) i status — tylko
 * aktywni podpowiadają się przy zadaniach — oraz przestrzenie, w których osoba się podpowiada (jak
 * przy tagach; żadna = wszystkie). Usunięcie zabiera osobę z uczestników, a zadania, za które
 * odpowiadała, wracają do twórcy (z cofnięciem).
 */
import { collaboratorBadge, collaboratorSaveOps, collaboratorsByStatus, deleteCollaboratorOps, initials, isActiveCollaborator, plural, type Collaborator } from "@taskplanner/core";
import { useState, type FormEvent } from "react";

import type { AppData } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";

import { useAppEnv } from "./app-env";
import { WorkspaceChips } from "./filter-views";
import { useTaskActions } from "./task-item";
import { Button, Card, Field, Input, Notice, Select } from "./ui";

type Row = Record<string, string | number | null>;

interface Draft {
  name: string;
  email: string;
  acronym: string;
  active: boolean;
  workspaceIds: string[];
}

const EMPTY: Draft = { name: "", email: "", acronym: "", active: true, workspaceIds: [] };
const draftOf = (person: Collaborator): Draft => ({ name: person.name, email: person.email ?? "", acronym: person.acronym ?? "", active: isActiveCollaborator(person), workspaceIds: [...(person.workspaceIds ?? [])] });

export function CollaboratorsView() {
  const { store, data, userId } = useAppEnv();
  const { run } = useTaskActions();
  const usage = useLocalQuery<Row>(
    store,
    `select c.id,
            (select count(*) from tasks t where t.assignee_id = c.id and t.deleted_at is null) as assigned,
            (select count(*) from task_participants p join tasks t on t.id = p.task_id
              where p.collaborator_id = c.id and p.deleted_at is null and t.deleted_at is null) as participating
       from collaborators c where c.deleted_at is null`,
    [],
    ["collaborators", "tasks", "task_participants"],
  );
  const counts = new Map(usage.rows.map((r) => [String(r.id), { assigned: Number(r.assigned), participating: Number(r.participating) }]));
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const people = collaboratorsByStatus(data.collaborators);
  const inactive = people.filter((c) => !isActiveCollaborator(c)).length;

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!adding) return;
    const result = collaboratorSaveOps(userId, data.collaborators, adding);
    if (!result.ok) return setError(result.error);
    setError(null);
    setAdding(null);
    void run(result.ops, { text: `Dodano „${adding.name.trim()}”` });
  };
  const save = (event: FormEvent, person: Collaborator) => {
    event.preventDefault();
    if (!editing) return;
    const result = collaboratorSaveOps(userId, data.collaborators, editing.draft, person);
    if (!result.ok) return setError(result.error);
    setError(null);
    setEditing(null);
    if (result.ops.length) void run(result.ops);
  };
  const remove = async (person: Collaborator) => {
    const [assigned, participants] = await Promise.all([
      store.query<{ id: string }>("select id from tasks where assignee_id = ?", [person.id]),
      store.query<{ id: string }>("select id from task_participants where collaborator_id = ? and deleted_at is null", [person.id]),
    ]);
    const { ops, undo } = deleteCollaboratorOps(person, { assignedTaskIds: assigned.map((r) => r.id), participantRowIds: participants.map((r) => r.id) }, new Date());
    setEditing(null);
    void run(ops, { text: `Usunięto współpracownika „${person.name}”`, undo });
  };
  const open = (person: Collaborator) => {
    setError(null);
    setAdding(null);
    setEditing({ id: person.id, draft: draftOf(person) });
  };

  return (
    <>
      <header className="mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Współpracownicy</h1>
          <p className="text-sm text-[var(--muted)]">
            Osoby do wskazania jako odpowiedzialne i uczestnicy zadań. Tylko informacyjnie — nie dostają dostępu do zadań ani powiadomień.
            {inactive ? ` Nieaktywni (${inactive}) nie podpowiadają się przy zadaniach.` : ""}
          </p>
        </div>
        {adding ? null : (
          <Button
            kind="primary"
            onClick={() => {
              setError(null);
              setEditing(null);
              setAdding(EMPTY);
            }}
          >
            + Nowa osoba
          </Button>
        )}
      </header>

      {adding ? (
        <Card className="mb-3">
          <form onSubmit={add} aria-label="Nowy współpracownik">
            <PersonFields draft={adding} onChange={setAdding} workspaces={data.workspaces} autoFocus />
            <div className="mt-3 flex gap-2">
              <Button type="submit" kind="primary" disabled={!adding.name.trim()}>
                Dodaj
              </Button>
              <Button kind="ghost" onClick={() => setAdding(null)}>
                Anuluj
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      {error ? (
        <div className="mb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      {people.length ? (
        <ul className="divide-y divide-[var(--line)] text-sm" aria-label="Współpracownicy">
          {people.map((person) => {
            const count = counts.get(person.id);
            const active = isActiveCollaborator(person);
            const spaces = (person.workspaceIds ?? []).map((id) => data.workspaces.find((w) => w.id === id)?.name).filter(Boolean);
            const usageText = [
              count?.assigned ? `odpowiada za ${plural(count.assigned, ["zadanie", "zadania", "zadań"])}` : null,
              count?.participating ? `uczestnik ${plural(count.participating, ["zadania", "zadań", "zadań"])}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={person.id} className="py-2">
                {editing?.id === person.id ? (
                  <Card>
                    <form onSubmit={(e) => save(e, person)} aria-label={`Edycja: ${person.name}`}>
                      <PersonFields draft={editing.draft} onChange={(draft) => setEditing({ id: person.id, draft })} workspaces={data.workspaces} autoFocus />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button type="submit" kind="primary">
                          Zapisz
                        </Button>
                        <Button kind="ghost" onClick={() => setEditing(null)}>
                          Anuluj
                        </Button>
                        <span className="flex-1" />
                        <Button kind="danger" onClick={() => void remove(person)}>
                          Usuń
                        </Button>
                      </div>
                      {usageText ? <p className="mt-2 text-xs text-[var(--muted)]">{usageText}</p> : null}
                    </form>
                  </Card>
                ) : (
                  <button type="button" onClick={() => open(person)} className={`flex w-full items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-[var(--hover)] ${active ? "" : "opacity-60"}`}>
                    <span aria-hidden className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-sky-100 px-1.5 text-[11px] font-semibold text-sky-900 dark:bg-sky-900/50 dark:text-sky-100">
                      {collaboratorBadge(person)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {person.name}
                        {active ? null : <span className="ml-2 rounded bg-[var(--hover)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--muted)]">nieaktywny</span>}
                      </span>
                      <span className="block text-xs text-[var(--muted)]">{[person.email, usageText, spaces.length ? `tylko: ${spaces.join(", ")}` : null].filter(Boolean).join(" · ") || " "}</span>
                    </span>
                    <span className="text-xs text-[var(--muted)]">Edytuj</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-6 text-sm text-[var(--muted)]">Brak współpracowników — dodaj osobę przyciskiem „+ Nowa osoba” albo wpisz nazwę w polu „+ osoba” w zadaniu.</p>
      )}
    </>
  );
}

function PersonFields({ draft, onChange, workspaces, autoFocus }: { draft: Draft; onChange: (draft: Draft) => void; workspaces: AppData["workspaces"]; autoFocus?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Nazwa">
        <Input autoFocus={autoFocus} value={draft.name} maxLength={100} placeholder="Imię i nazwisko" onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="E-mail" hint="Opcjonalnie.">
        <Input type="email" value={draft.email} maxLength={254} placeholder="adres@example.com" onChange={(e) => onChange({ ...draft, email: e.target.value })} />
      </Field>
      <Field label="Akronim" hint="Znaczek przy zadaniu, do 5 znaków. Puste = inicjały z nazwy.">
        <Input value={draft.acronym} maxLength={5} placeholder={draft.name.trim() ? initials(draft.name) : "np. AN"} onChange={(e) => onChange({ ...draft, acronym: e.target.value })} />
      </Field>
      <Field label="Status" hint="Nieaktywni zostają przy swoich zadaniach, ale nie podpowiadają się przy nowych.">
        <Select value={draft.active ? "active" : "inactive"} onChange={(e) => onChange({ ...draft, active: e.target.value === "active" })}>
          <option value="active">Aktywny</option>
          <option value="inactive">Nieaktywny</option>
        </Select>
      </Field>
      {workspaces.length > 1 ? (
        // Nie `Field` (label): kliknięcie podpisu wcisnęłoby pierwszy przycisk. Podpis „Widoczny w:” dają chipy.
        <div className="flex flex-col gap-1 text-sm sm:col-span-2">
          <WorkspaceChips ids={draft.workspaceIds} workspaces={workspaces} label="Przestrzenie współpracownika" onChange={(workspaceIds) => onChange({ ...draft, workspaceIds })} />
          <span className="text-xs opacity-60">Przestrzenie, w których osoba podpowiada się przy zadaniach i w filtrze „Odpowiedzialny”. Żadna = wszystkie.</span>
        </div>
      ) : null}
    </div>
  );
}
