"use client";

import { canEditScope, COLORS, columnDate, GUEST_ACCESS, GUEST_ACCESS_HINT, inboxId, keyBetween, LIST_KIND, listAccess, listKindPatch, plural, projectDatesOps, reorderPatches, SCOPE_ROLE, TRASH_DAYS, uuidv7, type GuestAccess, type ListKind, type LocalDate, type ProjectStatus, type ScopeRole } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useRef, useState, type FormEvent } from "react";

import { useLocalQuery } from "@/lib/local-store";
import { useClickOutside } from "@/lib/use-click-outside";

import { useAppEnv } from "./app-env";
import { CustomColorPanel, CustomColorSwatch } from "./color-picker";
import { ProjectStatusSelect } from "./project-status";
import { SharingPanel } from "./sharing";
import { useTaskActions } from "./task-item";
import { TemplatePicker, TemplatesCard, useCreateFromTemplate, useProjectTemplates, type TemplateChoice } from "./templates";
import { ArchiveIcon, Button, Card, CommitInput, IconButton, Input, Notice, Select, TrashIcon, UnarchiveIcon } from "./ui";
import { WorkspaceExportButton, WorkspaceImportCard } from "./workspace-transfer";

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

/** Przestrzenie i listy (MVP-1): tworzenie, nazwa, kolor, kolejność, archiwizacja, daty projektu; osoby i udostępnianie (v1.x). */
export function WorkspacesScreen({ store, email }: { store: TabStore; email: string | null }) {
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
          email={email}
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
      <WorkspaceImportCard email={email} />
      <TemplatesCard store={store} />
    </div>
  );
}

