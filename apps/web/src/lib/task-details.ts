"use client";

/** Dane jednego zadania z lokalnej bazy — wspólne dla formularza (`task-panel.tsx`) i podglądu (`task-preview.tsx`). */
import { relativeDay, reminderOffset, sortComments, type LocalDate } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

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

/** Przypomnienia zadania z gotowym opisem („15 min przed”, „jutro 09:00”). */
export function useTaskReminders(store: TabStore, taskId: string, today: LocalDate): { id: string; label: string }[] {
  const { rows } = useLocalQuery<Row>(store, "select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null order by kind, offset_min, at_date, at_time", [taskId], ["reminders"]);
  return rows.map((r) => ({
    id: String(r.id),
    label: r.kind === "relative" ? reminderOffset(Number(r.offset_min)) : `${relativeDay(String(r.at_date) as LocalDate, today)} ${String(r.at_time).slice(0, 5)}`,
  }));
}
