"use client";

/**
 * Panel zadania (MVP-2): wszystkie pola zadania, opis w Markdown (TipTap), osoby (odpowiedzialny i uczestnicy — tylko
 * informacyjnie), komentarze, zadanie nadrzędne, podzadania (do 4 poziomów), zależności (poprzednicy / następnicy, M12),
 * tagi, załączniki, przypomnienia, powtarzanie, czas pracy (M14, tylko przy włączonym trybie skupienia), historia zmian
 * (online, z `activity_log`) i kosz — w tej kolejności, tak samo na telefonie. Każda zmiana to
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
  deleteTaskOps,
  descendants,
  endSeriesOps,
  describeRecurrence,
  formatMinutes,
  isOpen,
  LIST_KIND,
  moveTaskOps,
  normalizeText,
  parentCandidates,
  plural,
  PLUGIN_SEND_NOTE,
  pluginRequestOps,
  PRIORITY,
  REMINDER_PRESETS,
  reminderOffset,
  relativeDay,
  removeDependencyOps,
  reparentTaskOps,
  shortDate,
  skipOccurrenceOps,
  TASK_FIELD,
  TASK_STATUS,
  taskLinks,
  tagsForWorkspace,
  MARKDOWN_SHORTCUTS,
  htmlToMarkdown,
  markdownContinueList,
  markdownEdit,
  markdownPaste,
  reorderTaskTagOps,
  taskTagId,
  taskTagOps,
  trashListLabel,
  trashPreview,
  uuidv7,
  type LocalDate,
  type LocalTime,
  type MarkdownAction,
  type MarkdownTextEdit,
  type PastedMarkdown,
  type Priority,
  type Recurrence,
  type TaskLink,
  type TaskStatus,
  type TrashedTask,
  type TrashPreview,
  type ViewTask,
} from "@taskplanner/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { listEditable } from "@/lib/app-data";
import { useDependencies } from "@/lib/dependencies";
import { useLocalQuery } from "@/lib/local-store";
import { usePlugins } from "@/lib/plugins";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { useAssigneeReminderNote, useTaskComments, useTaskDescription, useTaskReminders } from "@/lib/task-details";
import { useTrash } from "@/lib/trash";

import { BreakdownField } from "./ai-breakdown";
import { AppEnvProvider, useAppEnv } from "./app-env";
import { AttachmentsField } from "./attachments";
import { TaskTimeField } from "./focus";
import { MarkdownPreview } from "./markdown-preview";
import { PurgeButton } from "./purge-button";
import { QuickAdd } from "./quick-add";
import { RecurrenceEditor } from "./recurrence-editor";
import { TAG_CHIP, TagColorPicker, tagChipStyle } from "./tag-chip";
import { TaskItem, useTaskActions } from "./task-item";
import { LockedSections, PanelSection, useSectionsLocked } from "./panel-section";
import { TaskPreview } from "./task-preview";
import { Button, CommitInput, EyeIcon, IconButton, Input, inputClass, navLinkClass, Select } from "./ui";

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
 * Część panelu, którą da się zmieniać (wiersz tytułu; sekcje — `EditableSections`). W przestrzeni udostępnionej do
 * podglądu i w koszu `fieldset disabled` wyszarza i blokuje wszystkie pola i przyciski w środku.
 */
function Editable({ readOnly, className = "", children }: { readOnly: boolean; className?: string; children: ReactNode }) {
  return (
    <fieldset disabled={readOnly} className={`m-0 min-w-0 border-0 p-0 disabled:opacity-60 ${className}`}>
      {children}
    </fieldset>
  );
}

