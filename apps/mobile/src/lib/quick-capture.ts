/**
 * Okno szybkiego dodawania nad ekranem głównym (moduł natywny `quick-capture`, widżet „Szybkie dodawanie”):
 * zapis kolejki do Inbox tą samą gramatyką co pole w aplikacji (`parseQuickAdd` + `quickAddTaskOps`). Wołane
 * z zadania bez ekranu (`QuickCaptureWorker`) i przy starcie / powrocie aplikacji. Id zadania wynika z klucza
 * wpisu, więc powtórzony zapis (proces zginął przed `ack`) niczego nie dubluje.
 */
import { localDateTimeAt, parseQuickAdd, quickAddTaskOps, uuidv5, type TaskOp } from '@taskplanner/core';

import { QuickCapture, type QuickCaptureEntry } from '../../modules/quick-capture';
import { refreshWidgets } from '../widget/refresh';
import { currentWorkspace, lastSortKey, targetInbox, type AppData } from './app-data';
import { reportError } from './error-log';
import { applyOps, headlessData, pushNow } from './headless';
import { scheduleReminders } from './scheduler';
import { localEngine } from './sync';

/** Zadanie bez ekranu uruchamiane po „Dodaj” w oknie (`QuickCaptureWorker`). */
export const QUICK_CAPTURE_TASK = 'TaskQuickCapture';

/** Operacje jednego wpisu; `null` — brak Inbox (konto bez przestrzeni) albo pusty tytuł. */
export function captureOps(data: AppData, entry: QuickCaptureEntry): TaskOp[] | null {
  const inbox = targetInbox(data, currentWorkspace());
  if (!inbox) return null;
  const names = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const parsed = parseQuickAdd(entry.text, {
    currentWorkspace: names.get(inbox.workspaceId),
    workspaces: data.workspaces.map((w) => w.name),
    lists: data.lists.filter((l) => l.kind !== 'inbox').map((l) => ({ workspace: names.get(l.workspaceId) ?? '', name: l.name, kind: l.kind })),
    tags: data.tags.map((t) => t.name),
    now: localDateTimeAt(new Date(entry.at), data.settings.timeZone),
  });
  if (!parsed.title.trim()) return null;
  let n = 0;
  return quickAddTaskOps(parsed, entry.text, {
    userId: data.userId,
    workspaces: data.workspaces,
    lists: data.lists,
    tags: data.tags,
    defaultListId: inbox.id,
    defaultDueDate: null,
    lastSortKey: (id) => lastSortKey(data, id),
    newId: () => uuidv5(`quick-capture:${entry.key}:${n++}`),
  }).ops;
}

let draining: Promise<boolean> | null = null;

/** `true` — coś zapisano. Wpis znika z kolejki dopiero po zapisie (albo gdy nie ma tytułu). */
export function handleQuickCaptures(): Promise<boolean> {
  draining ??= drain().finally(() => {
    draining = null;
  });
  return draining;
}

async function drain(): Promise<boolean> {
  const entries = QuickCapture?.pending() ?? [];
  if (!entries.length) return false;
  let changed = false;
  try {
    const engine = await localEngine();
    let data = await headlessData();
    for (const entry of entries) {
      try {
        const ops = captureOps(data, entry);
        // Bez Inbox (np. przed logowaniem) wpis czeka na następny raz.
        if (ops === null && !targetInbox(data, currentWorkspace())) continue;
        const taskId = ops?.[0]?.id;
        const exists = taskId ? (await engine.db.all('select 1 from tasks where id = ?', [taskId])).length > 0 : false;
        if (ops?.length && !exists) {
          await applyOps(ops);
          changed = true;
          // Kolejny wpis za tym w kolejności listy.
          if (entries.length > 1) data = await headlessData();
        }
        QuickCapture?.ack(entry.key);
      } catch (error) {
        reportError('error', error, { quickCapture: true });
      }
    }
  } catch (error) {
    reportError('error', error, { quickCapture: true });
  }
  if (changed) {
    await pushNow();
    await scheduleReminders().catch(() => undefined);
    await refreshWidgets().catch(() => undefined);
  }
  return changed;
}
