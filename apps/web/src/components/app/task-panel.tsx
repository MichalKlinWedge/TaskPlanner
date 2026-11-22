"use client";

/**
 * Panel zadania (MVP-2): wszystkie pola zadania, opis w Markdown (TipTap), tagi, przypomnienia,
 * podzadania (do 4 poziomów), czas pracy (M14), zależności (poprzednicy / następnicy, M12), osoby (odpowiedzialny
 * i uczestnicy — tylko informacyjnie), komentarze, historia zmian (online, z `activity_log`) i kosz. Każda zmiana to
 * `store.mutate` jednego pola — synchronizacja scala zmiany pól z innych urządzeń (§6).
 */
import {
  addCommentOps,
  BOARD_UNASSIGNED,
  canEditScope,
  addDependencyOps,
  addParticipantByNameOps,
  addParticipantOps,
  assigneeChoices,
  assignTaskOps,
  attachSubtaskOps,
  canAddSubtask,
  subtaskCandidates,
  taskBoardColumn,
  clampLag,
  collaboratorMatches,
  collaboratorsForWorkspace,
  commentAuthor,
  commentTime,
  creatorLabel,
  datesPatch,
  deleteCommentOps,
  dependencyErrorText,
  editCommentOps,
  MAX_COMMENT_LENGTH,
  removeParticipantOps,
  sortComments,
  deleteTaskOps,
  descendants,
  endSeriesOps,
  describeRecurrence,
  formatMinutes,
  isOpen,
  LIST_KIND,
  moveTaskOps,
  normalizeText,
  plural,
  PRIORITY,
  REMINDER_PRESETS,
  reminderOffset,
  relativeDay,
  removeDependencyOps,
  shortDate,
  skipOccurrenceOps,
  TASK_FIELD,
  TASK_STATUS,
  taskLinks,
  tagsForWorkspace,
  taskTagId,
  taskTagOps,
  uuidv7,
  type LocalDate,
  type LocalTime,
  type Priority,
  type Recurrence,
  type TaskLink,
  type TaskStatus,
  type ViewTask,
} from "@taskplanner/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { listEditable } from "@/lib/app-data";
import { useDependencies } from "@/lib/dependencies";
import { descriptionExtensions, descriptionMarkdown } from "@/lib/editor";
import { useLocalQuery } from "@/lib/local-store";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { useAppEnv } from "./app-env";
import { AttachmentsField } from "./attachments";
import { TaskTimeField } from "./focus";
import { QuickAdd } from "./quick-add";
import { RecurrenceEditor } from "./recurrence-editor";
import { TaskItem, useTaskActions } from "./task-item";
import { Button, CommitInput, IconButton, Input, navLinkClass, Select } from "./ui";

type Row = Record<string, string | number | null>;

const STATUSES = Object.keys(TASK_STATUS) as TaskStatus[];
const PRIORITIES = [1, 2, 3, 4] as const satisfies readonly Priority[];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}

/**
 * Część panelu, którą da się zmieniać. W przestrzeni udostępnionej do podglądu `fieldset disabled`
 * wyszarza i blokuje wszystkie pola i przyciski w środku (zapis i tak odrzuciłby silnik).
 */