/** Sekcje, których treść jest zablokowana w podglądzie — nagłówki (zwijanie) działają dalej. */
function EditableSections({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return <LockedSections value={readOnly}>{children}</LockedSections>;
}

/** Zwijana sekcja panelu; klucz = tytuł bez licznika („Podzadania · 2/3” → „Podzadania”). */
function Block({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const [base, ...count] = title.split(" · ");
  return (
    <PanelSection id={id ?? base} title={base} count={count.join(" · ") || undefined}>
      {children}
    </PanelSection>
  );
}

/**
 * Panel zadania: formularz albo podgląd (`TaskPreview`), przełącznik w nagłówku; zadanie w koszu — ten sam panel
 * tylko do odczytu, z przywróceniem.
 */
export function TaskPanel({ taskId }: { taskId: string }) {
  const { data, openTask } = useAppEnv();
  const task = data.tasks.find((t) => t.id === taskId);

  // Escape zamyka panel (poza polami tekstowymi i edytorem); `preventDefault` — żeby przegląd pod spodem nie wyszedł.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (event.key === "Escape" && !(el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)))) {
        event.preventDefault();
        openTask(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTask]);

  return task ? <TaskFrame task={task} /> : <TrashedTaskPanel taskId={taskId} />;
}

/** Zadanie spoza widoków: w koszu tego urządzenia → podgląd, inaczej komunikat. */
function TrashedTaskPanel({ taskId }: { taskId: string }) {
  const env = useAppEnv();
  const { data, store, openTask } = env;
  const { tasks: trashed, alive, loaded } = useTrash(store, data);
  const preview = useMemo(() => trashPreview(trashed, taskId, alive), [trashed, taskId, alive]);
  // Zadania z kosza obok żywych: sekcje (podzadania, zależności, zadanie nadrzędne) czytają je z `data.tasks`.
  const value = useMemo(() => ({ ...env, data: { ...data, tasks: [...data.tasks, ...trashed] }, trashed: new Map(trashed.map((t) => [t.id, t])) }), [env, data, trashed]);

  if (!preview) {
    return (
      <PanelFrame onClose={() => openTask(null)}>
        <p className="text-sm text-[var(--muted)]">{loaded ? "Tego zadania już nie ma (usunięte na stałe, nie ma go na tym urządzeniu albo jest w zarchiwizowanej liście)." : "Wczytywanie…"}</p>
      </PanelFrame>
    );
  }
  return (
    <AppEnvProvider value={value}>
      <TaskFrame task={preview.task} trash={preview} />
    </AppEnvProvider>
  );
}

/** Ramka panelu z przełącznikiem trybu i treścią wybranego trybu. */
function TaskFrame({ task, trash }: { task: ViewTask; trash?: TrashPreview<TrashedTask> }) {
  const { data, openTask, openTaskMode } = useAppEnv();
  const preview = openTaskMode === "preview";
  const listReadOnly = !listEditable(data, task.listId);
  const editable = !trash && !listReadOnly;
  const label = !preview ? "Podgląd zadania (tylko wypełnione dane)" : editable ? "Edytuj zadanie" : "Wszystkie pola zadania";
  return (
    <PanelFrame
      onClose={() => openTask(null)}
      actions={
        <Button className="px-2 py-0.5 text-xs" title={label} aria-label={label} data-testid="task-mode-switch" onClick={() => openTask(task.id, preview ? "edit" : "preview")}>
          {preview ? (
            editable ? "✎ Edytuj" : "Wszystkie pola"
          ) : (
            <>
              <EyeIcon /> Podgląd
            </>
          )}
        </Button>
      }
    >
      {preview ? (
        <>
          {trash ? <TrashBar preview={trash} readOnly={listReadOnly} /> : null}
          <TaskPreview task={task} trash={trash} />
        </>
      ) : (
        <TaskDetails task={task} trash={trash} />
      )}
    </PanelFrame>
  );
}

/** Pasek zadania w koszu: od kiedy, z czym usunięte i „Przywróć”. */
function TrashBar({ preview, readOnly }: { preview: TrashPreview<TrashedTask>; readOnly: boolean }) {
  const { today, timeZone } = useAppEnv();
  const { run } = useTaskActions();
  const { task, root, parent, count, inside, restore, restoreAlone } = preview;
  return (
    <div className="mb-2 flex flex-col gap-2 rounded-md bg-[var(--hover)] px-2 py-2 text-xs text-[var(--muted)]" data-testid="task-trashed">
      <p>
        🗑️ W koszu od {commentTime(task.deletedAt, today, timeZone)}
        {parent ? ` (usunięte razem z „${root.title}”)` : ""} — tylko podgląd. Żeby coś zmienić, przywróć zadanie.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          kind="primary"
          disabled={readOnly}
          title={count ? `Razem z ${plural(count, ["podzadaniem", "podzadaniami", "podzadaniami"])} usuniętymi naraz` : undefined}
          onClick={() => void run(restore, { text: `Przywrócono „${root.title}”` })}
        >
          {parent ? `Przywróć całość („${root.title.length > 30 ? `${root.title.slice(0, 30)}…` : root.title}”)` : "Przywróć"}
        </Button>
        {restoreAlone ? (
          <Button disabled={readOnly} title="Jako zadanie główne tej samej listy" onClick={() => void run(restoreAlone, { text: `Przywrócono „${task.title}” jako zadanie główne` })}>
            Przywróć tylko to
          </Button>
        ) : null}
        <PurgeButton task={task} inside={inside} />
      </div>
      {readOnly ? <p>Lista jest udostępniona Ci tylko do podglądu — zadania nie da się przywrócić ani usunąć.</p> : null}
    </div>
  );
}

function TaskDetails({ task, trash }: { task: ViewTask; trash?: TrashPreview<TrashedTask> }) {
  const { data, userId, settings, today, timeZone, openTask } = useAppEnv();
  const { run, toggle } = useTaskActions();

  const update = (patch: Record<string, unknown>) => run([{ table: "tasks", id: task.id, patch }]);
  const boardColumnDefs = data.lists.find((l) => l.id === task.listId)?.boardColumns ?? [];
  const parent = task.parentId ? data.tasks.find((t) => t.id === task.parentId) : undefined;
  const children = trash ? trash.children : data.tasks.filter((t) => t.parentId === task.id).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const scopeReadOnly = !canEditScope(data.workspaces.find((w) => w.id === task.workspaceId)?.role);
  const listReadOnly = !listEditable(data, task.listId);
  // Zadanie w koszu: wszystko zablokowane, da się je tylko przywrócić.
  const readOnly = listReadOnly || !!trash;

  const remove = () => {
    const ops = deleteTaskOps(data.tasks, task.id, new Date());
    void run(ops, { text: `„${task.title}” w koszu`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: null } })) });
    openTask(parent?.id ?? null);
  };

  return (
    <>
      {parent ? (
        <button type="button" className="mb-2 block max-w-full truncate text-left text-xs text-[var(--muted)] hover:text-[var(--accent)]" onClick={() => openTask(parent.id)}>
          ↑ {parent.title}
        </button>
      ) : null}
      {trash ? (
        <TrashBar preview={trash} readOnly={listReadOnly} />
      ) : readOnly ? (
        <p className="mb-2 rounded-md bg-[var(--hover)] px-2 py-1 text-xs text-[var(--muted)]" data-testid="task-read-only">
          {scopeReadOnly
            ? `Przestrzeń „${workspaceName.get(task.workspaceId)}” jest udostępniona Ci tylko do podglądu — zadania nie da się zmienić.`
            : `Lista „${data.lists.find((l) => l.id === task.listId)?.name ?? ""}” jest udostępniona Ci tylko do podglądu — zadania nie da się zmienić.`}
        </p>
      ) : null}
      {/* „Wyślij do…” obok tytułu, poza blokadą edycji (wysłać można też zadanie tylko do podglądu). */}
      <div className="flex items-start gap-2">
        <Editable readOnly={readOnly} className="flex flex-1 items-start gap-2">
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
        </Editable>
        {trash ? null : <SendToField taskId={task.id} />}
      </div>
      <EditableSections readOnly={readOnly}>

        <Block id="details" title="Szczegóły">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-3">
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
              {/* Zadanie w koszu: jego listy może już nie być w widokach. */}
              {trash && !data.lists.some((l) => l.id === task.listId) ? <option value={task.listId}>{trashListLabel(trash.task)}</option> : null}
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
        </Block>

        {task.kind === "habit" && !trash ? (
          <Block id="Nawyk" title="Cykliczne">
            <a href={`#/habit/${task.id}`} className={`self-start ${navLinkClass}`}>
              Statystyki, harmonogram i cel →
            </a>
          </Block>
        ) : null}

        <Block title="Opis">
          <DescriptionEditor key={task.id} taskId={task.id} readOnly={readOnly} />
        </Block>

        <PeopleField key={`people:${task.id}`} task={task} />

        <CommentsField key={`com:${task.id}`} task={task} />

        {task.kind === "task" ? <ParentField key={`parent:${task.id}`} task={task} parent={parent} /> : null}
      </EditableSections>

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
            <BreakdownField key={`ai:${task.id}`} task={task} />
          </>
        ) : (
          <p className="text-xs text-[var(--muted)]">Najwyżej 4 poziomy zadań — tu nie można dodać kolejnego.</p>
        )}
      </Block>

      <EditableSections readOnly={readOnly}>
        <DependenciesField key={`dep:${task.id}`} task={task} />

        <TagsField task={task} userId={userId} />
      </EditableSections>

      <AttachmentsField key={`att:${task.id}`} task={task} readOnly={readOnly} />

      <EditableSections readOnly={readOnly}>
        <RemindersField key={`rem:${task.id}`} task={task} />

        <RecurrenceField key={`rec:${task.id}`} task={task} onSave={(patch) => void update(patch)} timeZone={timeZone} today={today} />

        {settings.focus.enabled ? <TaskTimeField task={task} /> : null}
      </EditableSections>

      <History
        key={`hist:${task.id}`}
        taskId={task.id}
        lists={new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${workspaceName.get(l.workspaceId)})` : l.name]))}
        people={new Map(data.collaborators.map((c) => [c.id, c.name]))}
      />

      <div className="mt-4 flex items-center justify-between border-t border-[var(--line)] pt-3 text-xs text-[var(--muted)]">
        <span>Dodano {task.createdAt.startsWith("1970") ? "teraz (jeszcze nie wysłane)" : shortDate(task.createdAt.slice(0, 10))}</span>
        {trash ? null : (
          <Button kind="danger" disabled={readOnly} onClick={remove}>
            Przenieś do kosza
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * „Wyślij do…” (M21): reguły ręczne z aktywnym połączeniem; wybór zapisuje prośbę `plugin_requests`
 * (offline też — wysyłka wychodzi z serwera po synchronizacji). Bez reguł nic nie widać.
 */
function SendToField({ taskId }: { taskId: string }) {
  const { store, userId } = useAppEnv();
  const { run } = useTaskActions();
  const { sendable } = usePlugins(store);
  if (!sendable.length) return null;
  return (
    <Select
      aria-label="Wyślij do…"
      title={PLUGIN_SEND_NOTE}
      value=""
      className="mt-1 w-auto shrink-0 text-xs"
      onChange={(e) => {
        const rule = sendable.find((r) => r.id === e.target.value);
        if (rule) void run(pluginRequestOps(userId, rule.id, [taskId]), { text: `Wysyłka do „${rule.name}” czeka na serwer` });
      }}
    >
      <option value="">Wyślij do…</option>
      {sendable.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </Select>
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
  const all = useMemo(() => (open ? subtaskCandidates(data.tasks, task.id) : []), [open, data.tasks, task.id]);

  const attach = (child: ViewTask) => {
    const result = attachSubtaskOps(data.tasks, task.id, child.id);
    if (!result) return notify("Tego zadania nie można podpiąć (cykl albo więcej niż 4 poziomy).");
    void run(result.ops, { text: `„${child.title}” jest podzadaniem „${task.title}”`, undo: result.undo });
  };

  if (!open) {
    return (
      <Button kind="ghost" onClick={() => setOpen(true)}>
        + Z istniejących…
      </Button>
    );
  }
  return <TaskPicker candidates={all} onPick={attach} onClose={() => setOpen(false)} label="Szukaj zadania do podpięcia" empty="Brak zadań na tej liście, które można podpiąć." />;
}

/**
 * Rodzic zadania: przepięcie pod inne zadanie tej listy albo odpięcie do zadań głównych (core
 * `parentCandidates` / `reparentTaskOps`, z „Cofnij”).
 */
function ParentField({ task, parent }: { task: ViewTask; parent: ViewTask | undefined }) {
  const { data } = useAppEnv();
  const { run, notify } = useTaskActions();
  const [open, setOpen] = useState(false);
  const all = useMemo(() => (open ? parentCandidates(data.tasks, task.id) : []), [open, data.tasks, task.id]);

  const move = (to: ViewTask | null) => {
    const result = reparentTaskOps(data.tasks, task.id, to?.id ?? null);
    if (!result) return notify("Tu nie można przepiąć zadania (cykl albo więcej niż 4 poziomy).");
    void run(result.ops, { text: to ? `„${task.title}” jest podzadaniem „${to.title}”` : `„${task.title}” jest zadaniem głównym`, undo: result.undo });
    setOpen(false);
  };

  return (
    <Block title="Zadanie nadrzędne">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate" data-testid="task-parent">
          {parent ? parent.title : <span className="text-[var(--muted)]">— (zadanie główne)</span>}
        </span>
        {open ? null : (
          <Button kind="ghost" onClick={() => setOpen(true)}>
            {parent ? "Przepnij…" : "Przypnij do zadania…"}
          </Button>
        )}
        {parent ? (
          <Button kind="ghost" onClick={() => move(null)}>
            Odepnij
          </Button>
        ) : null}
      </div>
      {open ? <TaskPicker candidates={all} onPick={move} onClose={() => setOpen(false)} label="Szukaj zadania nadrzędnego" empty="Brak zadań na tej liście, pod które można przepiąć." /> : null}
    </Block>
  );
}

/** Wyszukiwarka zadania z listy kandydatów (8 pierwszych pasujących; Enter = pierwsze, Esc = zamknij). */
function TaskPicker({ candidates: all, onPick, onClose, label, empty }: { candidates: readonly ViewTask[]; onPick: (task: ViewTask) => void; onClose: () => void; label: string; empty: string }) {
  const { data } = useAppEnv();
  const [query, setQuery] = useState("");
  const needle = normalizeText(query.trim());
  const candidates = (needle ? all.filter((t) => normalizeText(t.title).includes(needle)) : all).slice(0, 8);
  const pick = (t: ViewTask) => {
    onPick(t);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj zadania na tej liście"
          aria-label={label}
          className="min-w-0 flex-1"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            } else if (e.key === "Enter" && candidates[0]) pick(candidates[0]);
          }}
        />
        <Button kind="ghost" onClick={onClose}>
          Anuluj
        </Button>
      </div>
      {candidates.length ? (
        <ul className="rounded-md border border-[var(--line)] text-sm" aria-label={label}>
          {candidates.map((t) => (
            <li key={t.id}>
              <button type="button" className="block w-full truncate px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/10" onClick={() => pick(t)}>
                {t.title}
                {t.parentId ? <span className="ml-2 text-xs text-[var(--muted)]">↳ {data.tasks.find((p) => p.id === t.parentId)?.title ?? ""}</span> : null}
                {t.dueDate ? <span className="ml-2 text-xs text-[var(--muted)]">{shortDate(t.dueDate)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--muted)]">{needle ? "Brak otwartych zadań o takim tytule na tej liście." : empty}</p>
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
  const comments = useTaskComments(store, task.id);
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

const PANEL_WIDTH_KEY = "tp-task-panel-width";
const PANEL_FULL_KEY = "tp-task-panel-full";
const PANEL_WIDTH = { default: 512, min: 384, max: 960 };

/** Szerokość panelu (px) w granicach: nie mniej niż `min` i tak, by obok został widok (~34rem na menu i listę). */
function clampPanelWidth(width: number) {
  const room = typeof window === "undefined" ? PANEL_WIDTH.max : window.innerWidth - 544;
  return Math.round(Math.max(PANEL_WIDTH.min, Math.min(width, PANEL_WIDTH.max, room)));
}

function storedPanelWidth() {
  try {
    const value = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return value > 0 ? value : PANEL_WIDTH.default;
  } catch {
    return PANEL_WIDTH.default;
  }
}

/**
 * Panel po prawej (na telefonie pełny ekran). Na szerokim ekranie lewą krawędź da się przeciągnąć
 * (albo strzałkami po jej zaznaczeniu) — szerokość zostaje w `localStorage`, dwuklik przywraca domyślną.
 */
function PanelFrame({ onClose, actions, children }: { onClose: () => void; actions?: ReactNode; children: ReactNode }) {
  const [width, setWidth] = useState(storedPanelWidth);
  // Pełny widok: panel zajmuje miejsce widoku (do menu po lewej), sekcje jako kafelki obok siebie.
  const [full, setFull] = useState(() => {
    try {
      return localStorage.getItem(PANEL_FULL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleFull = () => {
    setFull(!full);
    try {
      localStorage.setItem(PANEL_FULL_KEY, full ? "0" : "1");
    } catch {}
  };
  const save = (value: number) => {
    const next = clampPanelWidth(value);
    setWidth(next);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(next));
    } catch {}
  };

  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = clampPanelWidth(width);
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => save(startWidth + startX - e.clientX);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    // `data-task-panel="full"` ukrywa <main> obok (reguła `:has` w shell.tsx).
    <div data-task-panel={full ? "full" : ""} className={`fixed inset-0 z-30 flex bg-[var(--background)] lg:static lg:z-auto lg:border-l lg:border-[var(--line)] ${full ? "lg:min-w-0 lg:flex-1" : "lg:shrink-0"}`}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Szerokość panelu zadania"
        aria-valuenow={clampPanelWidth(width)}
        aria-valuemin={PANEL_WIDTH.min}
        aria-valuemax={PANEL_WIDTH.max}
        tabIndex={0}
        title="Przeciągnij, aby zmienić szerokość (dwuklik — domyślna)"
        className={`-ml-px hidden w-1.5 shrink-0 cursor-col-resize touch-none hover:bg-[var(--accent)]/30 focus-visible:bg-[var(--accent)]/30 focus-visible:outline-none active:bg-[var(--accent)]/40 ${full ? "" : "lg:block"}`}
        onPointerDown={drag}
        onDoubleClick={() => save(PANEL_WIDTH.default)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            save(clampPanelWidth(width) + (e.key === "ArrowLeft" ? 32 : -32));
          }
        }}
      />
      <aside
        aria-label="Zadanie"
        className={`@container min-w-0 flex-1 overflow-y-auto p-4 lg:p-5 ${full ? "" : "lg:w-[var(--tp-panel-width)] lg:flex-none"}`}
        style={{ "--tp-panel-width": `${clampPanelWidth(width)}px` } as CSSProperties}
      >
        <div className="mb-1 flex items-center justify-end gap-1">
          {actions ? <span className="mr-auto">{actions}</span> : null}
          <IconButton label={full ? "Zwykły panel" : "Pełny widok — wszystkie sekcje obok siebie"} className="hidden lg:inline-flex" aria-pressed={full} onClick={toggleFull}>
            {full ? "⤡" : "⤢"}
          </IconButton>
          <IconButton label="Zamknij panel (Esc)" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        {/* Kafelki: sekcje (też z <fieldset>, który znika z układu przez `contents`) zawijają się w kolumny ≥ 22rem; reszta na całą szerokość. */}
        <div
          className={
            full
              ? "lg:grid lg:grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] lg:items-start lg:gap-x-4 lg:[&>*:not(section)]:col-span-full lg:[&>fieldset]:contents lg:[&>fieldset>*:not(section)]:col-span-full"
              : ""
          }
        >
          {children}
        </div>
      </aside>
    </div>
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
      className="field-sizing-content min-w-0 flex-1 resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold outline-none hover:border-[var(--line)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:hover:border-transparent"
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
  // Tag, któremu wybieramy kolor (klik w kropkę na chipie).
  const [coloring, setColoring] = useState<string | null>(null);
  // Przeciąganie chipów zmienia kolejność tagów zadania (pierwszy kolorowy = kolor karteczki).
  const [dragged, setDragged] = useState<number | null>(null);
  // W podglądzie chipów nie da się przeciągać (`fieldset disabled` nie blokuje przeciągania).
  const sortable = !useSectionsLocked() && task.tagIds.length > 1;
  const byId = new Map(data.tags.map((t) => [t.id, t]));
  const colored = coloring && task.tagIds.includes(coloring) ? byId.get(coloring) : undefined;
  // Cudzy tag (kopia z przestrzeni) — bez zmiany koloru, zmienia go autor.
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
        {task.tagIds.map((id, index) => (
          <span
            key={id}
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs ${TAG_CHIP} ${sortable ? "cursor-grab" : ""} ${dragged === index ? "opacity-50" : ""}`}
            style={tagChipStyle(byId.get(id)?.color)}
            draggable={sortable}
            title={sortable ? "Przeciągnij, aby zmienić kolejność — pierwszy kolorowy tag nadaje kolor karteczce" : undefined}
            data-testid="task-tag-chip"
            onDragStart={(e) => {
              setDragged(index);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", id);
            }}
            onDragEnd={() => setDragged(null)}
            onDragOver={(e) => {
              if (dragged !== null) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragged !== null && dragged !== index) void run(reorderTaskTagOps(task.id, task.tagIds, dragged, index));
              setDragged(null);
            }}
          >
            {byId.get(id)?.shared ? null : (
            <button
              type="button"
              aria-label={`Kolor tagu ${byId.get(id)?.name ?? ""}`}
              aria-expanded={coloring === id}
              title="Kolor tagu"
              className="h-2.5 w-2.5 shrink-0 rounded-full border border-current"
              style={{ background: byId.get(id)?.color ?? "transparent" }}
              onClick={() => setColoring((c) => (c === id ? null : id))}
            />
            )}
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
      {colored ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="tag-color">
          <span className="text-[var(--muted)]">Kolor @{colored.name}:</span>
          <TagColorPicker
            value={colored.color}
            label={`Kolor tagu ${colored.name}`}
            onChange={(color) => {
              void run([{ table: "tags", id: colored.id, patch: { color } }]);
              setColoring(null);
            }}
          />
        </div>
      ) : null}
    </Block>
  );
}

