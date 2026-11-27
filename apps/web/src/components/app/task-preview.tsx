"use client";

/**
 * Podgląd zadania (ikona oka w wierszu listy, „Podgląd” w nagłówku panelu): podsumowanie bez formularza, tylko
 * wypełnione dane — z podzadaniami, zależnościami, tagami, osobami, przypomnieniami, załącznikami i komentarzami.
 * Powiązane zadania otwierają się też w podglądzie; do formularza przechodzi się przyciskiem „Edytuj” (`TaskFrame`).
 */
import {
  assigneeOf,
  commentAuthor,
  commentTime,
  describeHabit,
  describeRecurrence,
  formatMinutes,
  isOpen,
  LIST_KIND,
  plural,
  PRIORITY,
  relativeDay,
  shortDate,
  TASK_SECTION_ICON,
  TASK_STATUS,
  taskBoardColumn,
  taskLinks,
  toHabit,
  trashListLabel,
  type TaskLink,
  type TrashedTask,
  type TrashPreview,
  type ViewTask,
} from "@taskplanner/core";
import { useMemo, type ReactNode } from "react";

import { useDependencies } from "@/lib/dependencies";
import { routeHash } from "@/lib/route";
import { useTaskComments, useTaskDescription, useTaskReminders } from "@/lib/task-details";

import { useAppEnv } from "./app-env";
import { AttachmentsSummary, useAttachmentCount } from "./attachments";
import { useFocus } from "./focus";
import { MarkdownPreview } from "./markdown-preview";
import { TAG_CHIP, tagChipStyle } from "./tag-chip";

