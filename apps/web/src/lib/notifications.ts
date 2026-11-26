"use client";

/**
 * Centrum powiadomień (v1.x, N1): wiersze `notifications` z lokalnej bazy (tworzy je serwer, przychodzą
 * zwykłą synchronizacją) i ustawienia z profilu. Zaznaczenie „przeczytane” / usunięcie = `mutateMany`
 * (outbox — działa offline). Otwarcie zadania z nagłówka: zdarzenie okna `tp-open-task` (nasłuchuje `Shell`).
 */
import { NotificationPrefs, toNotification, type AppNotification } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import { parseSettings } from "./app-data";
import { useLocalQuery } from "./local-store";

interface Row extends Record<string, string | number | null> {
  id: string;
  kind: string;
  task_id: string | null;
  workspace_id: string | null;
  actor_id: string | null;
  data: string | null;
  group_key: string | null;
  at: string;
  read_at: string | null;
}

/** Tyle najnowszych wierszy czyta dzwonek (więcej i tak nie zmieści się na liście). */
const LIMIT = 300;

export function useNotifications(store: TabStore | null, userId: string): { list: AppNotification[]; prefs: NotificationPrefs; timeZone: string | undefined } {
  const { rows } = useLocalQuery<Row>(
    store,
    `select id, kind, task_id, workspace_id, actor_id, data, group_key, at, read_at from notifications where deleted_at is null order by at desc limit ${LIMIT}`,
    [],
    ["notifications"],
  );
  const { rows: profile } = useLocalQuery<{ settings: string | null }>(store, "select settings from profiles where id = ?", [userId], ["profiles"]);
  const list = useMemo(() => rows.map((r) => toNotification(r)).filter((n): n is AppNotification => n !== null), [rows]);
  const settings = useMemo(() => {
    try {
      return parseSettings(profile[0]?.settings ? JSON.parse(profile[0].settings) : {});
    } catch {
      return parseSettings({});
    }
  }, [profile]);
  return { list, prefs: settings.notifications, timeZone: settings.timeZone };
}

export const OPEN_TASK_EVENT = "tp-open-task";

/** Otwarcie zadania w panelu z miejsca poza `Shell` (nagłówek). */
export function requestOpenTask(taskId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: { taskId } }));
}
