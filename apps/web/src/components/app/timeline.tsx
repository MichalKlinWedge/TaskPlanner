"use client";

/**
 * Oś czasu (M12, Etap 6): SVAR React Gantt (D18) nad `core/timeline.ts` — projekty → zadania →
 * podzadania, paski od `start_date` do `due_date`, postęp, linia „dziś”, skale dzień / tydzień /
 * miesiąc. Przesunięcie i rozciągnięcie paska zapisuje daty (`timelineChangeOps`, z „Przesuń zależne”
 * albo „Tylko to zadanie”), pasek projektu przesuwa cały projekt (`shiftProjectOps`). Zależność
 * koniec→początek: przeciągnięcie z końca paska na początek drugiego — zapis dopiero po
 * `addDependencyOps` (blokada cyklu; SVAR cykle przyjmuje). Naruszenia: czerwone paski i strzałki
 * oraz lista z „Popraw”.
 *
 * SVAR dostaje dane tylko z lokalnej bazy: własnych zmian SVAR (dodanie zależności, przeciąganie
 * w siatce, edytor) nie przepuszczamy. Widok zostaje zamontowany po pierwszym otwarciu (`active` =
 * widoczny); ukryty nie przelicza danych, więc nie spowalnia innych widoków.
 */
import { Locale } from "@svar-ui/react-core";
import { Gantt, Willow, WillowDark, type IApi, type IColumnConfig, type ILink, type IScaleConfig, type ITask } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import {
  addDays,
  addDependencyOps,
  daysBetween,
  dependencyErrorText,
  plural,
  removeDependencyOps,
  shiftProjectOps,
  timelineChangeOps,
  timelineModel,
  type Dependency,
  type LocalDate,
  type Span,
  type TimelineModel,
  type ViewContext,
} from "@taskplanner/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { AppData } from "@/lib/app-data";
import { useDependencies } from "@/lib/dependencies";
import { GANTT_PL } from "@/lib/gantt-locale";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";

type Scale = "day" | "week" | "month";
const SCALE_KEY = "tp-timeline-scale";
const CASCADE_KEY = "tp-timeline-cascade";
const PROJECT = "p:";

const pad = (n: number) => String(n).padStart(2, "0");
/** Daty osi w lokalnej północy przeglądarki (dni bez stref — jak `due_date`). */
const toDate = (d: LocalDate) => new Date(`${d}T00:00:00`);
const fromDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` as LocalDate;

const SCALES: Record<Scale, { label: string; cellWidth: number; scales: IScaleConfig[] }> = {
  day: {
    label: "Dzień",
    cellWidth: 30,
    scales: [
      { unit: "month", step: 1, format: "%F %Y" },
      { unit: "day", step: 1, format: "%j" },
    ],
  },
  week: {
    label: "Tydzień",
    cellWidth: 84,
    scales: [
      { unit: "month", step: 1, format: "%F %Y" },
      { unit: "week", step: 1, format: (d: Date) => `${d.getDate()}.${pad(d.getMonth() + 1)}` },
    ],
  },
  month: {
    label: "Miesiąc",
    cellWidth: 120,
    scales: [
      { unit: "year", step: 1, format: "%Y" },
      { unit: "month", step: 1, format: "%F" },
    ],
  },
};

const shortDay = (d: unknown) => (d instanceof Date ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}` : "");
const COLUMNS: IColumnConfig[] = [
  { id: "text", header: "Zadanie", flexgrow: 1, width: 200, sort: false },
  { id: "start", header: "Początek", width: 78, align: "center", sort: false, template: shortDay },
  { id: "duration", header: "Dni", width: 44, align: "center", sort: false },
];

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Bez pamięci przeglądarki — do odświeżenia.
  }
}

/** Ciemny motyw z `data-theme` na `<html>` (`lib/theme.ts`). */
const subscribeTheme = (listener: () => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};
const useDark = () =>
  useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.dataset.theme === "dark",
    () => false,
  );

/** Pasek: tytuł, ukończone przekreślone, naruszenie na czerwono. */
function Bar({ data }: { data: ITask }) {
  return (
    <div className={`h-full w-full truncate px-1 text-[11px] leading-[inherit] ${data.violated ? "tp-gantt-violated" : ""} ${data.done ? "line-through opacity-70" : ""}`} data-violated={data.violated || undefined}>
      {data.violated ? "⚠ " : ""}
      {data.text}
    </div>
  );
}

