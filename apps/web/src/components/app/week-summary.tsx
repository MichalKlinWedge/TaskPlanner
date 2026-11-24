"use client";

/**
 * Krok „Podsumowanie” przeglądu tygodnia (v1.x): liczby z core `weekFacts` (zawsze, także offline i bez konta AI)
 * i „✨ Opisz tydzień” — kilka zdań, w których liczby wstawia kod, oraz sugestie przypięte do zadań (kliknięcie =
 * zwykła decyzja przeglądu z „Cofnij”). Opis zapisuje dopiero „Zakończ przegląd” (`review_sessions.stats.summary`).
 */
import {
  addDays,
  AI_HINT_MAX,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  aiWeekSummaryNote,
  dayMonth,
  localDateAt,
  nextWeekNote,
  relativeDay,
  REVIEW_ACTION,
  reviewSummary,
  WEEK_SUMMARY,
  weekFactList,
  weekFacts,
  weekFactsFrom,
  weekFactTexts,
  weekSuggestionActive,
  weekSummaryFromAi,
  weekSummaryRequest,
  type ReviewAction,
  type ViewContext,
  type ViewTask,
  type WeekFact,
  type WeeklyReview,
  type WeekSummary,
} from "@taskplanner/core";
import { useMemo, useState } from "react";

import { askWeekSummary, useAiAccount } from "@/lib/ai";
import { listEditable } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";
import { useOnline } from "@/lib/use-online";

import { useAppEnv } from "./app-env";
import { useFocus } from "./focus";
import { Button, Input, Notice } from "./ui";

interface Props {
  ctx: ViewContext;
  review: WeeklyReview;
  summary: WeekSummary | null;
  onSummary: (summary: WeekSummary | null) => void;
  onAct: (task: ViewTask, action: ReviewAction) => void;
}

