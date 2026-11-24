"use client";

import { canEditScope, COLORS, GUEST_ACCESS, GUEST_ACCESS_HINT, inboxId, keyBetween, LIST_KIND, listAccess, listKindPatch, plural, reorderPatches, SCOPE_ROLE, TRASH_DAYS, uuidv7, type GuestAccess, type ListKind, type ProjectStatus, type ScopeRole } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useState, type FormEvent } from "react";

import { useLocalQuery } from "@/lib/local-store";

import { ProjectStatusSelect } from "./project-status";
import { SharingPanel } from "./sharing";
import { TemplatePicker, TemplatesCard, useCreateFromTemplate, useProjectTemplates, type TemplateChoice } from "./templates";
import { Button, Card, IconButton, Input, Notice, Select } from "./ui";

interface WorkspaceRow extends Record<string, string | number | null> {
  id: string;
  name: string;
  color: string | null;
  sort_key: string;
  archived_at: string | null;
  /** Rola z ostatniej synchronizacji (`_scopes`); `null` = jeszcze nieznana (jak właściciel). */
  role: ScopeRole | null;
}

interface ListRow extends Record<string, string | number | null> {
  id: string;
  scope_id: string;
  kind: ListKind;
  name: string;
  color: string | null;
  sort_key: string;
  archived_at: string | null;
  /** Dostęp gości (`lists.guest_access`); `null` = lista jeszcze niezsynchronizowana (domyślnie `edit`). */
  guest_access: GuestAccess | null;
  project_status: ProjectStatus | null;
  start_date: string | null;
  end_date: string | null;
  open: number;
  /** Wszystkie nieusunięte zadania (lista z zadaniami nie znika, tylko się archiwizuje). */
  total: number;
  /** Zadania w koszu — po usunięciu listy nie ma dokąd ich przywrócić. */
  trashed: number;
}

type NewListKind = Exclude<ListKind, "inbox">;

const byKey = <T extends { sort_key: string; id: string }>(a: T, b: T) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id < b.id ? -1 : 1);

