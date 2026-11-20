"use client";

/**
 * Ustawienia → „Współpracownicy”: książka adresowa osób, które można wskazać jako odpowiedzialne
 * i uczestników zadań (tylko informacyjnie — nikt nie dostaje dostępu). Usunięcie osoby zabiera ją
 * z uczestników, a zadania, za które odpowiadała, wracają do twórcy (z cofnięciem).
 */
import { collaboratorSaveOps, deleteCollaboratorOps, plural, type Collaborator } from "@taskplanner/core";
import { useState, type FormEvent } from "react";

import { useLocalQuery } from "@/lib/local-store";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { Button, Card, Input, Notice } from "./ui";

type Row = Record<string, string | number | null>;

export function CollaboratorsCard() {
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
  const [draft, setDraft] = useState({ name: "", email: "" });
  const [editing, setEditing] = useState<{ id: string; name: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const result = collaboratorSaveOps(userId, data.collaborators, draft);
    if (!result.ok) return setError(result.error);
    setError(null);
    setDraft({ name: "", email: "" });
    void run(result.ops);
  };
  const save = (event: FormEvent, person: Collaborator) => {
    event.preventDefault();
    if (!editing) return;
    const result = collaboratorSaveOps(userId, data.collaborators, editing, person);
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
    void run(ops, { text: `Usunięto współpracownika „${person.name}”`, undo });
  };

  return (
    <Card className="mt-4">
      <h2 className="mb-1 text-sm font-semibold">Współpracownicy</h2>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Osoby do wskazania jako odpowiedzialne i uczestnicy zadań. Tylko informacyjnie — nie dostają dostępu do zadań ani powiadomień.
      </p>

      {data.collaborators.length ? (
        <ul className="mb-3 divide-y divide-[var(--line)] text-sm" aria-label="Współpracownicy">
          {data.collaborators.map((person) => {
            const count = counts.get(person.id);
            return (
              <li key={person.id} className="py-2">
                {editing?.id === person.id ? (
                  <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => save(e, person)}>
                    <Input autoFocus aria-label="Nazwa" value={editing.name} maxLength={100} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="min-w-0 flex-1" />
                    <Input aria-label="E-mail" type="email" value={editing.email} maxLength={254} placeholder="e-mail (opcjonalnie)" onChange={(e) => setEditing({ ...editing, email: e.target.value })} className="min-w-0 flex-1" />
                    <Button type="submit">Zapisz</Button>
                    <Button kind="ghost" onClick={() => setEditing(null)}>
                      Anuluj
                    </Button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{person.name}</span>
                    {person.email ? (
                      <a href={`mailto:${person.email}`} className="text-xs text-[var(--accent)] hover:underline">
                        {person.email}
                      </a>
                    ) : null}
                    <span className="text-xs text-[var(--muted)]">
                      {[count?.assigned ? `odpowiada za ${plural(count.assigned, ["zadanie", "zadania", "zadań"])}` : null, count?.participating ? `uczestnik ${plural(count.participating, ["zadania", "zadań", "zadań"])}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button kind="ghost" onClick={() => setEditing({ id: person.id, name: person.name, email: person.email ?? "" })}>
                        Edytuj
                      </Button>
                      <Button kind="ghost" onClick={() => void remove(person)}>
                        Usuń
                      </Button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-[var(--muted)]">Brak współpracowników — dodaj osobę tutaj albo wpisz nazwę w polu „+ osoba” w zadaniu.</p>
      )}

      <form className="flex flex-wrap items-center gap-2" onSubmit={add}>
        <Input aria-label="Nazwa nowego współpracownika" value={draft.name} maxLength={100} placeholder="Imię i nazwisko" onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="min-w-0 flex-1" />
        <Input aria-label="E-mail nowego współpracownika" type="email" value={draft.email} maxLength={254} placeholder="e-mail (opcjonalnie)" onChange={(e) => setDraft({ ...draft, email: e.target.value })} className="min-w-0 flex-1" />
        <Button type="submit" disabled={!draft.name.trim()}>
          Dodaj
        </Button>
      </form>
      {error ? (
        <div className="mt-2">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </Card>
  );
}
