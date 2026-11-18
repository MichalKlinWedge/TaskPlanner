"use client";

import type { Session } from "@supabase/supabase-js";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Login } from "@/components/sync-lab";
import { storeFor, useLocalQuery, useStoreStatus } from "@/lib/local-store";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { CalendarView } from "./calendar-view";
import { KanbanView } from "./kanban-view";
import { MarkdownCheck } from "./markdown-check";

// SVAR Gantt używa `window` przy imporcie — tylko w przeglądarce.
const GanttView = dynamic(() => import("./gantt-view"), { ssr: false });

type View = "kanban" | "calendar" | "gantt" | "markdown";
const VIEWS: { id: View; label: string }[] = [
  { id: "kanban", label: "Kanban" },
  { id: "calendar", label: "Kalendarz" },
  { id: "gantt", label: "Oś czasu" },
  { id: "markdown", label: "Markdown" },
];

/** PoC-5: widoki na lokalnej bazie (2 000 zadań z `seed:dev -- --load`) i pomiary. */
export function ViewsLab() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>("kanban");
  const [switches, setSwitches] = useState<{ view: View; ms: number; queryMs: number | null }[]>([]);
  const switchStart = useRef(0);

  useEffect(() => {
    const supabase = supabaseBrowser();
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  const store = useMemo(() => (userId ? storeFor(userId) : null), [userId]);
  const status = useStoreStatus();
  const count = useLocalQuery<{ n: number }>(store, "select count(*) as n from tasks where deleted_at is null", [], ["tasks"]).rows[0]?.n ?? 0;

  const onRendered = useCallback(
    (queryMs: number | null) => {
      if (!switchStart.current) return;
      const ms = performance.now() - switchStart.current;
      switchStart.current = 0;
      setSwitches((all) => [{ view, ms, queryMs }, ...all].slice(0, 12));
    },
    [view],
  );

  if (!session) return <Login />;

  return (
    <main className="flex w-full flex-col gap-3 p-4 text-sm">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">PoC-5: widoki</h1>
        <nav className="flex gap-1" aria-label="Widok">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => {
                switchStart.current = performance.now();
                setView(v.id);
              }}
              className={`rounded border px-3 py-1 ${view === v.id ? "bg-black text-white dark:bg-white dark:text-black" : ""}`}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <span className="text-xs opacity-70">
          {count} zadań w lokalnej bazie · {status.storage}
        </span>
        {status.error && <span className="text-xs text-red-600">{status.error}</span>}
      </header>
      <p className="text-xs" data-testid="switches">
        Przełączenia: {switches.map((s) => `${s.view} ${s.ms.toFixed(0)} ms`).join(" · ") || "—"}
      </p>
      {store && view === "kanban" && <KanbanView store={store} onRendered={onRendered} />}
      {store && view === "calendar" && <CalendarView store={store} onRendered={onRendered} />}
      {store && view === "gantt" && <GanttView store={store} onRendered={onRendered} />}
      {view === "markdown" && <MarkdownCheck onRendered={onRendered} />}
    </main>
  );
}
