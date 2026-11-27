"use client";

/** Dane jednego zadania z lokalnej bazy — wspólne dla formularza (`task-panel.tsx`) i podglądu (`task-preview.tsx`). */
import { assigneeOf, assigneeReminderNote, canSetOwnReminder, relativeDay, reminderOffset, responsibleAccount, sortComments, type AutoReminderPrefs, type LocalDate, type ViewTask } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import { listEditable, type AppData } from "./app-data";
import { useLocalQuery } from "./local-store";

type Row = Record<string, string | number | null>;

export function useTaskDescription(store: TabStore, taskId: string): string {
  const { rows } = useLocalQuery<Row>(store, "select description_md from tasks where id = ?", [taskId], ["tasks"]);
  return (rows[0]?.description_md as string | null) ?? "";
}

/** Komentarze od najstarszego. */
export function useTaskComments(store: TabStore, taskId: string) {
  const { rows } = useLocalQuery<Row>(store, "select id, body, posted_at, edited_at, created_by from task_comments where task_id = ? and deleted_at is null", [taskId], ["task_comments"]);
  return useMemo(
    () =>
      sortComments(
        rows.map((r) => ({ id: String(r.id), taskId, body: String(r.body), postedAt: String(r.posted_at), editedAt: (r.edited_at as string | null) ?? null, authorId: (r.created_by as string | null) ?? null })),
      ),
    [rows, taskId],
  );
}

/** Własne przypomnienia zadania z gotowym opisem („15 min przed”, „jutro 09:00”) — cudzych nie widać. */
export function useTaskReminders(store: TabStore, taskId: string, today: LocalDate, userId: string): { id: string; label: string }[] {
  const { rows } = useLocalQuery<Row>(
    store,
    "select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null and (created_by is null or created_by = ?) order by kind, offset_min, at_date, at_time",
    [taskId, userId],
    ["reminders"],
  );
  return rows.map((r) => ({
    id: String(r.id),
    label: r.kind === "relative" ? reminderOffset(Number(r.offset_min)) : `${relativeDay(String(r.at_date) as LocalDate, today)} ${String(r.at_time).slice(0, 5)}`,
  }));
}

/**
 * Przypomnienia w udostępnionej przestrzeni: kto dostanie automatyczne w chwili terminu (`note`, `null` — bez
 * objaśnienia) i czy użytkownik może ustawić sobie własne (`allowed` — z podglądem tylko uczestnik / odpowiedzialny).
 */
export function useReminderRules(store: TabStore, data: AppData, task: ViewTask, userId: string, prefs?: AutoReminderPrefs): { note: string | null; allowed: boolean } {
  const creator = useLocalQuery<Row>(store, "select created_by from tasks where id = ?", [task.id], ["tasks"]);
  const person = useLocalQuery<Row>(store, "select user_id from scope_collaborators where scope_id = ? and collaborator_id = ?", [task.workspaceId, task.assigneeId ?? ""], ["scope_collaborators"]);
  const participant = useLocalQuery<Row>(
    store,
    "select 1 as me from task_participants p join scope_collaborators sc on sc.collaborator_id = p.collaborator_id where p.task_id = ? and p.deleted_at is null and sc.scope_id = ? and sc.user_id = ? limit 1",
    [task.id, task.workspaceId, userId],
    ["task_participants", "scope_collaborators"],
  );
  const createdBy = (creator.rows[0]?.created_by as string | null | undefined) ?? userId;
  const responsible = responsibleAccount({ assigneeId: task.assigneeId, createdBy }, () => person.rows[0]?.user_id as string | null | undefined);
  const note = assigneeReminderNote(task, {
    shared: (data.workspaces.find((w) => w.id === task.workspaceId)?.members ?? 1) > 1,
    userId,
    assigneeName: assigneeOf(task.assigneeId, data.collaborators)?.name ?? null,
    account: responsible,
    prefs,
    follows: !!prefs && ((prefs.follow.created && createdBy === userId) || (prefs.follow.participating && participant.rows.length > 0)),
  });
  return { note, allowed: canSetOwnReminder({ editable: listEditable(data, task.listId), userId, responsible: creator.rows.length ? responsible : null, participant: participant.rows.length > 0 }) };
}
