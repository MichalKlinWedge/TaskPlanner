"use client";

/**
 * Widok „Współpracownicy” (`#/people`, link w pasku bocznym): książka adresowa osób, które można
 * wskazać jako odpowiedzialne i uczestników zadań (tylko informacyjnie — nikt nie dostaje dostępu).
 * Kliknięcie osoby otwiera edycję: nazwa, e-mail, akronim i kolor (znaczek przy zadaniu) i status — tylko
 * aktywni podpowiadają się przy zadaniach — oraz przestrzenie, w których osoba się podpowiada (jak
 * przy tagach; żadna = wszystkie). Usunięcie zabiera osobę z uczestników, a zadania, za które
 * odpowiadała, wracają do twórcy (z cofnięciem).
 *
 * Niżej, tylko do odczytu: konta i zaproszenia z udostępnionych przestrzeni (`workspace_sharing`,
 * wymaga sieci; „+ Dodaj” zakłada z nich własnego współpracownika) oraz osoby wpisane przez
 * innych członków (`scope_collaborators`, `shared`). „Przejmij” robi z takiej osoby własny wpis (albo
 * łączy z własnym o tej nazwie) i przepina na niego zadania przestrzeni — np. osoby po poprzednim
 * właścicielu, których nikt już nie może zmienić.
 */
import { canEditScope, collaboratorBadge, collaboratorSaveOps, takeOverCollaboratorOps, takeOverTarget, collaboratorsByStatus, ownCollaborators, deleteCollaboratorOps, initials, isActiveCollaborator, nameFromEmail, memberSince, plural, SCOPE_ROLE, spacePeople, type Collaborator, type SpaceSharing } from "@taskplanner/core";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { readTakeOverUsage } from "@taskplanner/sync";

import { listEditable, type AppData } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";
import { workspaceSharing } from "@/lib/sharing";

import { useAppEnv } from "./app-env";
import { WorkspaceChips } from "./filter-views";
import { personBadgeStyle } from "./people-badges";
import { TagColorPicker } from "./tag-chip";
import { useTaskActions } from "./task-item";
import { Button, Card, Field, Input, Notice, Select } from "./ui";

type Row = Record<string, string | number | null>;

interface Draft {
  name: string;
  email: string;
  acronym: string;
  color: string | null;
  active: boolean;
  workspaceIds: string[];
}

