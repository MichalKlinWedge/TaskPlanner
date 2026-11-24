"use client";

/**
 * Akcje z powiadomienia systemowego o zadaniu (M8): „Ukończ” i „Odłóż 10 min”. Service Worker nie ma
 * dostępu do lokalnej bazy, więc przekazuje akcję otwartej karcie (`reminder-action`) albo otwiera nową
 * (`/?reminderAction=…&reminderTask=…&reminderKey=…`); zapis robią reguły z core (`reminder-actions.ts`).
 */
import { descendants, REMINDER_ACTIONS, relativeDay, reminderDoneOps, snoozeReminderOps, toReminderRule, type ReminderAction } from "@taskplanner/core";
import { useEffect, useRef, useState } from "react";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";

interface Pending {
  action: ReminderAction;
  taskId: string;
  key: string;
}

const PARAMS = { action: "reminderAction", taskId: "reminderTask", key: "reminderKey" } as const;

function parse(action: unknown, taskId: unknown, key: unknown): Pending[] {
  return typeof taskId === "string" && typeof key === "string" && taskId && REMINDER_ACTIONS.includes(action as ReminderAction) ? [{ action: action as ReminderAction, taskId, key }] : [];
}

export function ReminderNotificationActions() {
  const { data, store, userId, timeZone, today, openTask } = useAppEnv();
  const { run, notify } = useTaskActions();
  const [pending, setPending] = useState<Pending[]>(() => {
    if (typeof window === "undefined") return [];
    const params = new URLSearchParams(window.location.search);
    return parse(params.get(PARAMS.action), params.get(PARAMS.taskId), params.get(PARAMS.key));
  });
  const handled = useRef(0);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has(PARAMS.action)) {
      for (const p of Object.values(PARAMS)) url.searchParams.delete(p);
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const { type, action, taskId, key } = event.data ?? {};
      if (type === "reminder-action") setPending((p) => [...p, ...parse(action, taskId, key)]);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!data.loaded) return;
    const handle = async ({ action, taskId, key }: Pending) => {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) return notify("Tego zadania już nie ma (usunięte albo w zarchiwizowanej liście).");
      const [rows, zones] = await Promise.all([
        store.query<{ id: string; task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
          "select id, task_id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null",
          [taskId],
        ),
        store.query<{ time_zone: string | null }>("select time_zone from tasks where id = ?", [taskId]),
      ]);
      const rules = rows.map(toReminderRule);
      const now = new Date();
      if (action === "snooze") {
        const snoozed = snoozeReminderOps(task, rules, { userId, now, timeZone: zones[0]?.time_zone ?? timeZone });
        if (!snoozed) return notify(`„${task.title}” jest już zamknięte.`);
        return run(snoozed.ops, { text: `„${task.title}” — przypomnienie o ${snoozed.time}`, undo: snoozed.undo });
      }
      const done = reminderDoneOps(task, key, rules, { userId, now, timeZone, subtasks: task.recurrence ? descendants(data.tasks, taskId) : [] });
      if (!done) {
        // Już ukończone albo inne wystąpienie serii — niczego nie odhaczamy, zadanie do obejrzenia.
        openTask(taskId);
        return notify(`„${task.title}” — to powiadomienie jest nieaktualne, nic nie zmieniono.`);
      }
      return run(done.ops, {
        text: done.nextDue ? `„${task.title}” — następny termin: ${relativeDay(done.nextDue, today)}` : `Ukończono „${task.title}” (z powiadomienia)`,
        undo: done.undo,
      });
    };
    const queue = pending.slice(handled.current);
    handled.current = pending.length;
    for (const p of queue) void handle(p).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
  }, [data, pending, store, userId, timeZone, today, run, notify, openTask]);
  return null;
}
