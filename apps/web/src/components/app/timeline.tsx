"use client";

/**
 * Oś czasu (M12, Etap 6): SVAR React Gantt (D18) nad `core/timeline.ts` — projekty → zadania →
 * podzadania, paski od `start_date` do `due_date`, postęp, linia „dziś”, skale dzień / tydzień /
 * miesiąc. Przesunięcie i rozciągnięcie paska zapisuje daty (`timelineChangeOps`, z „Przesuń zależne”
 * albo „Tylko to zadanie”), pasek projektu przesuwa cały projekt (`shiftProjectOps`). Klik w wiersz
 * albo pasek zadania otwiera panel zadania, a projektu — listę projektu. Zależność
 * koniec→początek: przeciągnięcie z końca paska na początek drugiego — zapis dopiero po
 * `addDependencyOps` (blokada cyklu; SVAR cykle przyjmuje). Naruszenia: czerwone paski i strzałki
 * oraz lista z „Popraw”. „Ścieżka krytyczna” (core `criticalPath`, zapas w dniach roboczych z ustawień) barwi
 * zadania bez zapasu i ich zależności na pomarańczowo, dodaje kolumnę „Zapas” i podsumowanie projektów. Filtr „Projekty” ukrywa wybrane projekty (pamiętany w przeglądarce; nowy projekt
 * jest widoczny), „Eksport XLSX” zapisuje widoczne wiersze osi (`timelineSheet` + `xlsxWorkbook`).
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
  contrastRatio,
  daysBetween,
  dependencyErrorText,
  dayMonth,
  plural,
  projectFilterLabel,
  READONLY_LIST_NOTE,
  removeDependencyOps,
  shiftProjectOps,
  timelineChangeOps,
  timelineFileName,
  timelineGridSheet,
  timelineModel,
  timelineRowSpans,
  timelineSheet,
  visibleProjects,
  type Dependency,
  type LocalDate,
  type ProfileSettings,
  type Span,
  type TimelineModel,
  type ViewContext,
  type ViewTask,
} from "@taskplanner/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { listEditable, type AppData } from "@/lib/app-data";
import { useDependencies } from "@/lib/dependencies";
import { GANTT_PL } from "@/lib/gantt-locale";
import { useRoute } from "@/lib/route";

import { useAppEnv } from "./app-env";
import { ExportButton } from "./export";
import { Check, Popover } from "./filter-bar";
import { PeopleBadges } from "./people-badges";
import { useTaskActions } from "./task-item";

type Scale = "day" | "week" | "month";
const SCALE_KEY = "tp-timeline-scale";
const CASCADE_KEY = "tp-timeline-cascade";
const HIDDEN_KEY = "tp-timeline-hidden";
const UNDATED_KEY = "tp-timeline-undated";
const CRITICAL_KEY = "tp-timeline-critical";
const WIDTHS_KEY = "tp-timeline-widths";
const PROJECT = "p:";

/** Wiersz osi (zadanie albo `PROJECT` + id listy) na liście, którą użytkownik może edytować. */
const rowEditable = (d: AppData, rowId: string): boolean => {
  const listId = rowId.startsWith(PROJECT) ? rowId.slice(PROJECT.length) : d.tasks.find((t) => t.id === rowId)?.listId;
  return !listId || listEditable(d, listId);
};

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
const tasksById = new WeakMap<readonly ViewTask[], Map<string, ViewTask>>();
/** Tytuł w siatce + znaczki osób (odpowiedzialny, uczestnicy) jak na liście; projekt — sam tytuł. */
function TitleCell({ row: cellRow }: { row: object }) {
  const row = cellRow as { id?: unknown; text?: unknown };
  const { data } = useAppEnv();
  let byId = tasksById.get(data.tasks);
  if (!byId) tasksById.set(data.tasks, (byId = new Map(data.tasks.map((t) => [t.id, t]))));
  const task = byId.get(String(row.id));
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{String(row.text ?? "")}</span>
      {task ? <PeopleBadges task={task} /> : null}
    </span>
  );
}