interface ChartProps {
  tasks: ITask[];
  links: ILink[];
  scale: Scale;
  start: Date;
  end: Date;
  highlight: (date: Date, unit: string) => string;
  dark: boolean;
  init: (api: IApi) => void;
}

/** SVAR rysuje się od nowa tylko przy zmianie danych osi (memo). */
const Chart = memo(function Chart({ tasks, links, scale, start, end, highlight, dark, init }: ChartProps) {
  const Theme = dark ? WillowDark : Willow;
  return (
    <Locale words={GANTT_PL}>
      <Theme>
        <Gantt
          init={init}
          tasks={tasks}
          links={links}
          columns={COLUMNS}
          scales={SCALES[scale].scales}
          cellWidth={SCALES[scale].cellWidth}
          cellHeight={34}
          lengthUnit="day"
          durationUnit="day"
          start={start}
          end={end}
          highlightTime={highlight}
          taskTemplate={Bar}
        />
      </Theme>
    </Locale>
  );
});

interface Latest {
  data: AppData;
  deps: Dependency[];
  model: TimelineModel;
  cascade: boolean;
}

export function TimelineScreen({ data, ctx, active }: { data: AppData; ctx: ViewContext; active: boolean }) {
  const { store: tabStore, openTask, select } = useAppEnv();
  const { run, notify } = useTaskActions();
  const deps = useDependencies(tabStore);
  const dark = useDark();
  const [scale, setScaleState] = useState<Scale>(() => readStored(SCALE_KEY, ["day", "week", "month"], "day"));
  const [cascade, setCascadeState] = useState(() => readStored(CASCADE_KEY, ["1", "0"], "1") === "1");
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const api = useRef<IApi | null>(null);
  const { today, workspaceId } = ctx;

  const projects = useMemo(
    () => data.lists.filter((l) => l.kind === "project" && (!workspaceId || l.workspaceId === workspaceId)).map((l) => ({ id: l.id, name: l.name, color: l.color, startDate: l.startDate, endDate: l.endDate })),
    [data.lists, workspaceId],
  );
  // Ukryty widok nie przelicza osi; po powrocie przelicza ją tylko, gdy dane się zmieniły (inaczej SVAR
  // nie dostaje nowych tablic i nic nie rysuje — przełączenie < 150 ms).
  const [cache, setCache] = useState(() => ({ projects, tasks: data.tasks, deps, model: timelineModel(projects, data.tasks, deps) }));
  if (active && (cache.projects !== projects || cache.tasks !== data.tasks || cache.deps !== deps)) {
    setCache({ projects, tasks: data.tasks, deps, model: timelineModel(projects, data.tasks, deps) });
  }
  const { model } = cache;

  const latest = useRef<Latest>({ data, deps, model, cascade });
  useEffect(() => {
    latest.current = { data, deps, model, cascade };
  });

  const setScale = (s: Scale) => {
    setScaleState(s);
    remember(SCALE_KEY, s);
  };
  const setCascade = (on: boolean) => {
    setCascadeState(on);
    remember(CASCADE_KEY, on ? "1" : "0");
  };

  const ganttTasks = useMemo<ITask[]>(() => {
    const kinds = new Map(model.rows.map((r) => [r.id, r.kind]));
    // Darmowy SVAR nie ma wierszy bez dat: zadanie bez terminu (z podzadaniami z terminem) i pusty
    // projekt dostają zakres potomków albo dzisiejszy dzień — bez przeciągania (`update-task` blokuje).
    const shown = new Map<string, Span>();
    for (const r of [...model.rows].reverse()) {
      const span = r.span ?? shown.get(r.id) ?? null;
      if (span) shown.set(r.id, span);
      if (span && r.parentId) {
        const up = shown.get(r.parentId);
        const parentRow = r.parentId;
        if (!model.rows.find((x) => x.id === parentRow)?.span) shown.set(parentRow, up ? { start: up.start < span.start ? up.start : span.start, end: up.end > span.end ? up.end : span.end } : span);
      }
    }
    return model.rows.map((r): ITask => {
      const id = r.kind === "project" ? `${PROJECT}${r.id}` : r.id;
      const parent = r.parentId ? (kinds.get(r.parentId) === "project" ? `${PROJECT}${r.parentId}` : r.parentId) : undefined;
      return {
        id,
        ...(parent ? { parent } : {}),
        text: r.title,
        type: r.kind === "project" || !r.span ? "summary" : "task",
        start: toDate(shown.get(r.id)?.start ?? today),
        end: toDate(addDays(shown.get(r.id)?.end ?? today, 1)),
        progress: r.progress,
        open: !closed.has(id),
        violated: r.violated,
        done: r.done,
      };
    });
  }, [model.rows, closed, today]);

  const ganttLinks = useMemo<ILink[]>(() => model.links.map((d) => ({ id: d.id, type: "e2s", source: d.predecessorId, target: d.successorId, lag: d.lagDays })), [model.links]);

  // Zakres osi: od 2 tygodni przed dziś (albo początkiem planu) do 2 miesięcy po (albo końcu planu).
  const range = useMemo(() => {
    let from = addDays(today, -14);
    let to = addDays(today, 60);
    for (const r of model.rows) {
      if (!r.span) continue;
      if (r.span.start < addDays(from, 7)) from = addDays(r.span.start, -7);
      if (r.span.end > addDays(to, -14)) to = addDays(r.span.end, 30);
    }
    return { start: toDate(from), end: toDate(to) };
  }, [model.rows, today]);
  // Linia „dziś” (znaczniki SVAR są tylko w wersji PRO): kolumna dzisiejszego dnia / tygodnia / miesiąca.
  const lowest = SCALES[scale].scales.at(-1)!.unit;
  const highlight = useCallback(
    (date: Date, unit: string) => {
      if (unit !== lowest) return "";
      const day = fromDate(date);
      if (unit === "day") return day === today ? "tp-gantt-today" : "";
      if (unit === "week") return day <= today && today < addDays(day, 7) ? "tp-gantt-today-period" : "";
      if (unit === "month") return day.slice(0, 7) === today.slice(0, 7) ? "tp-gantt-today-period" : "";
      return "";
    },
    [today, lowest],
  );

  const scrollToday = useCallback(() => void api.current?.exec("scroll-chart", { date: toDate(addDays(today, -3)) }), [today]);

  const init = useCallback(
    (gantt: IApi) => {
      api.current = gantt;
      const titleOf = (id: string) => latest.current.data.tasks.find((t) => t.id === id)?.title ?? "?";
      // Edytor, menu i zmiany drzewa SVAR — nie: zadania edytuje panel zadania.
      for (const action of ["add-task", "delete-task", "move-task", "copy-task", "indent-task", "update-link"] as const) gantt.intercept(action, () => false);
      gantt.intercept("show-editor", (ev: { id: string | number | null }) => {
        const id = ev.id === null ? null : String(ev.id);
        if (id && !id.startsWith(PROJECT)) {
          select(id);
          openTask(id);
        }
        return false;
      });
      // Pojedyncze kliknięcie paska albo wiersza też otwiera panel zadania. SVAR wysyła `select-task`
      // z `toggle`/`range` tylko z kliknięcia myszą (nie po przeciągnięciu paska, nie ze strzałek ani
      // menu kontekstowego); Ctrl / Shift zostawiamy na zaznaczanie w SVAR.
      gantt.on("select-task", (ev: { id: string | number; toggle?: boolean; range?: boolean }) => {
        const id = String(ev.id);
        if (typeof ev.toggle !== "boolean" || ev.toggle || ev.range || id.startsWith(PROJECT)) return;
        select(id);
        openTask(id);
      });
      gantt.on("open-task", (ev: { id: string | number; mode: boolean }) =>
        setClosed((all) => {
          const next = new Set(all);
          if (ev.mode) next.delete(String(ev.id));
          else next.add(String(ev.id));
          return next;
        }),
      );

      gantt.intercept("update-task", (ev: { id: string | number; task: Partial<ITask>; diff?: number; inProgress?: boolean; eventSource?: string }) => {
        // Przesunięcia wyliczone przez SVAR (podzadania projektu, zakres projektu) i podgląd w trakcie przeciągania.
        if (ev.inProgress || ev.eventSource) return true;
        if (!ev.task.start && !ev.task.end) return false; // np. uchwyt postępu — postęp wynika z ukończonych
        const id = String(ev.id);
        const { data: d, deps: all, model: m, cascade: on } = latest.current;
        // Wiersz bez własnego terminu (zakres z potomków) — nie do przeciągania.
        const span = m.rows.find((r) => (r.kind === "project" ? `${PROJECT}${r.id}` : r.id) === id)?.span;
        if (!span) return false;
        let next: Span;
        if (ev.task.start && ev.task.end && ev.diff) {
          // Przesunięcie całego paska: SVAR podaje je w `diff` (dni), a daty w zdarzeniu bywają sprzed ruchu (projekt).
          next = { start: addDays(span.start, ev.diff), end: addDays(span.end, ev.diff) };
        } else {
          const current = gantt.getTask(ev.id);
          const start = ev.task.start ?? current?.start;
          const end = ev.task.end ?? current?.end;
          if (!start || !end) return false;
          next = { start: fromDate(start), end: addDays(fromDate(end), -1) };
        }
        if (id.startsWith(PROJECT)) {
          const projectId = id.slice(PROJECT.length);
          const list = d.lists.find((l) => l.id === projectId);
          if (!list) return false;
          const delta = daysBetween(span.start, next.start);
          if (delta && delta === daysBetween(span.end, next.end)) {
            const result = shiftProjectOps({ id: list.id, name: list.name, startDate: list.startDate, endDate: list.endDate }, d.tasks, all, delta, { cascade: on });
            void run(result.ops, { text: `„${list.name}” przesunięty o ${plural(Math.abs(delta), ["dzień", "dni", "dni"])} ${delta > 0 ? "później" : "wcześniej"} (${plural(result.changed, ["zadanie", "zadania", "zadań"])})`, undo: result.undo });
            return true;
          }
          // Rozciągnięcie projektu — daty projektu.
          void run([{ table: "lists", id: list.id, patch: { start_date: next.start, end_date: next.end } }], { text: `Daty projektu „${list.name}” zmienione`, undo: [{ table: "lists", id: list.id, patch: { start_date: list.startDate, end_date: list.endDate } }] });
          return true;
        }
        const result = timelineChangeOps(d.tasks, all, id, next, { cascade: on });
        if (!result.ops.length) return true;
        const others = result.changed - (result.ops.some((o) => o.id === id) ? 1 : 0);
        void run(result.ops, { text: others ? `„${titleOf(id)}” i ${plural(others, ["zależne zadanie", "zależne zadania", "zależnych zadań"])} przesunięte` : `Nowe daty „${titleOf(id)}”`, undo: result.undo });
        return true;
      });

      gantt.intercept("add-link", (ev: { link: Partial<ILink> }) => {
        const source = String(ev.link.source ?? "");
        const target = String(ev.link.target ?? "");
        if (source.startsWith(PROJECT) || target.startsWith(PROJECT)) {
          notify("Zależności łączą zadania, nie projekty.");
          return false;
        }
        if (ev.link.type !== "e2s") {
          notify("Tylko zależność koniec → początek: przeciągnij z prawego końca paska na lewy koniec następnego.");
          return false;
        }
        const { data: d, deps: all } = latest.current;
        const result = addDependencyOps(d.tasks, all, { predecessorId: source, successorId: target });
        if ("error" in result) notify(dependencyErrorText(result.error, (id) => `„${titleOf(id)}”`));
        else void run(result.ops, { text: `Zależność: „${titleOf(source)}” → „${titleOf(target)}”`, undo: result.undo });
        return false;
      });
      gantt.intercept("delete-link", (ev: { id: string | number }) => {
        const dep = latest.current.deps.find((x) => x.id === String(ev.id));
        if (dep) {
          const result = removeDependencyOps(dep.id);
          void run(result.ops, { text: `Usunięto zależność „${titleOf(dep.predecessorId)}” → „${titleOf(dep.successorId)}”`, undo: result.undo });
        }
        return false;
      });
      setTimeout(() => void gantt.exec("scroll-chart", { date: toDate(addDays(today, -3)) }), 0);
    },
    // `init` SVAR woła raz; bieżące dane bierze z `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // „Popraw” przesuwa następnika razem z jego następnikami — bez nowych naruszeń dalej w łańcuchu.
  const fix = (successorId: string, days: number) => {
    const { data: d, deps: all } = latest.current;
    const task = d.tasks.find((t) => t.id === successorId);
    const row = model.rows.find((r) => r.id === successorId);
    if (!task || !row?.span) return;
    const result = timelineChangeOps(d.tasks, all, successorId, { start: addDays(row.span.start, days), end: addDays(row.span.end, days) });
    void run(result.ops, { text: `„${task.title}” przesunięte o ${plural(days, ["dzień", "dni", "dni"])}`, undo: result.undo });
  };
  const titleOf = (id: string) => data.tasks.find((t) => t.id === id)?.title ?? "?";
  const linkCss = model.violations.map((v) => `.tp-timeline [data-link-id=":${v.dependency.id}"] .wx-line-draw{stroke:var(--danger);stroke-width:2px}`).join("");
  // Pasek projektu w kolorze projektu z paska bocznego (postęp pełnym kolorem, reszta jaśniej); bez koloru —
  // szary jak znacznik w pasku bocznym.
  const projectCss = projects
    .map((p) => {
      const color = p.color && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "var(--muted)";
      return `.tp-timeline .wx-bar[data-id=":${PROJECT}${p.id}"]{--wx-gantt-summary-color:color-mix(in srgb, ${color} 55%, white);--wx-gantt-summary-fill-color:${color};--wx-gantt-summary-font-color:#fff}`;
    })
    .join("");

  return (
    <section className="tp-timeline flex flex-col gap-2" aria-label="Oś czasu" data-testid="timeline">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">Oś czasu</h1>
        <div className="flex overflow-hidden rounded-md border border-[var(--line)] text-xs" role="group" aria-label="Skala">
          {(Object.keys(SCALES) as Scale[]).map((s) => (
            <button key={s} type="button" aria-pressed={scale === s} className={`px-2.5 py-1 ${scale === s ? "bg-[var(--accent)] text-white" : "hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => setScale(s)}>
              {SCALES[s].label}
            </button>
          ))}
        </div>
        <button type="button" className="rounded-md border border-[var(--line)] px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10" onClick={scrollToday}>
          Dziś
        </button>
        <label className="flex items-center gap-1.5 text-xs" title="Przesunięcie zadania przesuwa też zadania od niego zależne (kaskadowo, z zachowaniem odstępów)">
          <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
          Przesuń zależne
        </label>
        <span className="ml-auto text-xs text-[var(--muted)]">
          {plural(projects.length, ["projekt", "projekty", "projektów"])} · {plural(model.links.length, ["zależność", "zależności", "zależności"])}
          {model.undated ? ` · ${plural(model.undated, ["zadanie", "zadania", "zadań"])} bez terminu poza osią` : ""}
        </span>
      </header>

      {model.violations.length ? (
        <section className="rounded-md border border-[var(--danger)]/40 bg-red-50 p-2 text-xs dark:bg-red-950/30" aria-label="Naruszenia zależności">
          <h2 className="mb-1 font-semibold text-[var(--danger)]">⚠ {plural(model.violations.length, ["naruszona zależność", "naruszone zależności", "naruszonych zależności"])}</h2>
          <ul className="flex flex-col gap-0.5">
            {model.violations.map((v) => (
              <li key={v.dependency.id} className="flex flex-wrap items-center gap-x-2">
                <span>
                  „{titleOf(v.dependency.successorId)}” zaczyna się {plural(v.days, ["dzień", "dni", "dni"])} za wcześnie po „{titleOf(v.dependency.predecessorId)}”
                  {v.dependency.lagDays ? ` (+${plural(v.dependency.lagDays, ["dzień", "dni", "dni"])} odstępu)` : ""}
                </span>
                <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => fix(v.dependency.successorId, v.days)}>
                  Popraw
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {projects.length ? (
        <div className="h-[calc(100vh-11rem)] min-h-80 overflow-hidden rounded-md border border-[var(--line)]">
          <style>{linkCss + projectCss}</style>
          <Chart tasks={ganttTasks} links={ganttLinks} scale={scale} start={range.start} end={range.end} highlight={highlight} dark={dark} init={init} />
        </div>
      ) : (
        <p className="py-6 text-sm text-[var(--muted)]">Brak projektów — oś czasu pokazuje listy typu „projekt” z ich zadaniami. Projekt utworzysz w „Przestrzenie i listy”.</p>
      )}
      <p className="text-xs text-[var(--muted)]">Przeciągnij pasek, żeby zmienić daty, krawędź — żeby zmienić początek albo koniec. Zależność: z prawego końca paska na lewy koniec następnego; kliknij strzałkę, żeby ją usunąć. Kliknięcie paska albo wiersza otwiera zadanie.</p>
    </section>
  );
}