function Rows({ title, facts }: { title: string; facts: readonly WeekFact[] }) {
  if (!facts.length) return null;
  return (
    <div className="min-w-0 flex-1 basis-60">
      <h3 className="mb-1 text-xs font-semibold text-[var(--muted)]">{title}</h3>
      <ul className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)] text-sm">
        {facts.map((f) => (
          <li key={f.key} className="flex gap-2 px-3 py-1">
            <span className="min-w-0 flex-1 truncate">{f.label}</span>
            <span className="tabular-nums">{f.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WeekSummaryStep({ ctx, review, summary, onSummary, onAct }: Props) {
  const { data, store, settings, openTask } = useAppEnv();
  const focus = useFocus();
  const account = useAiAccount(store);
  const online = useOnline();
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seriesRows = useLocalQuery<Record<string, string | null>>(
    store,
    `select c.task_id, c.completed_at from task_completions c join tasks t on t.id = c.task_id
       where c.deleted_at is null and c.kind = 'done' and t.kind = 'task' and t.deleted_at is null and c.completed_at >= ?`,
    [addDays(weekFactsFrom(ctx.today), -2)],
    ["task_completions", "tasks"],
  ).rows;
  const sessions = useLocalQuery<Record<string, string | null>>(
    store,
    "select finished_at, stats from review_sessions where deleted_at is null and kind = 'weekly' and finished_at is not null and stats is not null order by finished_at desc limit 20",
    [],
    ["review_sessions"],
  ).rows;

  const minute = Math.floor(focus.now / 60_000);
  const facts = useMemo(
    () =>
      weekFacts(
        {
          tasks: data.tasks,
          seriesDone: seriesRows.map((r) => ({ taskId: String(r.task_id), completedAt: String(r.completed_at) })),
          habitCompletions: data.habitCompletions,
          timeEntries: focus.entries,
          workHours: settings.workHours,
          now: new Date(minute * 60_000),
        },
        ctx,
      ),
    [data.tasks, data.habitCompletions, seriesRows, focus.entries, settings.workHours, minute, ctx],
  );
  const listName = (id: string) => {
    const list = data.lists.find((l) => l.id === id);
    if (!list) return "(lista)";
    return list.kind === "inbox" ? `Inbox (${data.workspaces.find((w) => w.id === list.workspaceId)?.name ?? "?"})` : list.name;
  };
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const texts = weekFactTexts(facts, { list: listName, task: (id) => byId.get(id)?.title ?? "" });
  const note = nextWeekNote(facts);
  const canEdit = (task: ViewTask) => listEditable(data, task.listId);
  const previous = sessions.flatMap((r) => {
    const text = reviewSummary(r.stats);
    return text && text !== summary?.text ? [{ text, date: localDateAt(String(r.finished_at), ctx.timeZone) }] : [];
  })[0];
  const ready = aiAccountReady(account);

  const ask = async () => {
    if (busy || !online || !aiAccountReady(account)) return;
    const list = weekFactList(texts);
    const query = weekSummaryRequest({ accountId: account.id, from: facts.from, today: ctx.today, facts: list, doneTaskIds: facts.doneTaskIds, tasks: data.tasks, review, canEdit, listName, hint });
    setBusy(true);
    setError(null);
    try {
      const result = weekSummaryFromAi(await askWeekSummary(query.request), query, { facts: list, tasks: data.tasks, canEdit, ctx });
      if (result) onSummary(result);
      else setError(WEEK_SUMMARY.invalid);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = (summary?.suggestions ?? []).flatMap((s) => {
    const task = byId.get(s.taskId);
    return task && weekSuggestionActive(task, s, ctx) ? [{ ...s, task }] : [];
  });

  return (
    <>
      <p className="text-xs text-[var(--muted)]">
        {dayMonth(facts.from)} – {dayMonth(facts.to)}
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="week-facts">
        {texts.main.map((f) => (
          <div key={f.key} className={`rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 ${f.key === "pelnyDzien" ? "col-span-2" : ""}`} data-fact={f.key}>
            <dt className="text-xs text-[var(--muted)]">{f.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{f.value}</dd>
          </div>
        ))}
      </dl>
      {note ? <p className="text-xs text-[var(--muted)]">Następne 7 dni: {note}.</p> : null}
      <div className="flex flex-wrap gap-3">
        <Rows title={WEEK_SUMMARY.lists} facts={texts.lists} />
        <Rows title={WEEK_SUMMARY.habits} facts={texts.habits} />
      </div>

      {ready ? (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--line)] p-3" data-testid="week-ai">
          <div className="flex flex-wrap gap-2">
            <Input
              value={hint}
              maxLength={AI_HINT_MAX}
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void ask()}
              placeholder={WEEK_SUMMARY.hint}
              aria-label="Wskazówka dla AI"
              disabled={busy}
              className="min-w-0 flex-1 basis-60"
            />
            <Button disabled={busy || !online} title={online ? undefined : AI_NEEDS_NETWORK} onClick={() => void ask()}>
              {busy ? WEEK_SUMMARY.busy : summary ? WEEK_SUMMARY.again : WEEK_SUMMARY.ai}
            </Button>
          </div>
          {online ? null : <p className="text-xs text-[var(--muted)]">{AI_NEEDS_NETWORK}</p>}
          <p className="text-[11px] text-[var(--muted)]">{aiWeekSummaryNote(account.provider)}</p>
          {error ? <Notice tone="error">{error}</Notice> : null}
        </div>
      ) : null}

      {summary ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-[var(--accent)] p-3 text-sm" data-testid="week-summary">
          <p>{summary.text}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="min-w-0 flex-1">{WEEK_SUMMARY.saved}</span>
            <Button kind="ghost" className="py-0.5 text-xs" disabled={busy} onClick={() => onSummary(null)}>
              {WEEK_SUMMARY.discard}
            </Button>
          </div>
          {suggestions.length ? (
            <ul className="flex flex-col gap-2" aria-label={WEEK_SUMMARY.suggestions}>
              {suggestions.map((s) => (
                <li key={s.taskId} className="flex flex-wrap items-center gap-2" data-suggestion={s.taskId}>
                  <span className="min-w-0 flex-1 basis-60">
                    <button type="button" className="max-w-full truncate text-left font-medium hover:underline" onClick={() => openTask(s.taskId)}>
                      {s.task.title}
                    </button>
                    {s.reason ? <span className="block text-xs text-[var(--muted)]">{s.reason}</span> : null}
                  </span>
                  <Button className="px-2 py-0.5 text-xs" onClick={() => onAct(s.task, s.action)}>
                    {s.action.kind === "date" ? relativeDay(s.action.date, ctx.today) : REVIEW_ACTION[s.action.kind].label}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {previous ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">
            {WEEK_SUMMARY.previous} ({dayMonth(previous.date)})
          </summary>
          <p className="mt-1">{previous.text}</p>
        </details>
      ) : null}
    </>
  );
}
