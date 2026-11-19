"use client";

import { Gantt, Willow, type IApi, type ILink, type ITask } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import { addDays } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLocalQuery } from "@/lib/local-store";

import { afterPaint, formatDrag, syntheticDrag } from "./perf";

interface Row extends Record<string, string | number | null> {
  id: string;
  list_id: string;
  list_name: string;
  list_start: string | null;
  list_end: string | null;
  title: string;
  start_date: string | null;
  due_date: string;
}

const toDate = (d: string) => new Date(`${d}T00:00:00`);
const pad = (n: number) => String(n).padStart(2, "0");
const fromDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Oś czasu (SVAR React Gantt): projekty jako zadania nadrzędne, paski zadań od `start_date`
 * do `due_date` (koniec wyłącznie = dzień po terminie). Zależności w PoC tylko w pamięci —
 * tabela `task_dependencies` dochodzi w Etapie 6. Naruszenie koniec→początek = czerwony pasek.
 */
export default function GanttView({ store, onRendered }: { store: TabStore; onRendered: (ms: number | null) => void }) {
  const { rows, ms } = useLocalQuery<Row>(
    store,
    `select t.id, t.list_id, l.name as list_name, l.start_date as list_start, l.end_date as list_end, t.title, t.start_date, t.due_date
       from tasks t join lists l on l.id = t.list_id
      where t.deleted_at is null and l.deleted_at is null and l.kind = 'project' and t.parent_id is null and t.due_date is not null and t.kind = 'task'
      order by l.sort_key, t.due_date`,
    [],
    ["tasks", "lists"],
  );
  const [links, setLinks] = useState<ILink[]>([]);
  const [measure, setMeasure] = useState<string | null>(null);
  const api = useRef<IApi | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const tasks = useMemo<ITask[]>(() => {
    const projects = new Map<string, ITask>();
    const items: ITask[] = [];
    for (const r of rows) {
      if (!projects.has(r.list_id)) {
        projects.set(r.list_id, {
          id: `p:${r.list_id}`,
          text: r.list_name,
          type: "summary",
          open: projects.size < 3,
          start: toDate(r.list_start ?? r.due_date),
          end: toDate(addDays(r.list_end ?? r.due_date, 1)),
        });
      }
      items.push({ id: r.id, text: r.title, parent: `p:${r.list_id}`, type: "task", start: toDate(r.start_date ?? r.due_date), end: toDate(addDays(r.due_date, 1)), progress: 0 });
    }
    return [...projects.values(), ...items];
  }, [rows]);

  const violated = useMemo(() => {
    const byId = new Map(tasks.map((t) => [String(t.id), t]));
    const bad = new Set<string>();
    for (const link of links) {
      const source = byId.get(String(link.source));
      const target = byId.get(String(link.target));
      if (link.type === "e2s" && source?.end && target?.start && target.start < source.end) bad.add(String(link.target));
    }
    return bad;
  }, [tasks, links]);

  useEffect(() => {
    if (rows.length) afterPaint(() => onRendered(ms));
  }, [rows.length, ms, onRendered]);

  const init = (gantt: IApi) => {
    api.current = gantt;
    gantt.on("update-task", (ev: { id: string | number; task: Partial<ITask>; inProgress?: boolean }) => {
      if (ev.inProgress || String(ev.id).startsWith("p:")) return;
      const current = gantt.getTask(ev.id);
      const start = ev.task.start ?? current?.start;
      const end = ev.task.end ?? current?.end;
      if (!start || !end) return;
      const due = fromDate(new Date(end.getTime() - 86_400_000));
      const startDate = fromDate(start);
      void store.mutate("tasks", String(ev.id), { start_date: startDate === due ? null : startDate, due_date: due });
    });
    gantt.on("add-link", (ev: { id?: string | number; link: Partial<ILink> }) => {
      setLinks((all) => [...all, { id: ev.id ?? crypto.randomUUID(), type: ev.link.type ?? "e2s", source: ev.link.source!, target: ev.link.target! }]);
    });
    gantt.on("delete-link", (ev: { id: string | number }) => setLinks((all) => all.filter((l) => l.id !== ev.id)));
  };

  const runMeasure = async () => {
    const bar = root.current?.querySelector(".wx-bar.wx-task");
    if (!bar) return setMeasure("brak paska");
    const box = bar.getBoundingClientRect();
    setMeasure("mierzę…");
    const result = await syntheticDrag(bar, { x: box.left + 300, y: box.top + box.height / 2 }, { kind: "mouse" });
    setMeasure(formatDrag(result));
  };

  return (
    <div ref={root} className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span>
          {rows.length} pasków · zapytanie {ms?.toFixed(1) ?? "—"} ms · zależności {links.length}, naruszone {violated.size}
        </span>
        <button type="button" className="rounded border px-2 py-0.5" onClick={() => void runMeasure()}>
          Zmierz przeciąganie
        </button>
        <span data-testid="gantt-drag">{measure}</span>
      </div>
      <div className="h-[70vh] border border-[var(--line)]">
        <Willow>
          <Gantt
            init={init}
            tasks={tasks}
            links={links}
            scales={[
              { unit: "month", step: 1, format: "%F %Y" },
              { unit: "day", step: 1, format: "%j" },
            ]}
            cellWidth={28}
            taskTemplate={({ data }) => (
              <div className={`h-full w-full truncate px-1 text-[11px] ${violated.has(String(data.id)) ? "bg-red-600 text-white" : ""}`} data-violated={violated.has(String(data.id)) || undefined}>
                {data.text}
              </div>
            )}
          />
        </Willow>
      </div>
    </div>
  );
}
