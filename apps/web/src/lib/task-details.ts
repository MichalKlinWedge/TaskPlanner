"use client";

/** Dane jednego zadania z lokalnej bazy — wspólne dla formularza (`task-panel.tsx`) i podglądu (`task-preview.tsx`). */
import { assigneeOf, assigneeReminderNote, relativeDay, reminderOffset, responsibleAccount, sortComments, type LocalDate, type ViewTask } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import type { AppData } from "./app-data";
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

/** Kto dostanie automatyczne przypomnienie w chwili terminu (udostępniona przestrzeń); `null` — bez objaśnienia. */
export function useAssigneeReminderNote(store: TabStore, data: AppData, task: ViewTask, userId: string): string | null {
  const creator = useLocalQuery<Row>(store, "select created_by from tasks where id = ?", [task.id], ["tasks"]);
  const person = useLocalQuery<Row>(store, "select user_id from scope_collaborators where scope_id = ? and collaborator_id = ?", [task.workspaceId, task.assigneeId ?? ""], ["scope_collaborators"]);
  const createdBy = (creator.rows[0]?.created_by as string | null | undefined) ?? userId;
  return assigneeReminderNote(task, {
    shared: (data.workspaces.find((w) => w.id === task.workspaceId)?.members ?? 1) > 1,
    userId,
    assigneeName: assigneeOf(task.assigneeId, data.collaborators)?.name ?? null,
    account: responsibleAccount({ assigneeId: task.assigneeId, createdBy }, () => person.rows[0]?.user_id as string | null | undefined),
  });
}
