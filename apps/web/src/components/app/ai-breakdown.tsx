"use client";

/**
 * „✨ Rozbij na kroki” (v1.x) w sekcji „Podzadania” panelu zadania: wskazówka → szkic kroków od AI na koncie
 * użytkownika → poprawki w podglądzie → „Dodaj” (core `breakdownOps`, jedna transakcja z „Cofnij”).
 * Przycisk widać tylko przy sprawdzonym koncie AI; bez sieci jest nieaktywny. AI niczego samo nie zapisuje.
 */
import {
  AI_BREAKDOWN,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  aiBreakdownNote,
  BREAKDOWN_MAX_HINT,
  breakdownDrafts,
  breakdownMinutes,
  breakdownOps,
  breakdownRequest,
  canBreakDown,
  formatMinutes,
  plural,
  PRIORITY,
  type AiAccount,
  type BreakdownDraft,
  type Priority,
  type ViewTask,
} from "@taskplanner/core";
import { useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { askBreakdown, useAiAccount } from "@/lib/ai";
import { useDependencies } from "@/lib/dependencies";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { Button, IconButton, Input, Notice, Select } from "./ui";

const subscribeOnline = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};
const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

const PRIORITIES = [1, 2, 3, 4] as const satisfies readonly Priority[];
const steps = (n: number) => plural(n, ["krok", "kroki", "kroków"]);

export function BreakdownField({ task }: { task: ViewTask }) {
  const { store, data } = useAppEnv();
  const account = useAiAccount(store);
  const [open, setOpen] = useState(false);
  const online = useOnline();
  if (!aiAccountReady(account) || !canBreakDown(data.tasks, task)) return null;
  if (!open) {
    return (
      <Button kind="ghost" disabled={!online} title={online ? undefined : AI_NEEDS_NETWORK} onClick={() => setOpen(true)}>
        {AI_BREAKDOWN.button}
      </Button>
    );
  }
  return <BreakdownForm task={task} account={account} online={online} onClose={() => setOpen(false)} />;
}

function BreakdownForm({ task, account, online, onClose }: { task: ViewTask; account: AiAccount; online: boolean; onClose: () => void }) {
  const { store, data, today } = useAppEnv();
  const { run, notify } = useTaskActions();
  const deps = useDependencies(store);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<BreakdownDraft[] | null>(null);

  const ask = async () => {
    if (busy || !online) return;
    setBusy(true);
    setError(null);
    try {
      const [row] = await store.query<{ description_md: string | null }>("select description_md from tasks where id = ?", [task.id]);
      const result = await askBreakdown(breakdownRequest(task, { accountId: account.id, tasks: data.tasks, description: row?.description_md ?? null, hint, today }));
      setDrafts(breakdownDrafts(result.steps, task, { tasks: data.tasks, today }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = (key: string, change: Partial<BreakdownDraft>) => setDrafts((list) => list?.map((d) => (d.key === key ? { ...d, ...change } : d)) ?? null);
  const chosen = drafts?.filter((d) => d.selected && d.title.trim()).length ?? 0;
  const minutes = drafts ? breakdownMinutes(drafts) : 0;

  const apply = () => {
    const result = drafts && breakdownOps(drafts, task.id, { tasks: data.tasks, deps, today, now: new Date() });
    if (!result) return notify(AI_BREAKDOWN.blocked);
    void run(result.ops, { text: `Dodano ${steps(result.count)} do „${task.title}”`, undo: result.undo });
    onClose();
  };

  // Escape zamyka to okienko, nie cały panel zadania (nasłuch panelu jest na `window`).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  };

  return (
    <section aria-label="Rozbij na kroki" className="mt-2 flex flex-col gap-2 rounded-md border border-[var(--line)] p-2" onKeyDown={onKeyDown}>
      <div className="flex gap-2">
        <Input
          autoFocus
          value={hint}
          maxLength={BREAKDOWN_MAX_HINT}
          onChange={(e) => setHint(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask()}
          placeholder={AI_BREAKDOWN.hint}
          aria-label="Wskazówka dla AI"
          disabled={busy}
          className="flex-1"
        />
        <IconButton label="Zamknij rozbijanie na kroki" onClick={onClose}>
          ×
        </IconButton>
      </div>
      <p className="text-xs text-[var(--muted)]">{aiBreakdownNote(account.provider)}</p>
      <div>
        <Button kind={drafts ? "secondary" : "primary"} disabled={busy || !online} title={online ? undefined : AI_NEEDS_NETWORK} onClick={() => void ask()}>
          {busy ? AI_BREAKDOWN.busy : drafts ? AI_BREAKDOWN.again : AI_BREAKDOWN.ask}
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {drafts && !drafts.length ? <Notice>{AI_BREAKDOWN.empty}</Notice> : null}
      {drafts?.length ? (
        <>
          <ul className="divide-y divide-[var(--line)]" aria-label="Proponowane kroki">
            {drafts.map((d, i) => (
              <li key={d.key} className={`flex flex-col gap-1 py-1.5 ${d.selected ? "" : "opacity-50"}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={d.selected} onChange={(e) => patch(d.key, { selected: e.target.checked })} aria-label={`Dodaj krok: ${d.title}`} />
                  <Input value={d.title} maxLength={500} onChange={(e) => patch(d.key, { title: e.target.value })} aria-label={`Tytuł kroku ${i + 1}`} className="flex-1 py-1" />
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-5 text-xs text-[var(--muted)]">
                  <Input
                    type="number"
                    min={1}
                    max={10080}
                    value={d.durationMin ?? ""}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      patch(d.key, { durationMin: n >= 1 ? Math.min(n, 10_080) : null });
                    }}
                    placeholder="min"
                    title="Czas w minutach"
                    aria-label={`Czas kroku ${i + 1} (min)`}
                    className="w-20 py-0.5 text-xs"
                  />
                  <Input
                    type="date"
                    value={d.dueDate ?? ""}
                    min={today}
                    max={task.dueDate && task.dueDate >= today ? task.dueDate : undefined}
                    onChange={(e) => patch(d.key, { dueDate: e.target.value || null })}
                    aria-label={`Termin kroku ${i + 1}`}
                    className="py-0.5 text-xs"
                  />
                  <Select value={d.priority} onChange={(e) => patch(d.key, { priority: Number(e.target.value) as Priority })} aria-label={`Priorytet kroku ${i + 1}`} className="py-0.5 text-xs">
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY[p].label}
                      </option>
                    ))}
                  </Select>
                  {i > 0 ? (
                    <label className="flex items-center gap-1" title="Krok czeka na poprzedni zaznaczony (zależność)">
                      <input type="checkbox" checked={d.afterPrevious} onChange={(e) => patch(d.key, { afterPrevious: e.target.checked })} />
                      {AI_BREAKDOWN.after}
                    </label>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--muted)]">
            Razem {formatMinutes(minutes)}
            {task.durationMin ? ` · czas zadania ${formatMinutes(task.durationMin)}` : ""}
          </p>
          <div className="flex gap-2">
            <Button kind="primary" disabled={!chosen || busy} onClick={apply}>
              Dodaj {steps(chosen)}
            </Button>
            <Button kind="ghost" onClick={onClose}>
              Anuluj
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