/** Kółko stanu w kolorze priorytetu — sam znak, bez odhaczania. */
function StatusMark({ task, size = "h-4 w-4 text-[10px]" }: { task: ViewTask; size?: string }) {
  const color = PRIORITY[task.priority].color;
  const done = task.status === "done";
  return (
    <span
      role="img"
      aria-label={TASK_STATUS[task.status]}
      title={TASK_STATUS[task.status]}
      className={`flex shrink-0 items-center justify-center rounded-full border-2 leading-none text-white ${size}`}
      style={{ borderColor: color, background: done ? color : "transparent" }}
    >
      {done ? "✓" : task.status === "cancelled" ? <span style={{ color }}>–</span> : ""}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs leading-5 text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Part({ icon, title, count, children }: { icon: string; title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-4 border-t border-[var(--line)] pt-3" data-preview-section={title}>
      <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-[var(--foreground)]/75">
        <span aria-hidden>{TASK_SECTION_ICON[icon]}</span>
        {title}
        {count ? <span className="font-normal text-[var(--muted)]">· {count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** Zadanie na liście podglądu — klik otwiera jego podgląd. */
function TaskLine({ task, note }: { task: ViewTask; note?: ReactNode }) {
  const { openTask, today } = useAppEnv();
  const open = isOpen(task);
  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      <span className="mt-0.5">
        <StatusMark task={task} />
      </span>
      <button type="button" className={`min-w-0 flex-1 text-left break-words hover:text-[var(--accent)] ${open ? "" : "text-[var(--muted)] line-through"}`} onClick={() => openTask(task.id, "preview")}>
        {task.title}
      </button>
      {note}
      {task.dueDate ? <span className={`shrink-0 text-xs leading-5 ${open && task.dueDate < today ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{relativeDay(task.dueDate, today)}</span> : null}
    </div>
  );
}

/** Drzewo podzadań (do 4 poziomów). */
function Subtasks({ tasks, childrenOf }: { tasks: readonly ViewTask[]; childrenOf: (id: string) => readonly ViewTask[] }) {
  return (
    <ul>
      {tasks.map((t) => {
        const inner = childrenOf(t.id);
        return (
          <li key={t.id}>
            <TaskLine task={t} />
            {inner.length ? (
              <div className="ml-2 border-l border-[var(--line)] pl-4">
                <Subtasks tasks={inner} childrenOf={childrenOf} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const bySortKey = (a: ViewTask, b: ViewTask) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
const NONE: readonly ViewTask[] = [];

export function TaskPreview({ task, trash }: { task: ViewTask; trash?: TrashPreview<TrashedTask> }) {
  const { store, data, userId, settings, today, timeZone, openTask } = useAppEnv();
  const description = useTaskDescription(store, task.id);
  const comments = useTaskComments(store, task.id);
  const reminders = useTaskReminders(store, task.id, today, userId);
  const attachments = useAttachmentCount(task.id);
  const deps = useDependencies(store);
  const links = useMemo(() => taskLinks(task.id, data.tasks, deps), [task.id, data.tasks, deps]);
  const focus = useFocus();
  const spent = settings.focus.enabled ? focus.spent(task.id) : 0;

  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  // W koszu: tylko podzadania usunięte razem z zadaniem (osobno usunięte są osobnymi pozycjami kosza).
  const childrenOf = (id: string): readonly ViewTask[] => (trash ? NONE : data.tasks.filter((t) => t.parentId === id).sort(bySortKey));
  const children = trash ? trash.children : childrenOf(task.id);
  const counted = children.filter((c) => c.status !== "cancelled");

  const list = data.lists.find((l) => l.id === task.listId);
  const workspace = data.workspaces.find((w) => w.id === task.workspaceId)?.name;
  const boardColumns = list?.boardColumns ?? [];
  const columnId = taskBoardColumn(task, boardColumns);
  const column = columnId ? boardColumns.find((c) => c.id === columnId)?.name : undefined;
  const assignee = assigneeOf(task.assigneeId, data.collaborators);
  const participants = (data.participants.get(task.id) ?? []).flatMap((id) => data.collaborators.find((c) => c.id === id)?.name ?? []);
  const tags = task.tagIds.flatMap((id) => data.tags.find((t) => t.id === id) ?? []);
  const habit = task.kind === "habit" ? toHabit(task) : null;
  const overdue = isOpen(task) && task.dueDate !== null && task.dueDate < today;

  const linkLines = (items: readonly TaskLink[]) =>
    items.map((link) => {
      const other = byId.get(link.otherId);
      if (!other) return null;
      return (
        <li key={link.dependency.id}>
          <TaskLine
            task={other}
            note={
              <>
                {link.violation ? <span className="shrink-0 text-xs leading-5 text-[var(--danger)]">⚠ {plural(link.violation.days, ["dzień", "dni", "dni"])} za wcześnie</span> : null}
                {link.dependency.lagDays ? <span className="shrink-0 text-xs leading-5 text-[var(--muted)]">odstęp {plural(link.dependency.lagDays, ["dzień", "dni", "dni"])}</span> : null}
              </>
            }
          />
        </li>
      );
    });

  return (
    <div className="max-w-3xl" data-testid="task-preview">
      {parent ? (
        <button type="button" className="mb-2 block max-w-full truncate text-left text-xs text-[var(--muted)] hover:text-[var(--accent)]" onClick={() => openTask(parent.id, "preview")}>
          ↑ {parent.title}
        </button>
      ) : null}
      <div className="flex items-start gap-2">
        <span className="mt-1">
          <StatusMark task={task} size="h-5 w-5 text-xs" />
        </span>
        <h2 className={`min-w-0 flex-1 text-lg leading-7 font-semibold break-words ${task.status === "done" ? "text-[var(--muted)] line-through" : ""}`}>{task.title}</h2>
      </div>

      <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <Fact label="Status">
          {TASK_STATUS[task.status]}
          {task.completedAt && !isOpen(task) ? <span className="text-[var(--muted)]"> · {commentTime(task.completedAt, today, timeZone)}</span> : null}
        </Fact>
        <Fact label="Priorytet">
          <span style={{ color: PRIORITY[task.priority].color }}>{PRIORITY[task.priority].label}</span>
        </Fact>
        <Fact label="Lista">
          {list && !trash ? (
            <a href={routeHash({ view: "list", id: list.id })} className="hover:text-[var(--accent)] hover:underline">
              {list.kind === "inbox" ? "Inbox" : list.name}
            </a>
          ) : trash ? (
            trashListLabel(trash.task, list?.name)
          ) : (
            "—"
          )}
          {list ? <span className="text-[var(--muted)]">{[list.kind === "inbox" ? null : LIST_KIND[list.kind], workspace].filter(Boolean).map((text) => ` · ${text}`)}</span> : null}
        </Fact>
        {column ? <Fact label="Kolumna tablicy">{column}</Fact> : null}
        {task.startDate ? <Fact label="Początek">{relativeDay(task.startDate, today)}</Fact> : null}
        {task.dueDate ? (
          <Fact label="Termin">
            <span className={overdue ? "font-medium text-[var(--danger)]" : ""}>
              {shortDate(task.dueDate)}
              {task.dueTime ? `, ${task.dueTime}` : ""}
            </span>
            <span className="text-[var(--muted)]"> · {relativeDay(task.dueDate, today, "distance")}</span>
          </Fact>
        ) : null}
        {task.durationMin ? <Fact label="Czas">{formatMinutes(task.durationMin)}</Fact> : null}
        {spent ? <Fact label="Czas pracy">{formatMinutes(spent)}</Fact> : null}
        {habit ? (
          <Fact label="Nawyk">
            {describeHabit(habit)}
            {trash ? null : (
              <>
                {" · "}
                <a href={routeHash({ view: "habit", id: task.id })} className="text-[var(--accent)] hover:underline">
                  statystyki
                </a>
              </>
            )}
          </Fact>
        ) : task.recurrence ? (
          <Fact label="Powtarzanie">↻ {describeRecurrence(task.recurrence)}</Fact>
        ) : null}
        {reminders.length ? (
          <Fact label="Przypomnienia">
            <ul>
              {reminders.map((r) => (
                <li key={r.id}>🔔 {r.label}</li>
              ))}
            </ul>
          </Fact>
        ) : null}
        {assignee ? <Fact label="Odpowiedzialny">{assignee.name}</Fact> : null}
        {participants.length ? <Fact label="Uczestnicy">{participants.join(", ")}</Fact> : null}
        {tags.length ? (
          <Fact label="Tagi">
            <span className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span key={t.id} className={`max-w-full truncate px-2 py-0.5 text-xs ${TAG_CHIP}`} style={tagChipStyle(t.color)}>
                  {t.name}
                </span>
              ))}
            </span>
          </Fact>
        ) : null}
      </dl>

      {description.trim() ? (
        <Part icon="Opis" title="Opis">
          <MarkdownPreview markdown={description} />
        </Part>
      ) : null}

      {children.length ? (
        <Part icon="Podzadania" title="Podzadania" count={`${counted.filter((c) => c.status === "done").length}/${counted.length}`}>
          <Subtasks tasks={children} childrenOf={childrenOf} />
        </Part>
      ) : null}

      {links.predecessors.length ? (
        <Part icon="Zależności" title="Czeka na">
          <ul>{linkLines(links.predecessors)}</ul>
        </Part>
      ) : null}
      {links.successors.length ? (
        <Part icon="Zależności" title="Blokuje">
          <ul>{linkLines(links.successors)}</ul>
        </Part>
      ) : null}

      {attachments ? (
        <Part icon="attachments" title="Załączniki" count={attachments}>
          <AttachmentsSummary taskId={task.id} />
        </Part>
      ) : null}

      {comments.length ? (
        <Part icon="Komentarze" title="Komentarze" count={comments.length}>
          <ol className="flex flex-col gap-3">
            {comments.map((c) => (
              <li key={c.id} className="text-sm">
                <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span className="font-medium text-[var(--foreground)]">{commentAuthor(c.authorId, userId)}</span>
                  <span>{commentTime(c.postedAt, today, timeZone)}</span>
                  {c.editedAt ? <span title={`Edytowano ${commentTime(c.editedAt, today, timeZone)}`}>(edytowano)</span> : null}
                </div>
                <p className="mt-0.5 break-words whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ol>
        </Part>
      ) : null}

      <p className="mt-4 border-t border-[var(--line)] pt-3 text-xs text-[var(--muted)]">Dodano {task.createdAt.startsWith("1970") ? "teraz (jeszcze nie wysłane)" : shortDate(task.createdAt.slice(0, 10))}</p>
    </div>
  );
}