function RemindersField({ task }: { task: ViewTask }) {
  const { store, data, today, userId } = useAppEnv();
  const { run } = useTaskActions();
  const rows = useTaskReminders(store, task.id, today, userId);
  const note = useAssigneeReminderNote(store, data, task, userId);
  const [choice, setChoice] = useState("");
  const [at, setAt] = useState({ date: task.dueDate ?? "", time: "09:00" });

  const add = (patch: Record<string, unknown>) => void run([{ table: "reminders", id: uuidv7(), patch: { task_id: task.id, offset_min: null, at_date: null, at_time: null, ...patch } }]);

  return (
    <Block title="Przypomnienia">
      <ul className="mb-2 flex flex-col gap-1 text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            <span>🔔 {r.label}</span>
            <IconButton label="Usuń przypomnienie" onClick={() => void run([{ table: "reminders", id: r.id, patch: { deleted_at: new Date().toISOString() } }])}>
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
      {note ? <p className="mt-1 text-xs text-[var(--muted)]">{note}</p> : null}
    </Block>
  );
}

/** Tryb opisu zapamiętany na urządzeniu: tekst Markdown albo podgląd. */
const DESCRIPTION_MODE_KEY = "tp-description-mode";

/** Przyciski formatowania nad polem Markdown (grupy rozdziela `sep`). */
const FORMAT_BUTTONS: { action: MarkdownAction; label: string; icon: ReactNode; sep?: true }[] = [
  { action: "bold", label: "Pogrubienie (Ctrl+B)", icon: <b>B</b> },
  { action: "italic", label: "Kursywa (Ctrl+I)", icon: <i className="font-serif">I</i> },
  { action: "strike", label: "Przekreślenie", icon: <s>S</s> },
  { action: "heading", label: "Nagłówek", icon: <b>H</b> },
  { action: "quote", label: "Cytat", icon: "❝", sep: true },
  { action: "code", label: "Kod (kilka linii = blok kodu)", icon: <span className="font-mono text-[11px]">{"</>"}</span> },
  { action: "link", label: "Link (Ctrl+K)", icon: "🔗" },
  { action: "bullet", label: "Lista punktowana", icon: "•", sep: true },
  { action: "numbered", label: "Lista numerowana", icon: <span className="text-[11px]">1.</span> },
  { action: "task", label: "Lista zadań", icon: "☑" },
  { action: "table", label: "Tabela", icon: "▦", sep: true },
  { action: "rule", label: "Linia pozioma", icon: "―" },
];