/** Przestrzenie i listy (MVP-1): tworzenie, nazwa, kolor, kolejność, archiwizacja; osoby i udostępnianie (v1.x). */
export function WorkspacesScreen({ store }: { store: TabStore }) {
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { rows: workspaces } = useLocalQuery<WorkspaceRow>(
    store,
    "select w.id, w.name, w.color, w.sort_key, w.archived_at, s.role from workspaces w left join _scopes s on s.id = w.id where w.deleted_at is null",
    [],
    ["workspaces"],
  );
  // Granica kosza liczona przy wejściu (stabilna wartość parametru zapytania).
  const [trashSince] = useState(() => new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString());
  const { rows: lists } = useLocalQuery<ListRow>(
    store,
    `select l.id, l.scope_id, l.kind, l.name, l.color, l.sort_key, l.archived_at, l.guest_access, l.project_status, l.start_date, l.end_date,
            coalesce(c.open, 0) as open, coalesce(c.total, 0) as total, coalesce(c.trashed, 0) as trashed
       from lists l left join (
         select list_id, sum(deleted_at is null and status not in ('done', 'cancelled')) as open, sum(deleted_at is null) as total, sum(deleted_at > ?) as trashed
           from tasks group by list_id) c on c.list_id = l.id
      where l.deleted_at is null`,
    [trashSince],
    ["lists", "tasks"],
  );

  const run = async (work: () => Promise<void>) => {
    try {
      setError(null);
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const visible = workspaces.filter((w) => showArchived || !w.archived_at).sort(byKey);
  const activeWorkspaces = workspaces.filter((w) => !w.archived_at).sort(byKey);

  const moveWorkspace = (index: number, delta: number) =>
    run(async () => {
      const from = activeWorkspaces.findIndex((w) => w.id === visible[index]!.id);
      for (const patch of reorderPatches(activeWorkspaces, from, from + delta)) await store.mutate("workspaces", patch.id, { sort_key: patch.sort_key });
    });

  const addWorkspace = (name: string) =>
    run(async () => {
      const id = uuidv7();
      const last = activeWorkspaces.at(-1)?.sort_key;
      await store.mutate("workspaces", id, { name, color: COLORS[workspaces.length % COLORS.length]!.value, sort_key: keyBetween(last) });
      await store.mutate("lists", inboxId(id), { scope_id: id, kind: "inbox", name: "Inbox", sort_key: "a" });
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Przestrzenie i listy</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Pokaż zarchiwizowane
        </label>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {visible.map((workspace, index) => (
        <WorkspaceCard
          key={workspace.id}
          store={store}
          workspace={workspace}
          lists={lists.filter((l) => l.scope_id === workspace.id)}
          showArchived={showArchived}
          canUp={!workspace.archived_at && index > 0}
          canDown={!workspace.archived_at && index < activeWorkspaces.length - 1}
          onMove={(delta) => void moveWorkspace(index, delta)}
          run={run}
        />
      ))}
      <AddForm placeholder="Nowa przestrzeń, np. „Remont”" button="Dodaj przestrzeń" onAdd={(name) => void addWorkspace(name)} />
      <TemplatesCard store={store} />
    </div>
  );
}

function WorkspaceCard({
  store,
  workspace,
  lists,
  showArchived,
  canUp,
  canDown,
  onMove,
  run,
}: {
  store: TabStore;
  workspace: WorkspaceRow;
  lists: ListRow[];
  showArchived: boolean;
  canUp: boolean;
  canDown: boolean;
  onMove: (delta: number) => void;
  run: (work: () => Promise<void>) => Promise<void>;
}) {
  const archived = Boolean(workspace.archived_at);
  const [people, setPeople] = useState(false);
  // Podgląd tylko czyta; archiwizacja zmienia przestrzeń wszystkim członkom — tylko właściciel.
  const editable = canEditScope(workspace.role);
  const owner = workspace.role === null || workspace.role === "owner";
  // Inbox zawsze pierwszy i bez przesuwania; pozostałe po kluczu kolejności.
  const inbox = lists.find((l) => l.kind === "inbox");
  const others = lists.filter((l) => l.kind !== "inbox" && (showArchived || !l.archived_at)).sort(byKey);
  const activeOthers = lists.filter((l) => l.kind !== "inbox" && !l.archived_at).sort(byKey);

  const update = (patch: Record<string, unknown>) => run(() => store.mutate("workspaces", workspace.id, patch));

  const moveList = (list: ListRow, delta: number) =>
    run(async () => {
      const from = activeOthers.findIndex((l) => l.id === list.id);
      for (const patch of reorderPatches(activeOthers, from, from + delta)) await store.mutate("lists", patch.id, { sort_key: patch.sort_key });
    });

  const createFromTemplate = useCreateFromTemplate();
  const addList = (name: string, kind: NewListKind, color: string | null, template: TemplateChoice | null) =>
    run(() =>
      kind === "project" && template
        ? // Kolor wybrany przy dodawaniu zastępuje kolor z szablonu.
          store.mutateMany(
            createFromTemplate(template, workspace.id, name, activeOthers.at(-1)?.sort_key).ops.map((op) => (color && op.table === "lists" ? { ...op, patch: { ...op.patch, color } } : op)),
          )
        : store.mutate("lists", uuidv7(), {
            scope_id: workspace.id,
            kind,
            name,
            color,
            project_status: kind === "project" ? "active" : null,
            sort_key: keyBetween(activeOthers.at(-1)?.sort_key ?? "a"),
          }),
    );

  return (
    <Card className={archived ? "opacity-60" : ""}>
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <>
            <ColorPicker value={workspace.color} onChange={(color) => void update({ color })} label={`Kolor przestrzeni ${workspace.name}`} />
            <EditableName value={workspace.name} max={100} onSave={(name) => void update({ name })} className="text-base font-semibold" />
          </>
        ) : (
          <>
            <span className="h-4 w-4 rounded-full border border-[var(--line)]" style={{ background: workspace.color ?? "transparent" }} />
            <span className="px-1 text-base font-semibold">{workspace.name}</span>
          </>
        )}
        {archived ? <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs">zarchiwizowana</span> : null}
        {!owner && workspace.role ? (
          <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs" title="Przestrzeń udostępniona Ci przez innego użytkownika">
            udostępniona · {SCOPE_ROLE[workspace.role].toLowerCase()}
          </span>
        ) : null}
        <span className="flex-1" />
        {editable ? (
          <>
            <IconButton label="W górę" disabled={!canUp} onClick={() => onMove(-1)}>
              ↑
            </IconButton>
            <IconButton label="W dół" disabled={!canDown} onClick={() => onMove(1)}>
              ↓
            </IconButton>
          </>
        ) : null}
        <Button kind="ghost" aria-expanded={people} onClick={() => setPeople((p) => !p)}>
          {owner ? "Udostępnij" : "Osoby"}
        </Button>
        {owner ? (
          <Button kind="ghost" onClick={() => void update({ archived_at: archived ? null : new Date().toISOString() })}>
            {archived ? "Przywróć" : "Archiwizuj"}
          </Button>
        ) : null}
      </div>
      {people ? (
        <SharingPanel
          store={store}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          lists={owner ? [...(inbox ? [inbox] : []), ...activeOthers].map((l) => ({ id: l.id, name: l.name, guestAccess: l.guest_access ?? "edit" })) : undefined}
        />
      ) : null}
      <ul className="mt-3 flex flex-col divide-y divide-[var(--line)] border-t border-[var(--line)]">
        {inbox ? <ListItem store={store} list={inbox} run={run} editable={editable} role={workspace.role} /> : null}
        {others.map((list, index) => (
          <ListItem
            key={list.id}
            store={store}
            list={list}
            run={run}
            editable={editable}
            role={workspace.role}
            canUp={!list.archived_at && index > 0}
            canDown={!list.archived_at && index < activeOthers.length - 1}
            onMove={(delta) => void moveList(list, delta)}
          />
        ))}
      </ul>
      {!archived && editable ? <AddListForm store={store} onAdd={(name, kind, color, template) => void addList(name, kind, color, template)} /> : null}
    </Card>
  );
}

function ListItem({
  store,
  list,
  run,
  editable: scopeEditable,
  role,
  canUp,
  canDown,
  onMove,
}: {
  store: TabStore;
  list: ListRow;
  run: (work: () => Promise<void>) => Promise<void>;
  editable: boolean;
  role: ScopeRole | null;
  canUp?: boolean;
  canDown?: boolean;
  onMove?: (delta: number) => void;
}) {
  const update = (patch: Record<string, unknown>) => run(() => store.mutate("lists", list.id, patch));
  const archived = Boolean(list.archived_at);
  const inbox = list.kind === "inbox";
  const owner = role === null || role === "owner";
  const guestAccess = list.guest_access ?? "edit";
  // Gość: lista tylko do podglądu blokuje też nazwę, kolor, kolejność i archiwizację.
  const editable = scopeEditable && listAccess(role, guestAccess) === "edit";
  const changeKind = (kind: NewListKind) => {
    if (kind === "list" && (list.start_date || list.end_date) && !window.confirm(`Zmienić projekt „${list.name}” w listę? Zniknie jego status oraz data początku i końca.`)) return;
    void update({ ...listKindPatch({ kind: list.kind, projectStatus: list.project_status }, kind) });
  };
  const remove = () => {
    const trashed = Number(list.trashed);
    const note = trashed ? ` ${plural(trashed, ["zadania", "zadań", "zadań"])} z kosza nie będzie już można przywrócić.` : "";
    if (window.confirm(`Usunąć pustą listę „${list.name}”?${note}`)) void update({ deleted_at: new Date().toISOString() });
  };
  return (
    <li data-list={list.id} className={`flex flex-wrap items-center gap-2 py-2 text-sm ${archived ? "opacity-60" : ""}`}>
      {editable ? (
        <ColorPicker value={list.color} onChange={(color) => void update({ color })} label={`Kolor listy ${list.name}`} />
      ) : (
        <span className="h-4 w-4 rounded-full border border-[var(--line)]" style={{ background: list.color ?? "transparent" }} />
      )}
      {inbox || !editable ? <span className="font-medium">{list.name}</span> : <EditableName value={list.name} max={200} onSave={(name) => void update({ name })} />}
      {inbox || !editable ? (
        <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs">{LIST_KIND[list.kind]}</span>
      ) : (
        <Select value={list.kind} onChange={(e) => changeKind(e.target.value as NewListKind)} aria-label={`Rodzaj: ${list.name}`} className="py-0.5 text-xs">
          <option value="list">{LIST_KIND.list}</option>
          <option value="project">{LIST_KIND.project}</option>
        </Select>
      )}
      {list.kind === "project" ? <ProjectStatusSelect name={list.name} value={list.project_status} onChange={editable ? (status) => void update({ project_status: status }) : undefined} /> : null}
      {owner && guestAccess !== "edit" ? (
        <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs" title={GUEST_ACCESS_HINT[guestAccess]} data-testid="list-guest-access">
          dla gości: {GUEST_ACCESS[guestAccess].toLowerCase()}
        </span>
      ) : null}
      {!owner && scopeEditable && !editable ? (
        <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs" title="Właściciel udostępnił Ci tę listę tylko do podglądu">
          tylko podgląd
        </span>
      ) : null}
      {Number(list.open) > 0 ? <span className="text-xs opacity-60">{list.open} otwartych</span> : null}
      <span className="flex-1" />
      {!inbox && editable ? (
        <>
          <IconButton label="W górę" disabled={!canUp} onClick={() => onMove?.(-1)}>
            ↑
          </IconButton>
          <IconButton label="W dół" disabled={!canDown} onClick={() => onMove?.(1)}>
            ↓
          </IconButton>
          <Button kind="ghost" onClick={() => void update({ archived_at: archived ? null : new Date().toISOString() })}>
            {archived ? "Przywróć" : "Archiwizuj"}
          </Button>
          {Number(list.total) === 0 ? (
            <Button kind="ghost" onClick={remove} title="Usuń pustą listę" className="text-[var(--danger)]">
              Usuń
            </Button>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/** Nazwa edytowana w miejscu: kliknięcie → pole, Enter / utrata fokusu zapisuje, Esc anuluje. */
function EditableName({ value, max, onSave, className = "" }: { value: string; max: number; onSave: (name: string) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button type="button" className={`rounded px-1 text-left hover:bg-[var(--hover)] ${className}`} title="Zmień nazwę" onClick={() => setDraft(value)}>
        {value}
      </button>
    );
  }
  const commit = () => {
    const name = draft.trim();
    setDraft(null);
    if (name && name !== value) onSave(name);
  };
  return (
    <Input
      autoFocus
      aria-label="Nazwa"
      value={draft}
      maxLength={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
      className={`max-w-xs ${className}`}
    />
  );
}

function ColorPicker({ value, onChange, label }: { value: string | null; onChange: (color: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="h-4 w-4 rounded-full border border-[var(--line)]"
        style={{ background: value ?? "transparent" }}
      />
      {open ? (
        <span role="listbox" aria-label={label} className="absolute top-6 left-0 z-10 flex w-max gap-1 rounded-md border border-[var(--line)] bg-[var(--surface)] p-2 shadow">
          {COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              role="option"
              aria-selected={color.value.toLowerCase() === value?.toLowerCase()}
              aria-label={color.label}
              title={color.label}
              onClick={() => {
                onChange(color.value);
                setOpen(false);
              }}
              className="h-5 w-5 rounded-full ring-offset-1 aria-selected:ring-2 aria-selected:ring-[var(--accent)]"
              style={{ background: color.value }}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}

function AddForm({ placeholder, button, onAdd }: { placeholder: string; button: string; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    onAdd(name.trim());
    setName("");
  };
  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={100} aria-label={placeholder} className="flex-1" />
      <Button type="submit" disabled={!name.trim()}>
        {button}
      </Button>
    </form>
  );
}

function AddListForm({ store, onAdd }: { store: TabStore; onAdd: (name: string, kind: NewListKind, color: string | null, template: TemplateChoice | null) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NewListKind>("list");
  const [color, setColor] = useState<string | null>(null);
  const templates = useProjectTemplates(store);
  const [template, setTemplate] = useState<TemplateChoice | null>(null);
  // Szablon usunięty w międzyczasie (inne urządzenie) — pusty projekt.
  const chosen = template && templates.some((t) => t.id === template.template.id) ? template : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    onAdd(name.trim(), kind, color, kind === "project" ? chosen : null);
    setName("");
    setColor(null);
    setTemplate(null);
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
      <ColorPicker value={color} onChange={setColor} label="Kolor nowej listy" />
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nowa lista albo projekt" maxLength={200} aria-label="Nazwa nowej listy" className="min-w-48 flex-1" />
      <Select value={kind} onChange={(e) => setKind(e.target.value as NewListKind)} aria-label="Rodzaj" className="w-32">
        <option value="list">{LIST_KIND.list}</option>
        <option value="project">{LIST_KIND.project}</option>
      </Select>
      <Button type="submit" disabled={!name.trim()}>
        Dodaj
      </Button>
      {kind === "project" ? <TemplatePicker templates={templates} value={chosen} onChange={setTemplate} /> : null}
    </form>
  );
}
