"use client";

/** „Usuń na stałe” w koszu: potwierdzenie, usunięcie na serwerze (`purge_tasks`), bez cofnięcia. */
import { purgeErrorText, purgeQuestion, type TrashedTask } from "@taskplanner/core";
import { useState } from "react";

import { listEditable } from "@/lib/app-data";
import { purgeFromTrash } from "@/lib/trash";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { Button } from "./ui";

export function PurgeButton({ task, inside }: { task: TrashedTask; inside: number }) {
  const { data, store, openTask, openTaskId } = useAppEnv();
  const { notify } = useTaskActions();
  const [busy, setBusy] = useState(false);

  const purge = async () => {
    const shared = (data.workspaces.find((w) => w.id === task.workspaceId)?.members ?? 1) > 1;
    const question = purgeQuestion(task.title, inside, shared);
    if (!window.confirm(`${question.title}\n\n${question.text}`)) return;
    setBusy(true);
    try {
      await purgeFromTrash(store, task.id);
      if (openTaskId === task.id) openTask(null);
      notify(`Usunięto na stałe „${task.title}”`);
    } catch (e) {
      notify(purgeErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button kind="danger" disabled={busy || !listEditable(data, task.listId)} title="Tego nie da się cofnąć" onClick={() => void purge()}>
      {busy ? "Usuwanie…" : "Usuń na stałe"}
    </Button>
  );
}