// Wiersz bez żadnej daty (`barless`) ma w SVAR zastępczy dzisiejszy dzień — w tabeli „—”.
// `resize` = szerokość kolumny przeciągana na krawędzi nagłówka (ostatniej kolumnie SVAR jej nie daje — tam jest podział siatka / oś).
const COLUMNS: IColumnConfig[] = [
  { id: "text", header: "Zadanie", flexgrow: 1, width: 200, sort: false, resize: true, cell: TitleCell },
  { id: "start", header: "Początek", width: 78, align: "center", sort: false, resize: true, template: (v: unknown, row: object) => ("barless" in row ? "—" : shortDay(v)) },
  { id: "duration", header: "Dni", width: 56, align: "center", sort: false, resize: true, template: (v: unknown, row: object) => ("barless" in row ? "—" : String(v ?? "")) },
];
/** Z „Ścieżką krytyczną”: zapas zadania w dniach (roboczych); projekt, ukończone i bez paska — „—”. */
const CRITICAL_COLUMNS: IColumnConfig[] = [...COLUMNS, { id: "float", header: "Zapas", width: 60, align: "center", sort: false, resize: true, template: (v: unknown) => (typeof v === "number" ? String(v) : "—") }];

/**
 * Szerokości przeciągnięte w siatce (per przeglądarka): kolumny jak po `set-columns` SVAR (szerokość +
 * która kolumna wypełnia resztę — po poszerzeniu „Zadanie” SVAR przenosi `flexgrow` na inną) i szerokość
 * całej siatki (podział siatka / oś, `resize-grid`).
 */
interface StoredWidths {
  columns: Record<string, { width: number; flexgrow?: number }>;
  grid?: number;
}
const sane = (v: unknown, min: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= 4000;
function readWidths(): StoredWidths {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}");
    if (!v || typeof v !== "object") return { columns: {} };
    const raw = v as { columns?: unknown; grid?: unknown };
    const columns: StoredWidths["columns"] = {};
    if (raw.columns && typeof raw.columns === "object") {
      for (const [id, c] of Object.entries(raw.columns as Record<string, { width?: unknown; flexgrow?: unknown }>)) {
        if (c && sane(c.width, 20)) columns[id] = { width: c.width, ...(sane(c.flexgrow, 0.01) ? { flexgrow: c.flexgrow } : {}) };
      }
    }
    return { columns, ...(sane(raw.grid, 100) ? { grid: raw.grid } : {}) };
  } catch {
    return { columns: {} };
  }
}
function saveWidths(change: (w: StoredWidths) => StoredWidths) {
  remember(WIDTHS_KEY, JSON.stringify(change(readWidths())));
}
/** Kolumny z zapamiętanymi szerokościami; gdy żadna nie wypełnia reszty (np. inny zestaw kolumn), wypełnia „Zadanie”. */
function withWidths(columns: IColumnConfig[], stored: StoredWidths["columns"]): IColumnConfig[] {
  const out = columns.map((c) => {
    const s = c.id ? stored[c.id] : undefined;
    if (!s) return c;
    const next: IColumnConfig = { ...c, width: s.width };
    if (s.flexgrow) next.flexgrow = s.flexgrow;
    else delete next.flexgrow;
    return next;
  });
  return out.some((c) => c.flexgrow) ? out : out.map((c) => (c.id === "text" ? { ...c, flexgrow: 1 } : c));
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
/** Ukryte projekty filtra (id) z pamięci przeglądarki. */
function readHidden(): ReadonlySet<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
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

interface FilterProject {
  id: string;
  name: string;
  color: string | null;
}

/** Wybór projektów na osi: lista z polami wyboru, „Wszystkie” / „Żaden”, „tylko” przy projekcie. */
function ProjectFilter({ projects, hidden, onChange }: { projects: readonly FilterProject[]; hidden: ReadonlySet<string>; onChange: (hidden: ReadonlySet<string>) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const filtered = visibleProjects(projects, hidden).length !== projects.length;
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <span className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="timeline-projects"
        className={`max-w-56 truncate rounded-md border px-2.5 py-1 text-xs ${filtered ? "border-transparent bg-indigo-100 text-indigo-900 dark:bg-indigo-900/50 dark:text-indigo-100" : "border-[var(--line)] hover:bg-black/5 dark:hover:bg-white/10"}`}
        onClick={() => setOpen((o) => !o)}
      >
        Projekty: {projectFilterLabel(projects, hidden)} ▾
      </button>
      {open ? (
        <Popover onClose={close}>
          <div className="mb-1 flex gap-3 px-2 text-xs">
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => onChange(new Set())}>
              Wszystkie
            </button>
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => onChange(new Set(projects.map((p) => p.id)))}>
              Żaden
            </button>
          </div>
          {projects.map((p) => (
            <div key={p.id} className="group flex items-center">
              <div className="min-w-0 flex-1">
                <Check checked={!hidden.has(p.id)} onChange={() => toggle(p.id)}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "var(--muted)" }} aria-hidden />
                  <span className="truncate">{p.name}</span>
                </Check>
              </div>
              <button type="button" title={`Pokaż tylko „${p.name}”`} className="px-1.5 text-xs text-[var(--muted)] opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 hover:text-[var(--foreground)] focus:opacity-100" onClick={() => onChange(new Set(projects.filter((x) => x.id !== p.id).map((x) => x.id)))}>
                tylko
              </button>
            </div>
          ))}
        </Popover>
      ) : null}
    </span>
  );
}