const EMPTY: Draft = { name: "", email: "", acronym: "", color: null, active: true, workspaceIds: [] };
const draftOf = (person: Collaborator): Draft => ({ name: person.name, email: person.email ?? "", acronym: person.acronym ?? "", color: person.color ?? null, active: isActiveCollaborator(person), workspaceIds: [...(person.workspaceIds ?? [])] });

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
  const people = collaboratorsByStatus(ownCollaborators(data.collaborators));
  const inactive = people.filter((c) => !isActiveCollaborator(c)).length;
  const shared = collaboratorsByStatus(data.collaborators.filter((c) => c.shared));
  const spaces = useSpaceSharing(data.workspaces);
  const accounts = useMemo(() => (spaces.list ? spacePeople(spaces.list, data.collaborators) : []), [spaces.list, data.collaborators]);
  const workspaceName = (id: string) => data.workspaces.find((w) => w.id === id)?.name;

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
  /** Przestrzenie osoby z kopii, w których można edytować (tam ją się przejmuje). */
  const takeOverSpaces = (person: Collaborator) => (person.workspaceIds ?? []).filter((id) => canEditScope(data.workspaces.find((w) => w.id === id)?.role));
  const takeOver = async (person: Collaborator) => {
    const spaces = takeOverSpaces(person);
    const target = takeOverTarget(data.collaborators, person);
    const usage = await readTakeOverUsage(store.query, person.id, target?.id ?? null, spaces, (listId) => listEditable(data, listId));
    const result = takeOverCollaboratorOps(userId, data.collaborators, person, spaces, usage);
    if (!result.ok) return setError(result.error);
    setError(null);
    const moved = usage.assignedTaskIds.length + usage.participations.length;
    void run(result.ops, { text: `${result.created ? `Przejęto „${person.name}”` : `Połączono „${person.name}” z Twoim wpisem`}${moved ? ` · ${plural(moved, ["zadanie", "zadania", "zadań"])}` : ""}`, undo: result.undo });
  };
  const open = (person: Collaborator) => {
    setError(null);
    setAdding(null);
    setEditing({ id: person.id, draft: draftOf(person) });
  };

  return (
    <>
      <header className="tp-view-header mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
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
                  <button type="button" onClick={() => open(person)} className={`flex w-full items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-[var(--hover)]`}>
                    <span aria-hidden style={personBadgeStyle(person, true)} className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-sky-100 px-1.5 text-[11px] font-semibold text-sky-900 dark:bg-sky-900/50 dark:text-sky-100">
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

      {accounts.length || spaces.error ? (
        <section className="mt-6" aria-label="Osoby w udostępnionych przestrzeniach">
          <h2 className="border-b border-[var(--line)] pb-1 text-sm font-semibold">Osoby w udostępnionych przestrzeniach</h2>
          {spaces.error ? <p className="py-2 text-xs text-[var(--muted)]">{spaces.error}</p> : null}
          <ul className="divide-y divide-[var(--line)] text-sm" data-testid="space-people">
            {accounts.map((person) => (
              <li key={person.email} className="flex items-center gap-3 px-1 py-2">
                <span aria-hidden className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 px-1.5 text-[11px] font-semibold text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100">
                  {initials(nameFromEmail(person.email) || person.email)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{person.email}</span>
                  <span className="block text-xs text-[var(--muted)]">
                    {person.spaces.map((s) => `${s.workspace} — ${s.pending ? `zaproszenie (${SCOPE_ROLE[s.role].toLowerCase()})` : [SCOPE_ROLE[s.role].toLowerCase(), memberSince(s.joinedAt)].filter(Boolean).join(", ")}`).join(" · ")}
                  </span>
                </span>
                {person.collaboratorId ? (
                  <span className="text-xs text-[var(--muted)]">na Twojej liście</span>
                ) : (
                  <Button
                    kind="ghost"
                    title="Załóż współpracownika z tym adresem — będzie go można wskazać w zadaniach"
                    onClick={() => {
                      setError(null);
                      setEditing(null);
                      setAdding({ ...EMPTY, name: nameFromEmail(person.email), email: person.email, workspaceIds: person.spaces.map((s) => s.workspaceId) });
                      window.scrollTo({ top: 0 });
                    }}
                  >
                    + Dodaj
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {shared.length ? (
        <section className="mt-6" aria-label="Wpisani przez innych członków przestrzeni">
          <h2 className="border-b border-[var(--line)] pb-1 text-sm font-semibold">Wpisani przez innych członków przestrzeni</h2>
          <p className="pt-1 text-xs text-[var(--muted)]">
            Można ich wskazać w zadaniach tych przestrzeni; zmienia ich osoba, która ich wpisała. „Przejmij” zakłada z osoby Twój wpis (albo łączy ją z Twoim o tej samej nazwie) i przepina na niego zadania przestrzeni.
          </p>
          <ul className="divide-y divide-[var(--line)] text-sm" data-testid="shared-collaborators">
            {shared.map((person) => (
              <li key={person.id} className="flex items-center gap-3 px-1 py-2">
                <span aria-hidden style={personBadgeStyle(person, true)} className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-sky-100 px-1.5 text-[11px] font-semibold text-sky-900 dark:bg-sky-900/50 dark:text-sky-100">
                  {collaboratorBadge(person)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {person.name}
                    {isActiveCollaborator(person) ? null : <span className="ml-2 rounded bg-[var(--hover)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--muted)]">nieaktywny</span>}
                  </span>
                  <span className="block text-xs text-[var(--muted)]">{(person.workspaceIds ?? []).map(workspaceName).filter(Boolean).join(", ")}</span>
                </span>
                {takeOverSpaces(person).length ? (
                  <Button
                    kind="ghost"
                    title={takeOverTarget(data.collaborators, person) ? "Połącz z Twoim wpisem o tej nazwie i przepnij na niego zadania przestrzeni" : "Załóż z tej osoby Twój wpis (nazwa, akronim, kolor) i przepnij na niego zadania przestrzeni"}
                    onClick={() => void takeOver(person)}
                  >
                    {takeOverTarget(data.collaborators, person) ? "Połącz z moim" : "Przejmij"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/**
 * Członkowie i zaproszenia przestrzeni udostępnionych albo własnych (czekające zaproszenia widzi
 * tylko właściciel). Z serwera — bez sieci komunikat zamiast listy.
 */
function useSpaceSharing(workspaces: AppData["workspaces"]): { list: SpaceSharing[] | null; error: string | null } {
  const targets = workspaces.filter((w) => w.role === "owner" || (w.members ?? 1) > 1).map((w) => ({ id: w.id, name: w.name, members: w.members ?? 1 }));
  const key = JSON.stringify(targets);
  const [state, setState] = useState<{ key: string; list: SpaceSharing[] | null; error: string | null }>({ key: "", list: null, error: null });
  useEffect(() => {
    const list: { id: string; name: string }[] = JSON.parse(key);
    if (!list.length) return;
    let cancelled = false;
    Promise.all(list.map(async (w): Promise<SpaceSharing> => ({ workspaceId: w.id, workspace: w.name, ...(await workspaceSharing(w.id)) })))
      .then((result) => !cancelled && setState({ key, list: result, error: null }))
      .catch(() => !cancelled && setState({ key, list: null, error: "Osoby z udostępnionych przestrzeni widać tylko z połączeniem z serwerem." }));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state.key === key ? state : { list: null, error: null };
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
      <div className="flex flex-col gap-1 text-sm">
        <span>Kolor znaczka</span>
        <div className="flex items-center gap-2">
          <span aria-hidden style={personBadgeStyle(draft, true)} className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-sky-100 px-1 text-[10px] font-semibold text-sky-900 dark:bg-sky-900/60 dark:text-sky-100" data-testid="collaborator-color-preview">
            {draft.acronym.trim() || (draft.name.trim() ? initials(draft.name) : "AN")}
          </span>
          <TagColorPicker value={draft.color} onChange={(color) => onChange({ ...draft, color })} label="Kolor znaczka współpracownika" />
        </div>
        <span className="text-xs text-[var(--muted)]">Odróżnia osoby przy zadaniach; widzą go też pozostali członkowie udostępnionych przestrzeni. Brak = domyślny.</span>
      </div>
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
          <span className="text-xs text-[var(--muted)]">Przestrzenie, w których osoba podpowiada się przy zadaniach i w filtrze „Odpowiedzialny”. Żadna = wszystkie.</span>
        </div>
      ) : null}
    </div>
  );
}