function Editable({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0 disabled:opacity-60">
      {children}
    </fieldset>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-[var(--line)] pt-3">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function TaskPanel({ taskId }: { taskId: string }) {
  const { data, userId, today, timeZone, openTask } = useAppEnv();
  const { run, toggle } = useTaskActions();
  const task = data.tasks.find((t) => t.id === taskId);

  // Escape zamyka panel (poza polami tekstowymi i edytorem).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (event.key === "Escape" && !(el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)))) openTask(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTask]);

  if (!task) {
    return (
      <PanelFrame onClose={() => openTask(null)}>
        <p className="text-sm text-[var(--muted)]">Tego zadania już nie ma (usunięte albo w zarchiwizowanej liście).</p>
      </PanelFrame>
    );
  }

  const update = (patch: Record<string, unknown>) => run([{ table: "tasks", id: task.id, patch }]);
  const boardColumnDefs = data.lists.find((l) => l.id === task.listId)?.boardColumns ?? [];
  const parent = task.parentId ? data.tasks.find((t) => t.id === task.parentId) : undefined;
  const children = data.tasks.filter((t) => t.parentId === task.id).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const scopeReadOnly = !canEditScope(data.workspaces.find((w) => w.id === task.workspaceId)?.role);
  const readOnly = !listEditable(data, task.listId);

  const remove = () => {
    const ops = deleteTaskOps(data.tasks, task.id, new Date());
    void run(ops, { text: `„${task.title}” w koszu`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: null } })) });
    openTask(parent?.id ?? null);
  };

  return (
    <PanelFrame onClose={() => openTask(null)}>
      {parent ? (
        <button type="button" className="mb-2 block max-w-full truncate text-left text-xs text-[var(--muted)] hover:text-[var(--accent)]" onClick={() => openTask(parent.id)}>
          ↑ {parent.title}
        </button>
      ) : null}
      {readOnly ? (
        <p className="mb-2 rounded-md bg-[var(--hover)] px-2 py-1 text-xs text-[var(--muted)]" data-testid="task-read-only">
          {scopeReadOnly
            ? `Przestrzeń „${workspaceName.get(task.workspaceId)}” jest udostępniona Ci tylko do podglądu — zadania nie da się zmienić.`
            : `Lista „${data.lists.find((l) => l.id === task.listId)?.name ?? ""}” jest udostępniona Ci tylko do podglądu — zadania nie da się zmienić.`}
        </p>
      ) : null}
      <Editable readOnly={readOnly}>
        <div className="flex items-start gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={task.status === "done"}
            aria-label={task.status === "done" ? "Przywróć zadanie" : "Ukończ zadanie"}
            onClick={() => void toggle(task)}
            className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-xs text-white"
            style={{ borderColor: PRIORITY[task.priority].color, background: task.status === "done" ? PRIORITY[task.priority].color : "transparent" }}
          >
            {task.status === "done" ? "✓" : ""}
          </button>
          <TitleField key={`${task.id}:${task.title}`} value={task.title} onSave={(title) => void update({ title })} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select value={task.status} onChange={(e) => void update(e.target.value === "done" || e.target.value === "cancelled" ? { status: e.target.value, completed_at: new Date().toISOString() } : { status: e.target.value, completed_at: null })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priorytet">
            <Select value={task.priority} onChange={(e) => void update({ priority: Number(e.target.value) })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY[p].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lista">
            <Select
              value={task.listId}
              onChange={(e) => void run(moveTaskOps(data.tasks, task.id, e.target.value))}
            >
              {data.workspaces.map((w) => (
                <optgroup key={w.id} label={w.name}>
                  {data.lists
                    .filter((l) => l.workspaceId === w.id)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.kind === "inbox" ? `Inbox (${w.name})` : `${l.name} · ${LIST_KIND[l.kind]}`}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Czas (min)">
            <Input
              key={`${task.id}:${task.durationMin}`}
              type="number"
              min={1}
              max={10080}
              step={5}
              defaultValue={task.durationMin ?? ""}
              placeholder="—"
              onBlur={(e) => {
                const value = e.target.value ? Math.round(Number(e.target.value)) : null;
                if (value !== task.durationMin && (value === null || (value >= 1 && value <= 10080))) void update({ duration_min: value });
              }}
            />
          </Field>
          <Field label="Początek">
            <CommitInput type="date" value={task.startDate ?? ""} max={task.dueDate ?? undefined} disabled={!task.dueDate} onCommit={(value) => void update(datesPatch(task, { start_date: (value || null) as LocalDate | null }))} />
          </Field>
          <div className="flex items-end text-xs text-[var(--muted)]">
            {task.dueDate ? `${relativeDay(task.dueDate, today, "distance")}${task.durationMin ? ` · ${formatMinutes(task.durationMin)}` : ""}` : "Bez terminu"}
          </div>
          <Field label="Termin">
            <CommitInput type="date" value={task.dueDate ?? ""} onCommit={(value) => void update(datesPatch(task, { due_date: (value || null) as LocalDate | null }))} />
          </Field>
          <Field label="Godzina">
            <CommitInput type="time" value={task.dueTime ?? ""} disabled={!task.dueDate} onCommit={(value) => void update(datesPatch(task, { due_time: (value || null) as LocalTime | null }))} />
          </Field>
          {boardColumnDefs.length && task.kind === "task" && !task.parentId ? (
            <Field label="Kolumna tablicy">
              <Select aria-label="Kolumna tablicy" value={taskBoardColumn(task, boardColumnDefs) ?? ""} onChange={(e) => void update({ board_column_id: e.target.value || null })}>
                <option value="">{BOARD_UNASSIGNED}</option>
                {boardColumnDefs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>

        <PeopleField key={`people:${task.id}`} task={task} />

        {task.kind === "habit" ? (
          <Block title="Nawyk">
            <a href={`#/habit/${task.id}`} className={`self-start ${navLinkClass}`}>
              Statystyki, harmonogram i cel →
            </a>
          </Block>
        ) : null}

        <RecurrenceField key={`rec:${task.id}`} task={task} onSave={(patch) => void update(patch)} timeZone={timeZone} today={today} />

        <TagsField task={task} userId={userId} />

        <RemindersField key={`rem:${task.id}`} task={task} />

        <Block title="Opis">
          <DescriptionEditor key={task.id} taskId={task.id} readOnly={readOnly} />
        </Block>
      </Editable>

      <Block title={`Podzadania${children.length ? ` · ${children.filter((c) => c.status === "done").length}/${children.filter((c) => c.status !== "cancelled").length}` : ""}`}>
        {children.length ? (
          <ul className="divide-y divide-[var(--line)]">
            {children.map((c) => (
              <TaskItem key={c.id} task={c} today={today} />
            ))}
          </ul>
        ) : null}
        {readOnly ? null : canAddSubtask(data.tasks, task.id) ? (
          <>
            <QuickAdd parent={{ id: task.id, listId: task.listId }} placeholder="Dodaj podzadanie" />
            <AttachSubtask key={`sub:${task.id}`} task={task} />
          </>
        ) : (
          <p className="text-xs text-[var(--muted)]">Najwyżej 4 poziomy zadań — tu nie można dodać kolejnego.</p>
        )}
      </Block>

      <AttachmentsField key={`att:${task.id}`} task={task} readOnly={readOnly} />

      <Editable readOnly={readOnly}>
        <TaskTimeField task={task} />

        <DependenciesField key={`dep:${task.id}`} task={task} />

        <CommentsField key={`com:${task.id}`} task={task} />
      </Editable>

      <History
        key={`hist:${task.id}`}
        taskId={task.id}
        lists={new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${workspaceName.get(l.workspaceId)})` : l.name]))}
        people={new Map(data.collaborators.map((c) => [c.id, c.name]))}
      />

      <div className="mt-4 flex items-center justify-between border-t border-[var(--line)] pt-3 text-xs text-[var(--muted)]">
        <span>Dodano {task.createdAt.startsWith("1970") ? "teraz (jeszcze nie wysłane)" : shortDate(task.createdAt.slice(0, 10))}</span>
        <Button kind="danger" disabled={readOnly} onClick={remove}>
          Przenieś do kosza
        </Button>
      </div>
    </PanelFrame>
  );
}

/**
 * Zależności koniec→początek (M12): „Czeka na” (poprzednicy) i „Blokuje” (następnicy) z opóźnieniem
 * w dniach i naruszeniem; dodanie wyszukaniem zadania z tej samej przestrzeni — przez `addDependencyOps`
 * (cykl, duplikat i inna przestrzeń są blokowane). Na osi czasu zależności tworzy się przeciągnięciem.
 */
/** Podpięcie istniejącego zadania z tej samej listy jako podzadania (core `subtaskCandidates`). */
function AttachSubtask({ task }: { task: ViewTask }) {
  const { data } = useAppEnv();
  const { run, notify } = useTaskActions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const all = useMemo(() => (open ? subtaskCandidates(data.tasks, task.id) : []), [open, data.tasks, task.id]);
  const needle = normalizeText(query.trim());
  const candidates = (needle ? all.filter((t) => normalizeText(t.title).includes(needle)) : all).slice(0, 8);

  const attach = (child: ViewTask) => {
    const result = attachSubtaskOps(data.tasks, task.id, child.id);
    if (!result) return notify("Tego zadania nie można podpiąć (cykl albo więcej niż 4 poziomy).");
    void run(result.ops, { text: `„${child.title}” jest podzadaniem „${task.title}”`, undo: result.undo });
    setQuery("");
  };

  if (!open) {
    return (
      <Button kind="ghost" onClick={() => setOpen(true)}>
        + Z istniejących…
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj zadania na tej liście"
          aria-label="Szukaj zadania do podpięcia"
          className="min-w-0 flex-1"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === "Enter" && candidates[0]) attach(candidates[0]);
          }}
        />
        <Button kind="ghost" onClick={() => setOpen(false)}>
          Anuluj
        </Button>
      </div>
      {candidates.length ? (
        <ul className="rounded-md border border-[var(--line)] text-sm" aria-label="Zadania do podpięcia">
          {candidates.map((t) => (
            <li key={t.id}>
              <button type="button" className="block w-full truncate px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/10" onClick={() => attach(t)}>
                {t.title}
                {t.parentId ? <span className="ml-2 text-xs text-[var(--muted)]">↳ {data.tasks.find((p) => p.id === t.parentId)?.title ?? ""}</span> : null}
                {t.dueDate ? <span className="ml-2 text-xs text-[var(--muted)]">{shortDate(t.dueDate)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--muted)]">{needle ? "Brak otwartych zadań o takim tytule na tej liście." : "Brak zadań na tej liście, które można podpiąć."}</p>
      )}
    </div>
  );
}

function DependenciesField({ task }: { task: ViewTask }) {
  const { store, data, openTask } = useAppEnv();
  const { run, notify } = useTaskActions();
  const deps = useDependencies(store);
  const links = useMemo(() => taskLinks(task.id, data.tasks, deps), [task.id, data.tasks, deps]);
  const [adding, setAdding] = useState<"predecessor" | "successor" | null>(null);
  const [query, setQuery] = useState("");
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const titleOf = (id: string) => `„${byId.get(id)?.title ?? "?"}”`;
  const needle = normalizeText(query.trim());
  const candidates = adding && needle ? data.tasks.filter((t) => t.id !== task.id && t.kind === "task" && t.workspaceId === task.workspaceId && isOpen(t) && normalizeText(t.title).includes(needle)).slice(0, 8) : [];

  const add = (otherId: string) => {
    const next = adding === "predecessor" ? { predecessorId: otherId, successorId: task.id } : { predecessorId: task.id, successorId: otherId };
    const result = addDependencyOps(data.tasks, deps, next);
    if ("error" in result) return notify(dependencyErrorText(result.error, titleOf));
    void run(result.ops, { text: `Zależność: ${titleOf(next.predecessorId)} → ${titleOf(next.successorId)}`, undo: result.undo });
    setAdding(null);
    setQuery("");
  };

  const item = (link: TaskLink) => {
    const other = byId.get(link.otherId);
    const { dependency: d } = link;
    return (
      <li key={d.id} className="flex items-center gap-2 py-1 text-sm">
        <button type="button" className={`min-w-0 flex-1 truncate text-left hover:text-[var(--accent)] ${other && !isOpen(other) ? "text-[var(--muted)] line-through" : ""}`} onClick={() => openTask(link.otherId)}>
          {other?.title ?? "?"}
        </button>
        {link.violation ? (
          <span className="shrink-0 text-xs text-[var(--danger)]" title={`Następnik może zacząć się najwcześniej ${shortDate(link.violation.earliestStart)}`}>
            ⚠ {plural(link.violation.days, ["dzień", "dni", "dni"])} za wcześnie
          </span>
        ) : null}
        <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--muted)]" title="Odstęp w dniach między końcem poprzednika a początkiem następnika">
          +
          <Input
            key={`${d.id}:${d.lagDays}`}
            type="number"
            min={-365}
            max={365}
            step={1}
            defaultValue={d.lagDays}
            className="w-16 py-0.5 text-xs"
            aria-label={`Odstęp w dniach: ${other?.title ?? ""}`}
            onBlur={(e) => {
              const lag = clampLag(Number(e.target.value));
              if (lag !== d.lagDays) void run([{ table: "task_dependencies", id: d.id, patch: { lag_days: lag } }]);
            }}
          />
          dni
        </label>
        <IconButton
          label="Usuń zależność"
          onClick={() => {
            const result = removeDependencyOps(d.id);
            void run(result.ops, { text: `Usunięto zależność ${titleOf(d.predecessorId)} → ${titleOf(d.successorId)}`, undo: result.undo });
          }}
        >
          ×
        </IconButton>
      </li>
    );
  };

  const count = links.predecessors.length + links.successors.length;
  return (
    <Block title={`Zależności${count ? ` · ${count}` : ""}`}>
      {links.predecessors.length ? (
        <>
          <h4 className="text-xs text-[var(--muted)]">Czeka na</h4>
          <ul className="mb-2 divide-y divide-[var(--line)]" aria-label="Poprzednicy">
            {links.predecessors.map(item)}
          </ul>
        </>
      ) : null}
      {links.successors.length ? (
        <>
          <h4 className="text-xs text-[var(--muted)]">Blokuje</h4>
          <ul className="mb-2 divide-y divide-[var(--line)]" aria-label="Następnicy">
            {links.successors.map(item)}
          </ul>
        </>
      ) : null}
      {adding ? (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={adding === "predecessor" ? "Na co czeka to zadanie?" : "Co czeka na to zadanie?"} aria-label="Szukaj zadania" className="min-w-0 flex-1" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setAdding(null))} />
            <Button kind="ghost" onClick={() => setAdding(null)}>
              Anuluj
            </Button>
          </div>
          {candidates.length ? (
            <ul className="rounded-md border border-[var(--line)] text-sm" aria-label="Zadania do wyboru">
              {candidates.map((t) => (
                <li key={t.id}>
                  <button type="button" className="block w-full truncate px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/10" onClick={() => add(t.id)}>
                    {t.title}
                    {t.dueDate ? <span className="ml-2 text-xs text-[var(--muted)]">{shortDate(t.dueDate)}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : needle ? (
            <p className="text-xs text-[var(--muted)]">Brak otwartych zadań o takim tytule w tej przestrzeni.</p>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-2">
          <Button kind="ghost" onClick={() => setAdding("predecessor")}>
            + Czeka na…
          </Button>
          <Button kind="ghost" onClick={() => setAdding("successor")}>
            + Blokuje…
          </Button>
        </div>
      )}
    </Block>
  );
}

/**
 * Odpowiedzialny (domyślnie twórca) i uczestnicy zadania — tylko do informacji, bez dostępu dla
 * tych osób. Nowa nazwa w polu „+ osoba” dopisuje współpracownika (Ustawienia → „Współpracownicy”).
 */
function PeopleField({ task }: { task: ViewTask }) {
  const { store, data, userId } = useAppEnv();
  const { run, notify } = useTaskActions();
  const participants = useLocalQuery<Row>(store, "select collaborator_id from task_participants where task_id = ? and deleted_at is null order by rowid", [task.id], ["task_participants"]);
  const creator = useLocalQuery<Row>(store, "select created_by from tasks where id = ?", [task.id], ["tasks"]);
  const [name, setName] = useState("");
  const byId = new Map(data.collaborators.map((c) => [c.id, c]));
  const chosen = participants.rows.map((r) => String(r.collaborator_id)).filter((id) => byId.has(id));
  const assignee = task.assigneeId && byId.has(task.assigneeId) ? task.assigneeId : "";
  // Osoby z przestrzeni zadania (+ obecny odpowiedzialny, żeby wybór go pokazał).
  const people = collaboratorsForWorkspace(data.collaborators, task.workspaceId, [assignee]);
  const suggestions = collaboratorMatches(people, "", chosen, 100);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const result = addParticipantByNameOps(userId, data.collaborators, task.id, name, task.workspaceId);
    if (!result.ok) return notify(result.error);
    setName("");
    void run(result.ops, result.created ? { text: `Nowy współpracownik: „${name.trim()}”` } : undefined);
  };
  const remove = (id: string) => {
    const { ops, undo } = removeParticipantOps(task.id, id, new Date());
    void run(ops, { text: `Usunięto z uczestników: ${byId.get(id)?.name ?? ""}`, undo });
  };

  return (
    <Block title="Osoby">
      <div className="flex flex-col gap-3">
        <Field label="Odpowiedzialny">
          <Select value={assignee} onChange={(e) => void run(assignTaskOps(task.id, e.target.value || null))}>
            <option value="">{creatorLabel(creator.rows[0]?.created_by as string | null | undefined, userId)} (twórca zadania)</option>
            {assigneeChoices(people, assignee).map((c) => (
              <option key={c.id} value={c.id}>
                {c.archivedAt ? `${c.name} (nieaktywny)` : c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-[var(--muted)]">Uczestnicy</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {chosen.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-900 dark:bg-sky-900/50 dark:text-sky-100" title={byId.get(id)?.email ?? undefined}>
                {byId.get(id)?.name}
                <button type="button" aria-label={`Usuń z uczestników: ${byId.get(id)?.name ?? ""}`} className="opacity-60 hover:opacity-100" onClick={() => remove(id)}>
                  ×
                </button>
              </span>
            ))}
            <form onSubmit={add} className="inline-flex">
              <Input list={`people-${task.id}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="+ osoba" aria-label="Dodaj uczestnika" maxLength={100} className="w-36 py-0.5 text-xs" />
              <datalist id={`people-${task.id}`}>
                {suggestions.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </form>
          </div>
          {assignee && !chosen.includes(assignee) ? (
            <button type="button" className="self-start text-[var(--accent)] hover:underline" onClick={() => void run(addParticipantOps(task.id, assignee))}>
              + dodaj odpowiedzialnego do uczestników
            </button>
          ) : null}
          <span className="text-[var(--muted)]">Tylko informacyjnie — te osoby nie dostają dostępu do zadania.</span>
        </div>
      </div>
    </Block>
  );
}

/** Komentarze zadania: wątek od najstarszego, dodanie (Ctrl+Enter), edycja i usunięcie z cofnięciem. */
function CommentsField({ task }: { task: ViewTask }) {
  const { store, userId, today, timeZone } = useAppEnv();
  const { run, notify } = useTaskActions();
  const { rows } = useLocalQuery<Row>(store, "select id, body, posted_at, edited_at, created_by from task_comments where task_id = ? and deleted_at is null", [task.id], ["task_comments"]);
  const comments = useMemo(
    () =>
      sortComments(
        rows.map((r) => ({ id: String(r.id), taskId: task.id, body: String(r.body), postedAt: String(r.posted_at), editedAt: (r.edited_at as string | null) ?? null, authorId: (r.created_by as string | null) ?? null })),
      ),
    [rows, task.id],
  );
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const submit = () => {
    const result = addCommentOps(task.id, draft, new Date());
    if (!result.ok) return notify(result.error);
    setDraft("");
    void run(result.ops);
  };
  const saveEdit = () => {
    if (!editing) return;
    const comment = comments.find((c) => c.id === editing.id);
    if (!comment) return setEditing(null);
    const result = editCommentOps(comment, editing.text, new Date());
    if (!result.ok) return notify(result.error);
    setEditing(null);
    if (result.ops.length) void run(result.ops);
  };
  const remove = (id: string) => {
    const { ops, undo } = deleteCommentOps(id, new Date());
    void run(ops, { text: "Usunięto komentarz", undo });
  };
  const keys = (save: () => void, cancel?: () => void) => (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape" && cancel) {
      e.stopPropagation();
      cancel();
    }
  };
  const area = "w-full resize-y rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]";

  return (
    <Block title={`Komentarze${comments.length ? ` · ${comments.length}` : ""}`}>
      {comments.length ? (
        <ol className="mb-3 flex flex-col gap-3" aria-label="Komentarze">
          {comments.map((c) => (
            <li key={c.id} className="text-sm">
              <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <span className="font-medium text-[var(--foreground)]">{commentAuthor(c.authorId, userId)}</span>
                <span>{commentTime(c.postedAt, today, timeZone)}</span>
                {c.editedAt ? <span title={`Edytowano ${commentTime(c.editedAt, today, timeZone)}`}>(edytowano)</span> : null}
                {editing?.id !== c.id ? (
                  <span className="ml-auto flex gap-2">
                    <button type="button" className="hover:text-[var(--accent)]" onClick={() => setEditing({ id: c.id, text: c.body })}>
                      Edytuj
                    </button>
                    <button type="button" className="hover:text-[var(--danger)]" onClick={() => remove(c.id)}>
                      Usuń
                    </button>
                  </span>
                ) : null}
              </div>
              {editing?.id === c.id ? (
                <div className="mt-1 flex flex-col gap-1">
                  <textarea
                    autoFocus
                    aria-label="Edycja komentarza"
                    value={editing.text}
                    maxLength={MAX_COMMENT_LENGTH}
                    rows={3}
                    onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                    onKeyDown={keys(saveEdit, () => setEditing(null))}
                    className={area}
                  />
                  <div className="flex gap-2">
                    <Button onClick={saveEdit}>Zapisz</Button>
                    <Button kind="ghost" onClick={() => setEditing(null)}>
                      Anuluj
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-0.5 break-words whitespace-pre-wrap">{c.body}</p>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex flex-col gap-1">
        <textarea
          aria-label="Nowy komentarz"
          value={draft}
          maxLength={MAX_COMMENT_LENGTH}
          rows={2}
          placeholder="Napisz komentarz… (Ctrl+Enter — dodaj)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={keys(submit)}
          className={area}
        />
        {draft.trim() ? (
          <div>
            <Button onClick={submit}>Dodaj komentarz</Button>
          </div>
        ) : null}
      </div>
    </Block>
  );
}

function PanelFrame({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <aside
      aria-label="Zadanie"
      className="fixed inset-0 z-30 overflow-y-auto bg-[var(--surface)] p-4 lg:static lg:z-auto lg:w-[26rem] lg:shrink-0 lg:border-l lg:border-[var(--line)]"
    >
      <div className="mb-1 flex justify-end">
        <IconButton label="Zamknij panel (Esc)" onClick={onClose}>
          ✕
        </IconButton>
      </div>
      {children}
    </aside>
  );
}

function TitleField({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const title = draft.trim();
    if (title && title !== value) onSave(title.slice(0, 500));
    else setDraft(value);
  };
  return (
    <textarea
      aria-label="Tytuł"
      value={draft}
      rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 34)))}
      maxLength={500}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold outline-none hover:border-[var(--line)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:hover:border-transparent"
    />
  );
}

function RecurrenceField({ task, onSave, timeZone, today }: { task: ViewTask; onSave: (patch: Record<string, unknown>) => void; timeZone?: string; today: LocalDate }) {
  const { data } = useAppEnv();
  const { run } = useTaskActions();
  const [editing, setEditing] = useState(false);
  const anchor = task.dueDate ?? today;
  const save = (recurrence: Recurrence) => {
    // Seria liczy się od terminu zadania; termin przechodzi na pierwsze pasujące wystąpienie.
    const due = recurrence.mode === "schedule" ? recurrence.anchor : anchor;
    onSave({ recurrence, ...datesPatch(task, { due_date: due }) });
    setEditing(false);
  };
  const series = task.recurrence && task.kind === "task" && isOpen(task);
  const skip = () => {
    const now = new Date();
    const result = skipOccurrenceOps(task, { now, timeZone, subtasks: descendants(data.tasks, task.id) });
    void run(result.ops, { text: result.nextDue ? `Pominięto — następny termin: ${relativeDay(result.nextDue, today)}` : "Pominięto ostatnie wystąpienie — seria zakończona", undo: result.undo });
  };
  const end = () => {
    if (!window.confirm(`Zakończyć serię „${task.title}”? Kolejne wystąpienia nie powstaną.`)) return;
    const result = endSeriesOps(task, new Date());
    void run(result.ops, { text: `Zakończono serię „${task.title}”`, undo: result.undo });
  };
  return (
    <Block title="Powtarzanie">
      {editing ? (
        <RecurrenceEditor value={task.recurrence} anchor={anchor} today={today} timeZone={timeZone} onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{task.recurrence ? `↻ ${describeRecurrence(task.recurrence)}` : <span className="text-[var(--muted)]">Nie powtarza się</span>}</span>
            <Button kind="ghost" onClick={() => setEditing(true)}>
              {task.recurrence ? "Zmień" : "Ustaw"}
            </Button>
            {task.recurrence ? (
              <Button kind="ghost" onClick={() => onSave({ recurrence: null })} title="Zadanie zostaje, przestaje się powtarzać">
                Usuń
              </Button>
            ) : null}
          </div>
          {series ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Button kind="ghost" onClick={skip}>
                Pomiń to wystąpienie
              </Button>
              <Button kind="ghost" onClick={end}>
                Zakończ serię
              </Button>
              <span className="text-xs text-[var(--muted)]">Zmiana terminu wyżej przesuwa tylko to wystąpienie.</span>
            </div>
          ) : null}
        </div>
      )}
    </Block>
  );
}

function TagsField({ task, userId }: { task: ViewTask; userId: string }) {
  const { data } = useAppEnv();
  const { run } = useTaskActions();
  const [name, setName] = useState("");
  const byId = new Map(data.tags.map((t) => [t.id, t]));
  const add = (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim().replace(/^[@#]/, "");
    if (!value) return;
    setName("");
    void run(taskTagOps({ userId, tags: data.tags }, task.id, [value], task.workspaceId));
  };
  return (
    <Block title="Tagi">
      <div className="flex flex-wrap items-center gap-1.5">
        {task.tagIds.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/50 dark:text-amber-100">
            {byId.get(id)?.name ?? "…"}
            <button
              type="button"
              aria-label={`Usuń tag ${byId.get(id)?.name ?? ""}`}
              className="opacity-60 hover:opacity-100"
              onClick={() => void run([{ table: "task_tags", id: taskTagId(task.id, id), patch: { deleted_at: new Date().toISOString() } }])}
            >
              ×
            </button>
          </span>
        ))}
        <form onSubmit={add} className="inline-flex">
          <Input list="tag-names" value={name} onChange={(e) => setName(e.target.value)} placeholder="+ tag" aria-label="Dodaj tag" maxLength={60} className="w-32 py-0.5 text-xs" />
          <datalist id="tag-names">
            {/* Podpowiedzi: tagi przestrzeni zadania (wpisana nazwa ukrytego tagu i tak trafia w ten sam tag). */}
            {tagsForWorkspace(data.tags, task.workspaceId)
              .filter((t) => !task.tagIds.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.name} />
              ))}
          </datalist>
        </form>
      </div>
    </Block>
  );
}

function RemindersField({ task }: { task: ViewTask }) {
  const { store } = useAppEnv();
  const { run } = useTaskActions();
  const { rows } = useLocalQuery<Row>(store, "select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null order by kind, offset_min, at_date, at_time", [task.id], ["reminders"]);
  const [choice, setChoice] = useState("");
  const [at, setAt] = useState({ date: task.dueDate ?? "", time: "09:00" });

  const add = (patch: Record<string, unknown>) => void run([{ table: "reminders", id: uuidv7(), patch: { task_id: task.id, offset_min: null, at_date: null, at_time: null, ...patch } }]);

  return (
    <Block title="Przypomnienia">
      <ul className="mb-2 flex flex-col gap-1 text-sm">
        {rows.map((r) => (
          <li key={String(r.id)} className="flex items-center gap-2">
            <span>🔔 {r.kind === "relative" ? reminderOffset(Number(r.offset_min)) : `${relativeDay(String(r.at_date) as LocalDate, task.dueDate ?? (String(r.at_date) as LocalDate))} ${String(r.at_time).slice(0, 5)}`}</span>
            <IconButton label="Usuń przypomnienie" onClick={() => void run([{ table: "reminders", id: String(r.id), patch: { deleted_at: new Date().toISOString() } }])}>
              ×
            </IconButton>
          </li>
        ))}
        {!rows.length ? <li className="text-xs text-[var(--muted)]">Brak przypomnień</li> : null}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Dodaj przypomnienie"
          value={choice}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith("rel:")) add({ kind: "relative", offset_min: Number(value.slice(4)) });
            setChoice(value === "abs" ? "abs" : "");
          }}
          className="py-1 text-xs"
        >
          <option value="">+ Dodaj przypomnienie…</option>
          {task.dueDate
            ? REMINDER_PRESETS.map((m) => (
                <option key={m} value={`rel:${m}`}>
                  {reminderOffset(m)}
                </option>
              ))
            : null}
          <option value="abs">O wybranej porze…</option>
        </Select>
        {choice === "abs" ? (
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!at.date || !at.time) return;
              add({ kind: "absolute", at_date: at.date, at_time: at.time });
              setChoice("");
            }}
          >
            <Input type="date" aria-label="Dzień przypomnienia" value={at.date} onChange={(e) => setAt({ ...at, date: e.target.value })} className="py-0.5 text-xs" />
            <Input type="time" aria-label="Godzina przypomnienia" value={at.time} onChange={(e) => setAt({ ...at, time: e.target.value })} className="py-0.5 text-xs" />
            <Button type="submit">Dodaj</Button>
          </form>
        ) : null}
      </div>
      {!task.dueDate ? <p className="mt-1 text-xs text-[var(--muted)]">Przypomnienia „przed terminem” wymagają terminu.</p> : null}
    </Block>
  );
}

/** Opis zadania w Markdown — w panelu i w trybie skupienia. */
export function DescriptionEditor({ taskId, readOnly = false }: { taskId: string; readOnly?: boolean }) {
  const { store } = useAppEnv();
  const { run } = useTaskActions();
  const { rows, ms } = useLocalQuery<Row>(store, "select description_md from tasks where id = ?", [taskId], ["tasks"]);
  const saved = (rows[0]?.description_md as string | null) ?? "";
  const editor = useEditor({
    extensions: descriptionExtensions,
    content: "",
    immediatelyRender: false,
    editable: !readOnly,
    editorProps: { attributes: { "aria-label": "Opis zadania" } },
    onBlur: ({ editor: e }) => {
      const markdown = descriptionMarkdown(e).trim();
      if (markdown !== saved.trim()) void run([{ table: "tasks", id: taskId, patch: { description_md: markdown || null } }]);
    },
  });
  useEffect(() => {
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly);
  }, [editor, readOnly]);
  // Treść z bazy, gdy edytor nie ma fokusu (zmiana z innego urządzenia nie przerywa pisania).
  useEffect(() => {
    if (!editor || ms === null || editor.isFocused) return;
    if (descriptionMarkdown(editor).trim() !== saved.trim()) editor.commands.setContent(saved, { contentType: "markdown" });
  }, [editor, saved, ms]);

  return (
    <div className="min-h-16 rounded-md border border-[var(--line)] px-3 py-2 text-sm focus-within:border-[var(--accent)] [&_.tiptap]:min-h-12 [&_.tiptap]:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_pre]:bg-black/10 [&_pre]:p-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_a]:text-[var(--accent)] [&_a]:underline [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0 [&_li[data-type=taskItem]]:flex [&_li[data-type=taskItem]]:gap-2">
      <EditorContent editor={editor} />
    </div>
  );
}

interface Change {
  at: string;
  changes: Record<string, unknown>;
}

/** Historia zmian z serwera (`activity_log`) — tylko online; zmiany offline pojawią się po wysłaniu. */
function History({ taskId, lists, people }: { taskId: string; lists: Map<string, string>; people: Map<string, string> }) {
  const [state, setState] = useState<{ rows: Change[]; error: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void supabaseBrowser()
      .from("activity_log")
      .select("at, changes")
      .eq("row_id", taskId)
      .order("at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => alive && setState({ rows: (data as Change[] | null) ?? [], error: error ? "Historia jest dostępna online." : null }));
    return () => {
      alive = false;
    };
  }, [open, taskId]);

  const value = useMemo(
    () => (field: string, v: unknown): string => {
      if (field === "deleted_at") return v ? "w koszu" : "przywrócone";
      if (field === "assignee_id") return v ? (people.get(String(v)) ?? "usunięty współpracownik") : "twórca zadania";
      if (v === null || v === undefined || v === "") return "—";
      if (field === "status") return TASK_STATUS[v as TaskStatus] ?? String(v);
      if (field === "priority") return PRIORITY[v as Priority]?.label ?? String(v);
      if (field === "list_id") return lists.get(String(v)) ?? "inna lista";
      if (field === "due_date" || field === "start_date") return shortDate(String(v));
      if (field === "due_time") return String(v).slice(0, 5);
      if (field === "completed_at") return new Date(String(v)).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
      if (field === "recurrence" && typeof v === "object") return "zmieniona reguła";
      if (field === "description_md") return "zmieniony";
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    },
    [lists, people],
  );

  return (
    <section className="border-t border-[var(--line)] pt-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-xs font-semibold tracking-wide text-[var(--muted)] uppercase hover:text-[var(--foreground)]">
        {open ? "▾" : "▸"} Historia zmian
      </button>
      {open ? (
        state === null ? (
          <p className="mt-2 text-xs text-[var(--muted)]">Wczytywanie…</p>
        ) : state.error ? (
          <p className="mt-2 text-xs text-[var(--muted)]">{state.error}</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2 text-xs">
            {state.rows.map((row, i) => {
              // Wpis z utworzenia ma wszystkie kolumny — puste pomijamy; kolejność ręczna nie jest „zmianą”.
              const created = "kind" in row.changes && "list_id" in row.changes && "title" in row.changes;
              const fields = Object.entries(row.changes).filter(([f, v]) => f !== "sort_key" && f !== "board_sort_key" && !(created && (v === null || f === "kind" || f === "postpone_count")));
              if (!fields.length) return null;
              return (
                <li key={i}>
                  <span className="text-[var(--muted)]">{new Date(row.at).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}</span>
                  {created ? <span> · utworzono</span> : null}
                  <ul className="pl-3">
                    {fields.map(([f, v]) => (
                      <li key={f}>
                        {TASK_FIELD[f] ?? f}: {value(f, v)}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
            {!state.rows.length ? <li className="text-[var(--muted)]">Brak zapisanych zmian.</li> : null}
          </ol>
        )
      ) : null}
    </section>
  );
}