/** Podmiana w polu tekstowym przez `insertText` — zostaje w historii „Cofnij” (Ctrl+Z) przeglądarki. */
function applyTextEdit(area: HTMLTextAreaElement, edit: MarkdownTextEdit, setText: (text: string) => void) {
  area.focus();
  area.setSelectionRange(edit.from, edit.to);
  const done = edit.insert ? document.execCommand("insertText", false, edit.insert) : edit.from === edit.to || document.execCommand("delete");
  if (!done) {
    area.setRangeText(edit.insert, edit.from, edit.to);
    setText(area.value);
  }
  area.setSelectionRange(edit.selStart, edit.selEnd);
}

/**
 * Opis zadania w Markdown — w panelu i w trybie skupienia. Edycja = tekst źródłowy (GFM) z przyciskami
 * formatowania (core `markdownEdit`, skróty Ctrl+B/I/K, Enter kontynuuje listę), przełącznik „Podgląd”
 * pokazuje wynik, „⛶” otwiera opis na pełnym ekranie (Esc wraca). Zapis przy opuszczeniu pola.
 * Wklejanie z formatowaniem (core `htmlToMarkdown`): przycisk „📋” czyta schowek, a po zwykłym Ctrl+V
 * sformatowanego tekstu pod polem jest „Zamień na Markdown” (działa też bez zgody na odczyt schowka).
 */