/** Pasek: tytuł, ukończone przekreślone, naruszenie na czerwono, ścieżka krytyczna (gdy włączona) na pomarańczowo. */
function Bar({ data }: { data: ITask }) {
  const tone = data.violated ? "tp-gantt-violated" : data.critical ? "tp-gantt-critical" : "";
  return (
    <div className={`h-full w-full truncate px-1 text-[11px] leading-[inherit] ${tone} ${data.done ? "line-through opacity-70" : ""}`} data-violated={data.violated || undefined} data-critical={data.critical || undefined}>
      {data.violated ? "⚠ " : ""}
      {data.text}
    </div>
  );
}

interface ChartProps {
  tasks: ITask[];
  links: ILink[];
  columns: IColumnConfig[];
  scale: Scale;
  start: Date;
  end: Date;
  highlight: (date: Date, unit: string) => string;
  dark: boolean;
  gridWidth: number | undefined;
  init: (api: IApi) => void;
}

/** SVAR rysuje się od nowa tylko przy zmianie danych osi (memo). */
const Chart = memo(function Chart({ tasks, links, columns, scale, start, end, highlight, dark, gridWidth, init }: ChartProps) {
  const Theme = dark ? WillowDark : Willow;
  return (
    <Locale words={GANTT_PL}>
      <Theme>
        <Gantt
          init={init}
          tasks={tasks}
          links={links}
          columns={columns}
          {...(gridWidth ? { gridWidth } : {})}
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
  settings: ProfileSettings;
}

export function TimelineScreen({ data, ctx, active }: { data: AppData; ctx: ViewContext; active: boolean }) {
  const { store: tabStore, openTask, openTaskId, select, settings, userId } = useAppEnv();
  const { run, notify } = useTaskActions();
  const [, navigate] = useRoute();
  const deps = useDependencies(tabStore);
  const dark = useDark();
  const [scale, setScaleState] = useState<Scale>(() => readStored(SCALE_KEY, ["day", "week", "month"], "day"));
  const [cascade, setCascadeState] = useState(() => readStored(CASCADE_KEY, ["1", "0"], "1") === "1");
  // Zadania bez terminu jako wiersze bez paska — widać całe drzewo projektu.
  const [withUndated, setWithUndatedState] = useState(() => readStored(UNDATED_KEY, ["1", "0"], "1") === "1");
  const [showCritical, setShowCriticalState] = useState(() => readStored(CRITICAL_KEY, ["1", "0"], "0") === "1");
  // Zapamiętane szerokości; po każdym przeciągnięciu wracają do propsów — SVAR przy przerysowaniu bierze kolumny z propsa.
  const [widthsVersion, setWidthsVersion] = useState(0);
  const columns = useMemo(() => withWidths(showCritical ? CRITICAL_COLUMNS : COLUMNS, readWidths().columns), [showCritical, widthsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const gridWidth = useMemo(() => readWidths().grid, [widthsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // Zwinięte zadania — do odświeżenia; zwinięte projekty — w profilu (`settings.timeline.collapsed`,
  // synchronizowane), więc zostają dla użytkownika na każdym urządzeniu.
  const [closedTasks, setClosedTasks] = useState<ReadonlySet<string>>(() => new Set());
  const collapsedProjects = settings.timeline.collapsed;
  const closed = useMemo(() => new Set([...closedTasks, ...collapsedProjects.map((id) => `${PROJECT}${id}`)]), [closedTasks, collapsedProjects]);
  const [hidden, setHiddenState] = useState<ReadonlySet<string>>(readHidden);
  const api = useRef<IApi | null>(null);
  const { today, workspaceId } = ctx;

  const allProjects = useMemo(
    () => data.lists.filter((l) => l.kind === "project" && (!workspaceId || l.workspaceId === workspaceId)).map((l) => ({ id: l.id, name: l.name, color: l.color, startDate: l.startDate, endDate: l.endDate })),
    [data.lists, workspaceId],
  );
  const projects = useMemo(() => visibleProjects(allProjects, hidden), [allProjects, hidden]);
  // Ukryty widok nie przelicza osi; po powrocie przelicza ją tylko, gdy dane się zmieniły (inaczej SVAR
  // nie dostaje nowych tablic i nic nie rysuje — przełączenie < 150 ms).
  // Zapas ścieżki krytycznej w dniach roboczych z ustawień („Godziny pracy”).
  const workdays = settings.workHours.days;
  const [cache, setCache] = useState(() => ({ projects, tasks: data.tasks, deps, withUndated, workdays, model: timelineModel(projects, data.tasks, deps, { withUndated, workdays }) }));
  if (active && (cache.projects !== projects || cache.tasks !== data.tasks || cache.deps !== deps || cache.withUndated !== withUndated || cache.workdays !== workdays)) {
    setCache({ projects, tasks: data.tasks, deps, withUndated, workdays, model: timelineModel(projects, data.tasks, deps, { withUndated, workdays }) });
  }
  const { model } = cache;

  const latest = useRef<Latest>({ data, deps, model, cascade, settings });
  useEffect(() => {
    latest.current = { data, deps, model, cascade, settings };
  });

  const setScale = (s: Scale) => {
    setScaleState(s);
    remember(SCALE_KEY, s);
  };
  const setCascade = (on: boolean) => {
    setCascadeState(on);
    remember(CASCADE_KEY, on ? "1" : "0");
  };
  const setWithUndated = (on: boolean) => {
    setWithUndatedState(on);
    remember(UNDATED_KEY, on ? "1" : "0");
  };
  const setShowCritical = (on: boolean) => {
    setShowCriticalState(on);
    remember(CRITICAL_KEY, on ? "1" : "0");
  };
  const setHidden = (next: ReadonlySet<string>) => {
    setHiddenState(next);
    remember(HIDDEN_KEY, JSON.stringify([...next]));
  };

  // Eksport: karta „Oś czasu” = siatka okresów bieżącej skali (komórka na dzień / tydzień / miesiąc,
  // pasek w kolorze projektu), karta „Szczegóły” = tabela wierszy z poprzednikami i naruszeniami.
  const exportSheets = () => [
    timelineGridSheet(model, { scale, today, colors: new Map(projects.map((p) => [p.id, p.color])), firstDayOfWeek: ctx.firstDayOfWeek }),
    timelineSheet(model, data.tasks, "Szczegóły"),
  ];
  const exportSummary = () => `${plural(projects.length, ["projekt", "projekty", "projektów"])}, ${plural(model.rows.filter((r) => r.kind === "task").length, ["zadanie", "zadania", "zadań"])}, skala: ${SCALES[scale].label.toLowerCase()}`;

  const { ganttTasks, barless } = useMemo(() => {
    const kinds = new Map(model.rows.map((r) => [r.id, r.kind]));
    // Darmowy SVAR nie ma wierszy bez dat: zadanie bez terminu (z podzadaniami z terminem) i pusty
    // projekt dostają zakres potomków albo dzisiejszy dzień — bez przeciągania (`update-task` blokuje).
    // Wiersz bez żadnej daty (ani własnej, ani potomków) ma pasek ukryty (`barless`).
    const shown = timelineRowSpans(model.rows);
    const barless: string[] = [];
    const ganttTasks = model.rows.map((r): ITask => {
      const id = r.kind === "project" ? `${PROJECT}${r.id}` : r.id;
      const none = !shown.has(r.id);
      if (none) barless.push(id);
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
        ...(showCritical ? { critical: r.critical, float: r.float } : {}),
        ...(none ? { barless: true } : {}),
      };
    });
    return { ganttTasks, barless };
  }, [model.rows, closed, today, showCritical]);

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

  // Zadanie otwarte w panelu (np. „↑ rodzic” w panelu, palety, innego widoku) = zaznaczony wiersz osi.
  // `select-task` bez `toggle` nie otwiera panelu ponownie (słuchacz niżej reaguje tylko na kliknięcia).
  useEffect(() => {
    const gantt = api.current;
    if (!active || !openTaskId || !gantt) return;
    const { selected } = gantt.getState();
    if (selected?.length === 1 && String(selected[0]) === openTaskId) return;
    if (!gantt.getTask(openTaskId)) return; // brak wiersza: zadanie spoza osi albo ukryty projekt
    void gantt.exec("select-task", { id: openTaskId, show: "y" });
  }, [openTaskId, active, ganttTasks]);

  const init = useCallback(
    (gantt: IApi) => {
      api.current = gantt;
      // Szerokości przeciągnięte w siatce — zapamiętane do następnego otwarcia (`tp-timeline-widths`).
      gantt.on("set-columns", (ev: { columns: { id?: string; width?: number; flexgrow?: number }[] }) => {
        saveWidths((w) => {
          const columns = { ...w.columns };
          for (const c of ev.columns) if (c.id && c.width) columns[c.id] = { width: c.width, ...(c.flexgrow ? { flexgrow: c.flexgrow } : {}) };
          return { ...w, columns };
        });
        setWidthsVersion((v) => v + 1);
      });
      gantt.on("resize-grid", (ev: { width: number; section?: string; inProgress?: boolean }) => {
        if (ev.inProgress || (ev.section ?? "grid") !== "grid") return;
        saveWidths((w) => ({ ...w, grid: Math.round(ev.width) }));
        setWidthsVersion((v) => v + 1);
      });
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
      // Pojedyncze kliknięcie paska albo wiersza też otwiera panel zadania, a projektu — jego listę. SVAR
      // wysyła `select-task` z `toggle`/`range` tylko z kliknięcia myszą (nie po przeciągnięciu paska, nie ze
      // strzałek, menu kontekstowego ani strzałki zwijania); Ctrl / Shift zostawiamy na zaznaczanie w SVAR.
      gantt.on("select-task", (ev: { id: string | number; toggle?: boolean; range?: boolean }) => {
        const id = String(ev.id);
        if (typeof ev.toggle !== "boolean" || ev.toggle || ev.range) return;
        if (id.startsWith(PROJECT)) return navigate({ view: "list", id: id.slice(PROJECT.length) });
        select(id);
        openTask(id);
      });
      gantt.on("open-task", (ev: { id: string | number; mode: boolean }) => {
        const id = String(ev.id);
        if (id.startsWith(PROJECT)) {
          // Projekt: zapis do profilu (bez id projektów, których już nie ma).
          const { settings: current, data: now } = latest.current;
          const listId = id.slice(PROJECT.length);
          const projects = new Set(now.lists.filter((l) => l.kind === "project").map((l) => l.id));
          const next = current.timeline.collapsed.filter((x) => x !== listId && projects.has(x));
          if (!ev.mode) next.push(listId);
          if (next.join() === current.timeline.collapsed.join()) return;
          void tabStore.mutate("profiles", userId, { settings: { ...current, timeline: { ...current.timeline, collapsed: next } } }).catch((e: unknown) => notify(String(e)));
          return;
        }
        setClosedTasks((all) => {
          const next = new Set(all);
          if (ev.mode) next.delete(id);
          else next.add(id);
          return next;
        });
      });

      gantt.intercept("update-task", (ev: { id: string | number; task: Partial<ITask>; diff?: number; inProgress?: boolean; eventSource?: string }) => {
        // Przesunięcia wyliczone przez SVAR (podzadania projektu, zakres projektu) i podgląd w trakcie przeciągania.
        if (ev.inProgress || ev.eventSource) return true;
        if (!ev.task.start && !ev.task.end) return false; // np. uchwyt postępu — postęp wynika z ukończonych
        const id = String(ev.id);
        const { data: d, deps: all, model: m, cascade: on } = latest.current;
        // Lista tylko do podglądu (udostępniona) — `false` cofa pasek na miejsce zamiast zostawić go po odrzuconym zapisie.
        if (!rowEditable(d, id)) {
          notify(READONLY_LIST_NOTE);
          return false;
        }
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
        if (!rowEditable(d, source) || !rowEditable(d, target)) {
          notify(READONLY_LIST_NOTE);
          return false;
        }
        const result = addDependencyOps(d.tasks, all, { predecessorId: source, successorId: target });
        if ("error" in result) notify(dependencyErrorText(result.error, (id) => `„${titleOf(id)}”`));
        else void run(result.ops, { text: `Zależność: „${titleOf(source)}” → „${titleOf(target)}”`, undo: result.undo });
        return false;
      });
      gantt.intercept("delete-link", (ev: { id: string | number }) => {
        const dep = latest.current.deps.find((x) => x.id === String(ev.id));
        if (dep && !rowEditable(latest.current.data, dep.successorId)) notify(READONLY_LIST_NOTE);
        else if (dep) {
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
  const barlessCss = barless.length ? `${barless.map((id) => `.tp-timeline .wx-bar[data-id=":${id}"]`).join(",")}{display:none}` : "";
  const criticalCss = showCritical ? model.criticalLinks.map((id) => `.tp-timeline [data-link-id=":${id}"] .wx-line-draw{stroke:var(--critical);stroke-width:2px}`).join("") : "";
  const linkCss = model.violations.map((v) => `.tp-timeline [data-link-id=":${v.dependency.id}"] .wx-line-draw{stroke:var(--danger);stroke-width:2px}`).join("");
  // Pasek projektu w kolorze projektu z paska bocznego (postęp pełnym kolorem, reszta jaśniej); bez koloru —
  // szary jak znacznik w pasku bocznym.
  const projectCss = projects
    .map((p) => {
      const color = p.color && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "var(--muted)";
      // Dowolny jasny kolor: ciemny podpis zamiast białego.
      const font = color.startsWith("#") && contrastRatio("#FFFFFF", color) < 2.5 ? "#18181b" : "#fff";
      return `.tp-timeline .wx-bar[data-id=":${PROJECT}${p.id}"]{--wx-gantt-summary-color:color-mix(in srgb, ${color} 55%, white);--wx-gantt-summary-fill-color:${color};--wx-gantt-summary-font-color:${font}}`;
    })
    .join("");

  return (
    <section className="tp-timeline flex flex-col gap-2" aria-label="Oś czasu" data-testid="timeline">
      <header className="tp-view-header flex flex-wrap items-center gap-2">
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
        <label className="flex items-center gap-1.5 text-xs" title="Pokaż też zadania bez terminu (wiersze bez paska) — termin ustawisz w panelu zadania">
          <input type="checkbox" checked={withUndated} onChange={(e) => setWithUndated(e.target.checked)} />
          Bez terminu
        </label>
        <label className="flex items-center gap-1.5 text-xs" title="Zadania bez zapasu: ich spóźnienie przesuwa koniec projektu. Zapas w dniach roboczych z Ustawień (Godziny pracy).">
          <input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} />
          Ścieżka krytyczna
        </label>
        {allProjects.length ? <ProjectFilter projects={allProjects} hidden={hidden} onChange={setHidden} /> : null}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-[var(--muted)]">
            {projects.length === allProjects.length ? plural(projects.length, ["projekt", "projekty", "projektów"]) : `${projects.length} z ${plural(allProjects.length, ["projektu", "projektów", "projektów"])}`} · {plural(model.links.length, ["zależność", "zależności", "zależności"])}
            {model.undated ? ` · ${plural(model.undated, ["zadanie", "zadania", "zadań"])} bez terminu${withUndated ? "" : " poza osią"}` : ""}
          </span>
          <ExportButton
            fileName={timelineFileName(today)}
            build={exportSheets}
            summary={exportSummary}
            disabled={!model.rows.length}
            title="Zapisz widoczne wiersze osi (po filtrze projektów) do pliku Excel — kolumna na każdy dzień / tydzień / miesiąc bieżącej skali"
            testId="timeline-export"
          />
        </div>
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

      {showCritical && projects.length ? <CriticalSummary model={model} projects={projects} titleOf={titleOf} openTask={openTask} /> : null}

      {projects.length ? (
        <div className="h-[calc(100vh-11rem)] min-h-80 overflow-hidden rounded-md border border-[var(--line)]">
          <style>{criticalCss + linkCss + projectCss + barlessCss}</style>
          <Chart tasks={ganttTasks} links={ganttLinks} columns={columns} gridWidth={gridWidth} scale={scale} start={range.start} end={range.end} highlight={highlight} dark={dark} init={init} />
        </div>
      ) : allProjects.length ? (
        <p className="py-6 text-sm text-[var(--muted)]">
          Żaden projekt nie jest wybrany.{" "}
          <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setHidden(new Set())}>
            Pokaż wszystkie
          </button>
        </p>
      ) : (
        <p className="py-6 text-sm text-[var(--muted)]">Brak projektów — oś czasu pokazuje listy typu „projekt” z ich zadaniami. Projekt utworzysz w „Przestrzenie i listy”.</p>
      )}
      <p className="text-xs text-[var(--muted)]">Przeciągnij pasek, żeby zmienić daty, krawędź — żeby zmienić początek albo koniec. Zależność: z prawego końca paska na lewy koniec następnego; kliknij strzałkę, żeby ją usunąć. Kliknięcie paska albo wiersza otwiera zadanie.</p>
    </section>
  );
}

/**
 * Podsumowanie ścieżki krytycznej: dla każdego projektu koniec i zadania bez zapasu w kolejności początku
 * („→” między zadaniami połączonymi zależnością na ścieżce, „·” — równoległe).
 */
function CriticalSummary({
  model,
  projects,
  titleOf,
  openTask,
}: {
  model: TimelineModel;
  projects: readonly { id: string; name: string }[];
  titleOf: (id: string) => string;
  openTask: (id: string) => void;
}) {
  const onPath = new Set(model.criticalLinks);
  const linked = new Set(model.links.filter((d) => onPath.has(d.id)).map((d) => `${d.predecessorId}>${d.successorId}`));
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  return (
    <section className="rounded-md border border-[var(--critical)]/40 bg-orange-50 p-2 text-xs dark:bg-orange-950/30" aria-label="Ścieżka krytyczna">
      <h2 className="mb-1 font-semibold text-[var(--critical)]">Ścieżka krytyczna</h2>
      {model.criticalChains.length ? (
        <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto">
          {model.criticalChains.map((c) => (
            <li key={c.projectId}>
              <span className="font-medium">{nameOf.get(c.projectId)}</span> — koniec {dayMonth(c.end)}:{" "}
              {c.taskIds.map((id, i) => (
                <span key={id}>
                  {i ? (linked.has(`${c.taskIds[i - 1]}>${id}`) ? " → " : " · ") : ""}
                  <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => openTask(id)}>
                    {titleOf(id)}
                  </button>
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[var(--muted)]">Brak otwartych zadań z terminem w widocznych projektach.</p>
      )}
    </section>
  );
}