function WorkspaceCard({
  store,
  email,
  workspace,
  lists,
  showArchived,
  canUp,
  canDown,
  onMove,
  run,
}: {
  store: TabStore;
  email: string | null;
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
  const [transfer, setTransfer] = useState<{ tone: "error" | "ok" | "info"; text: string } | null>(null);
  // Podgląd tylko czyta; archiwizacja zmienia przestrzeń wszystkim członkom — tylko właściciel.
  const editable = canEditScope(workspace.role);
  const owner = workspace.role === null || workspace.role === "owner";
  // Inbox zawsze pierwszy i bez przesuwania; pozostałe po kluczu kolejności.
  const inbox = lists.find((l) => l.kind === "inbox");
  const others = lists.filter((l) => l.kind !== "inbox" && (showArchived || !l.archived_at)).sort(byKey);
  const activeOthers = lists.filter((l) => l.kind !== "inbox" && !l.archived_at).sort(byKey);

  const update = (patch: Record<string, unknown>) => run(() => store.mutate("workspaces", workspace.id, patch));
  const actions = useTaskActions();
  // Archiwizacja chowa przestrzeń (także u członków) — dymek z „Cofnij”, żeby było wiadomo, gdzie się podziała.
  const toggleArchived = () => {
    const at = archived ? null : new Date().toISOString();
    void actions.run([{ table: "workspaces", id: workspace.id, patch: { archived_at: at } }], {
      text: at ? `Zarchiwizowano przestrzeń „${workspace.name}” (widać ją po zaznaczeniu „Pokaż zarchiwizowane”)` : `Przywrócono przestrzeń „${workspace.name}”`,
      undo: [{ table: "workspaces", id: workspace.id, patch: { archived_at: workspace.archived_at ?? null } }],
    });
  };

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
    <Card className={archived ? "border-dashed" : ""}>
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
        <WorkspaceExportButton workspaceId={workspace.id} name={workspace.name} email={email} onMessage={setTransfer} />
        {owner ? (
          <Button kind="ghost" onClick={toggleArchived}>
            {archived ? "Przywróć" : "Archiwizuj"}
          </Button>
        ) : null}
      </div>
      {transfer ? (
        <div className="mt-3" data-testid="workspace-export-message">
          <Notice tone={transfer.tone}>{transfer.text}</Notice>
        </div>
      ) : null}
      {people ? (
        <SharingPanel
          store={store}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          lists={owner ? [...(inbox ? [inbox] : []), ...activeOthers].map((l) => ({ id: l.id, name: l.name, guestAccess: l.guest_access ?? "edit" })) : undefined}
        />
      ) : null}
      <ul className="@container mt-3 flex flex-col divide-y divide-[var(--line)] border-t border-[var(--line)]">
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
  const actions = useTaskActions();
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
  const badge = "shrink-0 rounded bg-[var(--hover)] px-1.5 py-px text-xs";
  return (
    <li data-list={list.id} className={`${LIST_ROW} ${archived ? "bg-[var(--hover)]" : ""}`}>
      {editable ? (
        <ColorPicker value={list.color} onChange={(color) => void update({ color })} label={`Kolor listy ${list.name}`} />
      ) : (
        <span className="h-4 w-4 rounded-full border border-[var(--line)]" style={{ background: list.color ?? "transparent" }} />
      )}
      <span className="flex min-w-40 flex-1 items-center gap-1.5 @[48rem]:min-w-0">
        {inbox || !editable ? (
          <span className="min-w-0 truncate px-1 font-medium" title={list.name}>
            {list.name}
          </span>
        ) : (
          <EditableName value={list.name} max={200} onSave={(name) => void update({ name })} />
        )}
        {archived ? <span className={badge}>zarchiwizowana</span> : null}
        {owner && guestAccess !== "edit" ? (
          <span className={badge} title={GUEST_ACCESS_HINT[guestAccess]} data-testid="list-guest-access">
            dla gości: {GUEST_ACCESS[guestAccess].toLowerCase()}
          </span>
        ) : null}
        {!owner && scopeEditable && !editable ? (
          <span className={badge} title="Właściciel udostępnił Ci tę listę tylko do podglądu">
            tylko podgląd
          </span>
        ) : null}
      </span>
      <span className="empty:hidden @[48rem]:empty:block">
        {inbox || !editable ? (
          <span className={badge}>{LIST_KIND[list.kind]}</span>
        ) : (
          <Select value={list.kind} onChange={(e) => changeKind(e.target.value as NewListKind)} aria-label={`Rodzaj: ${list.name}`} className={COMPACT_FIELD}>
            <option value="list">{LIST_KIND.list}</option>
            <option value="project">{LIST_KIND.project}</option>
          </Select>
        )}
      </span>
      <span className="empty:hidden @[48rem]:empty:block">
        {list.kind === "project" ? <ProjectStatusSelect name={list.name} value={list.project_status} onChange={editable ? (status) => void update({ project_status: status }) : undefined} className={COMPACT_FIELD} /> : null}
      </span>
      <span className="empty:hidden @[48rem]:empty:block">{list.kind === "project" ? <ProjectDates list={list} editable={editable} /> : null}</span>
      <span className="whitespace-nowrap text-xs text-[var(--muted)] empty:hidden @[48rem]:empty:block @[48rem]:text-right">{Number(list.open) > 0 ? `${list.open} otwartych` : null}</span>
      <span className="flex items-center gap-0.5 empty:hidden @[48rem]:empty:flex">
        {!inbox && editable ? (
          <>
            <IconButton label="W górę" disabled={!canUp} onClick={() => onMove?.(-1)}>
              ↑
            </IconButton>
            <IconButton label="W dół" disabled={!canDown} onClick={() => onMove?.(1)}>
              ↓
            </IconButton>
            <IconButton
              label={archived ? "Przywróć" : "Archiwizuj"}
              onClick={() => {
                const at = archived ? null : new Date().toISOString();
                void actions.run([{ table: "lists", id: list.id, patch: { archived_at: at } }], {
                  text: at ? `Zarchiwizowano listę „${list.name}” (widać ją po zaznaczeniu „Pokaż zarchiwizowane”)` : `Przywrócono listę „${list.name}”`,
                  undo: [{ table: "lists", id: list.id, patch: { archived_at: list.archived_at ?? null } }],
                });
              }}
            >
              {archived ? <UnarchiveIcon /> : <ArchiveIcon />}
            </IconButton>
            {Number(list.total) === 0 ? (
              <IconButton label="Usuń pustą listę" onClick={remove} className="text-[var(--danger)]">
                <TrashIcon />
              </IconButton>
            ) : null}
          </>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Wiersz listy: na wąskim ekranie zawija się jak dotąd, od 48rem szerokości listy (`@container` na `ul`)
 * jest siatką o stałych kolumnach — kolor, nazwa (skracana), rodzaj, status, daty, licznik, akcje —
 * wyrównaną między wierszami i bez przenoszenia przy długich nazwach.
 */
const LIST_ROW =
  "flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-sm @[48rem]:grid @[48rem]:grid-cols-[1rem_minmax(0,1fr)_5.25rem_6.75rem_14rem_5.5rem_7.5rem] @[48rem]:gap-y-0";

/** Zwarte pole w wierszu listy (select / data) — wypełnia kolumnę siatki. */
const COMPACT_FIELD = "w-full px-1.5! py-0.5! text-xs!";

/**
 * Początek i koniec projektu (`lists.start_date` / `end_date`; pasek projektu na osi czasu). Zadań nie
 * przesuwa (to robi przeciągnięcie paska na osi); koniec przed początkiem przesuwa drugą datę (core
 * `projectDatesOps`); puste pole czyści datę. Zapis z „Cofnij”.
 */
function ProjectDates({ list, editable }: { list: ListRow; editable: boolean }) {
  const { run } = useTaskActions();
  const { today } = useAppEnv();
  const start = list.start_date as LocalDate | null;
  const end = list.end_date as LocalDate | null;
  if (!editable) {
    if (!start && !end) return null;
    return (
      <span className="text-xs text-[var(--muted)]" title="Początek – koniec projektu">
        {start ? columnDate(start, today) : "…"} – {end ? columnDate(end, today) : "…"}
      </span>
    );
  }
  const change = (next: { startDate: LocalDate | null } | { endDate: LocalDate | null }) => {
    const { ops, undo } = projectDatesOps({ id: list.id, startDate: start, endDate: end }, next);
    if (ops.length) void run(ops, { text: `Daty projektu „${list.name}” zmienione`, undo });
  };
  return (
    <span className="flex items-center gap-1 text-xs @[48rem]:grid @[48rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" role="group" aria-label={`Daty projektu ${list.name}`} data-testid="project-dates">
      <CommitInput type="date" aria-label={`Początek projektu ${list.name}`} title="Początek projektu" value={start ?? ""} onCommit={(v) => change({ startDate: (v || null) as LocalDate | null })} className={COMPACT_FIELD} />
      <span aria-hidden>–</span>
      <CommitInput type="date" aria-label={`Koniec projektu ${list.name}`} title="Koniec projektu" value={end ?? ""} onCommit={(v) => change({ endDate: (v || null) as LocalDate | null })} className={COMPACT_FIELD} />
    </span>
  );
}

/** Nazwa edytowana w miejscu: kliknięcie → pole, Enter / utrata fokusu zapisuje, Esc anuluje. */
function EditableName({ value, max, onSave, className = "" }: { value: string; max: number; onSave: (name: string) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button type="button" className={`min-w-0 truncate rounded px-1 text-left hover:bg-[var(--hover)] ${className}`} title={`${value} — kliknij, aby zmienić nazwę`} onClick={() => setDraft(value)}>
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
      className={`w-full max-w-xs py-0.5! ${className}`}
    />
  );
}

function ColorPicker({ value, onChange, label }: { value: string | null; onChange: (color: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useClickOutside(open, () => setOpen(false), root);
  const pick = (color: string) => {
    onChange(color);
    setOpen(false);
  };
  return (
    <span ref={root} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setCustom(false);
        }}
        className="h-4 w-4 rounded-full border border-[var(--line)]"
        style={{ background: value ?? "transparent" }}
      />
      {open ? (
        <div className="absolute top-6 left-0 z-10 flex w-max flex-col gap-2 rounded-md border border-[var(--line)] bg-[var(--surface)] p-2 shadow">
          <div className="flex gap-1">
            <div role="listbox" aria-label={label} className="flex gap-1">
              {COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  role="option"
                  aria-selected={color.value.toLowerCase() === value?.toLowerCase()}
                  aria-label={color.label}
                  title={color.label}
                  onClick={() => pick(color.value)}
                  className="h-5 w-5 rounded-full ring-offset-1 aria-selected:ring-2 aria-selected:ring-[var(--accent)]"
                  style={{ background: color.value }}
                />
              ))}
            </div>
            <CustomColorSwatch value={value} open={custom} onClick={() => setCustom((c) => !c)} className="h-5 w-5 rounded-full" />
          </div>
          {custom ? <CustomColorPanel value={value} onChange={pick} /> : null}
        </div>
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