export function DescriptionEditor({ taskId, readOnly = false }: { taskId: string; readOnly?: boolean }) {
  const { store } = useAppEnv();
  const { run } = useTaskActions();
  const saved = useTaskDescription(store, taskId);
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(false);
  const [previewPref, setPreviewPref] = useState(() => {
    try {
      return localStorage.getItem(DESCRIPTION_MODE_KEY) === "preview";
    } catch {
      return false;
    }
  });
  const preview = previewPref || readOnly;
  // Treść z bazy, gdy nikt nie pisze (zmiana z innego urządzenia nie przerywa pisania).
  if (!editing && saved !== base) {
    setBase(saved);
    setDraft(saved);
  }

  const latest = useRef({ draft, saved, readOnly, run });
  useEffect(() => {
    latest.current = { draft, saved, readOnly, run };
  });
  const save = useCallback(() => {
    const { draft: text, saved: stored, readOnly: locked, run: write } = latest.current;
    const markdown = text.trim();
    if (!locked && markdown !== stored.trim()) void write([{ table: "tasks", id: taskId, patch: { description_md: markdown || null } }]);
  }, [taskId]);
  // Zamknięcie panelu w trakcie pisania (bez `blur`) też zapisuje.
  useEffect(() => save, [save]);

  const setPreview = (value: boolean) => {
    save();
    setPreviewPref(value);
    try {
      localStorage.setItem(DESCRIPTION_MODE_KEY, value ? "preview" : "markdown");
    } catch {
      // Bez `localStorage` tryb zostaje tylko do przeładowania.
    }
  };
  const closeFull = useCallback(() => {
    save();
    // Pole na pełnym ekranie znika z fokusem, bez `blur`.
    setEditing(false);
    setFull(false);
  }, [save]);
  useEffect(() => {
    if (!full) return;
    // Esc zamyka pełny ekran, a nie panel zadania (nasłuch w fazie przechwytywania).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeFull();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full, closeFull]);

  const area = useRef<HTMLTextAreaElement>(null);
  const format = (action: MarkdownAction) => {
    const el = area.current;
    if (el) applyTextEdit(el, markdownEdit(el.value, el.selectionStart, el.selectionEnd, action), setDraft);
  };
  const onAreaKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && MARKDOWN_SHORTCUTS[e.key.toLowerCase()]) {
      e.preventDefault();
      format(MARKDOWN_SHORTCUTS[e.key.toLowerCase()]!);
    } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing && el.selectionStart === el.selectionEnd) {
      const edit = markdownContinueList(el.value, el.selectionStart);
      if (edit) {
        e.preventDefault();
        applyTextEdit(el, edit, setDraft);
      }
    }
  };

  // Ostatnio wklejony tekst, który da się zamienić na Markdown — do pierwszej zmiany treści.
  const [pasted, setPasted] = useState<{ text: string; from: number; to: number; result: PastedMarkdown } | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const insertText = (el: HTMLTextAreaElement, from: number, to: number, insert: string) =>
    applyTextEdit(el, { from, to, insert, selStart: from + insert.length, selEnd: from + insert.length }, setDraft);
  const onAreaPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    setPasteNote(null);
    setPasted(null);
    const html = e.clipboardData.getData("text/html");
    const result = html ? htmlToMarkdown(html) : null;
    const plain = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!result?.formatted || !plain) return;
    e.preventDefault();
    const from = Math.min(el.selectionStart, el.selectionEnd);
    insertText(el, from, Math.max(el.selectionStart, el.selectionEnd), plain);
    setPasted({ text: el.value, from, to: from + plain.length, result });
  };
  const convertPasted = () => {
    const el = area.current;
    if (el && pasted && el.value === pasted.text) applyTextEdit(el, markdownPaste(el.value, pasted.from, pasted.to, pasted.result), setDraft);
    setPasted(null);
  };
  const pasteFormatted = async () => {
    const el = area.current;
    if (!el) return;
    setPasteNote(null);
    setPasted(null);
    let html = "";
    let plain = "";
    try {
      // Chrome: bez czyszczenia HTML zostają listy Worda; inne przeglądarki pomijają opcję.
      const read = navigator.clipboard.read as (options?: { unsanitized: string[] }) => Promise<ClipboardItem[]>;
      for (const item of await read.call(navigator.clipboard, { unsanitized: ["text/html"] })) {
        if (!html && item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
        if (!plain && item.types.includes("text/plain")) plain = await (await item.getType("text/plain")).text();
      }
    } catch {
      setPasteNote("Przeglądarka nie dała dostępu do schowka — wklej przez Ctrl+V, a potem wybierz „Zamień na Markdown” pod polem.");
      return;
    }
    // Okno zgody mogło zabrać fokus, a w tym czasie panel mógł się zamknąć.
    if (!el.isConnected) return;
    const result = html ? htmlToMarkdown(html) : null;
    // Bez formatowania lepszy jest zwykły tekst (np. skopiowane źródło Markdown — bez ukośników).
    if (result && (result.formatted || !plain)) applyTextEdit(el, markdownPaste(el.value, el.selectionStart, el.selectionEnd, result), setDraft);
    else if (plain) insertText(el, el.selectionStart, el.selectionEnd, plain.replace(/\r\n?/g, "\n"));
    else setPasteNote("W schowku nie ma tekstu.");
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1">
      {readOnly ? null : (
        <div className="inline-flex rounded-md border border-[var(--line)] p-0.5 text-xs" role="group" aria-label="Tryb opisu">
          {([false, true] as const).map((p) => (
            <button
              key={String(p)}
              type="button"
              aria-pressed={preview === p}
              onClick={() => setPreview(p)}
              className={`rounded px-2 py-0.5 ${preview === p ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:bg-[var(--hover)]"}`}
            >
              {p ? "Podgląd" : "Markdown"}
            </button>
          ))}
        </div>
      )}
      {preview ? null : (
        <div className="flex flex-wrap items-center" role="toolbar" aria-label="Formatowanie opisu">
          {FORMAT_BUTTONS.map((b) => (
            <span key={b.action} className="contents">
              {b.sep ? <span aria-hidden className="mx-1 h-4 w-px bg-[var(--line)]" /> : null}
              {/* `mousedown` bez domyślnej akcji: pole nie traci fokusu (ani zaznaczenia) przy kliknięciu. */}
              <IconButton label={b.label} onMouseDown={(e) => e.preventDefault()} onClick={() => format(b.action)}>
                {b.icon}
              </IconButton>
            </span>
          ))}
          <span aria-hidden className="mx-1 h-4 w-px bg-[var(--line)]" />
          <IconButton label="Wklej z formatowaniem (zamiana na Markdown)" onMouseDown={(e) => e.preventDefault()} onClick={() => void pasteFormatted()}>
            📋
          </IconButton>
        </div>
      )}
      <span className="flex-1" />
      {full ? (
        <Button kind="ghost" className="text-xs" onClick={closeFull}>
          ✕ Zamknij (Esc)
        </Button>
      ) : (
        <IconButton label="Pełny ekran" onClick={() => setFull(true)}>
          ⛶
        </IconButton>
      )}
    </div>
  );

  const body = (fullScreen: boolean) =>
    preview ? (
      <div className={`rounded-md border border-[var(--line)] px-3 py-2 ${fullScreen ? "min-h-0 flex-1 overflow-auto" : "min-h-16"}`}>
        <MarkdownPreview markdown={draft} onEdit={readOnly ? undefined : () => setPreview(false)} />
      </div>
    ) : (
      <textarea
        ref={area}
        value={draft}
        autoFocus={fullScreen}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onAreaKey}
        onPaste={onAreaPaste}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          save();
          setEditing(false);
        }}
        spellCheck
        aria-label="Opis zadania (Markdown)"
        placeholder={"Opis w Markdown: **pogrubienie**, *kursywa*, - lista, - [ ] zadanie, [link](https://…), # nagłówek"}
        className={`${inputClass} w-full font-mono text-[13px] leading-relaxed ${fullScreen ? "min-h-0 flex-1 resize-none" : "min-h-24 resize-y [field-sizing:content]"}`}
        rows={fullScreen ? undefined : 4}
      />
    );

  const offer = !preview && pasted?.text === draft;
  const pasteBar =
    preview || (!offer && !pasteNote) ? null : (
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]" role="status" data-testid="description-paste">
        <span>{offer ? "Wklejono zwykły tekst." : pasteNote}</span>
        {offer ? (
          <Button className="px-2 py-0.5 text-xs" onMouseDown={(e) => e.preventDefault()} onClick={convertPasted}>
            Zamień na Markdown
          </Button>
        ) : null}
        <IconButton
          label="Ukryj"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setPasted(null);
            setPasteNote(null);
          }}
        >
          ✕
        </IconButton>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      {full ? <p className="text-xs text-[var(--muted)]">Opis jest otwarty na pełnym ekranie.</p> : (
        <>
          {toolbar}
          {body(false)}
          {pasteBar}
        </>
      )}
      {full
        ? createPortal(
            <div className="fixed inset-0 z-50 flex flex-col bg-[var(--background)] p-4" role="dialog" aria-modal="true" aria-label="Opis zadania — pełny ekran" data-testid="description-full">
              <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3">
                {toolbar}
                {body(true)}
                {pasteBar}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface Change {
  at: string;
  changes: Record<string, unknown>;
}

/** Historia zmian z serwera (`activity_log`) — tylko online; zmiany offline pojawią się po wysłaniu. */
function History(props: { taskId: string; lists: Map<string, string>; people: Map<string, string> }) {
  return (
    <PanelSection id="history" title="Historia zmian" defaultCollapsed>
      <HistoryRows {...props} />
    </PanelSection>
  );
}

/** Wpisy `activity_log` — pobierane dopiero po rozwinięciu sekcji (zwinięta nie renderuje treści). */
function HistoryRows({ taskId, lists, people }: { taskId: string; lists: Map<string, string>; people: Map<string, string> }) {
  const [state, setState] = useState<{ rows: Change[]; error: string | null } | null>(null);
  useEffect(() => {
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
  }, [taskId]);

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

  return state === null ? (
    <p className="text-xs text-[var(--muted)]">Wczytywanie…</p>
  ) : state.error ? (
    <p className="text-xs text-[var(--muted)]">{state.error}</p>
  ) : (
          <ol className="flex flex-col gap-2 text-xs">
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
  );
}
