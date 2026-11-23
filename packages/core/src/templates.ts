/**
 * Szablony projektów (v1.x, PLAN_ETAPOWY.md → „Szablony projektów”): projekt (lista `kind = project`)
 * zapisany jako migawka — zadania z podzadaniami, tagi, przypomnienia, zależności i daty względne —
 * i nowy projekt z szablonu od daty startu albo końca.
 *
 * Daty względne: dzień 0 = początek projektu (`lists.start_date`; bez niego najwcześniejsza data
 * w projekcie), każda data jako przesunięcie w dniach kalendarzowych, `endDay` = koniec projektu
 * (bez końca — najpóźniejsza data). Szablon bez żadnej daty daje projekt bez dat.
 *
 * Szablon to wiersz `project_templates` w zakresie osobistym; cała treść w jednym polu `content`
 * (LWW zastępuje szablon w całości). Ten moduł nie importuje `schemas/model.ts` (który importuje
 * stąd schemat treści).
 */
import { z } from 'zod';

import { addDays, daysBetween } from './dates.ts';
import { plural } from './format.ts';
import { uuidv7 } from './ids.ts';
import { formatRrule, parseRrule } from './recurrence.ts';
import { keyBetween, renumber } from './sort-key.ts';
import { LocalDate, LocalTime, Priority } from './schemas/primitives.ts';
import { MAX_TASK_DEPTH, taskTagOps, type QuickAddScope, type TaskOp } from './tasks.ts';

// ── Schemat treści ───────────────────────────────────────────────────────────────────────────

/** Wersja formatu treści; nowsza od znanej = szablon z nowszej aplikacji (nie da się go użyć). */
export const TEMPLATE_VERSION = 1;

/** Przesunięcie w dniach względem początku projektu (± 10 lat). */
const Day = z.number().int().min(-3660).max(3660);
const Key = z.string().min(1).max(20);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Kolor w formacie #RRGGBB.');
const Name = (max: number) => z.string().trim().min(1, 'Nazwa nie może być pusta.').max(max);

/** Cykl zadania: kotwica serii i `UNTIL` jako przesunięcia (RRULE bez `UNTIL`). */
export const TemplateRecurrence = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('schedule'), rrule: z.string().min(1).max(500), anchorDay: Day, untilDay: Day.nullable() }),
  z.object({
    mode: z.literal('after_completion'),
    every: z.object({ unit: z.enum(['day', 'week', 'month', 'year']), n: z.number().int().min(1).max(999) }),
  }),
]);
export type TemplateRecurrence = z.infer<typeof TemplateRecurrence>;

export const TemplateReminder = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relative'), offsetMin: z.number().int().min(0).max(40_320) }),
  z.object({ kind: z.literal('absolute'), day: Day, time: LocalTime }),
]);
export type TemplateReminder = z.infer<typeof TemplateReminder>;

/** Zadanie szablonu; `key` łączy podzadania i zależności (id nowych zadań powstają przy tworzeniu). */
export const TemplateTask = z
  .object({
    key: Key,
    /** Rodzic (klucz zadania wcześniej w tablicy); `null` = zadanie główne projektu. */
    parent: Key.nullable(),
    title: Name(500),
    descriptionMd: z.string().max(100_000).nullable(),
    priority: Priority,
    startDay: Day.nullable(),
    dueDay: Day.nullable(),
    dueTime: LocalTime.nullable(),
    durationMin: z.number().int().min(1).max(10_080).nullable(),
    timeZone: z.string().min(1).max(64).nullable(),
    recurrence: TemplateRecurrence.nullable(),
    /** Nazwy tagów w kolejności zadania. */
    tags: z.array(Name(60)).max(50),
    reminders: z.array(TemplateReminder).max(20),
    /** Kolumna tablicy — indeks w `project.boardColumns`; `null` = „Do przypisania”. */
    boardColumn: z.number().int().min(0).max(49).nullable(),
  })
  .refine((t) => t.dueDay !== null || (t.dueTime === null && t.startDay === null), { message: 'Godzina i początek wymagają terminu.', path: ['dueDay'] })
  .refine((t) => t.startDay === null || t.dueDay === null || t.startDay <= t.dueDay, { message: 'Początek po terminie.', path: ['startDay'] });
export type TemplateTask = z.infer<typeof TemplateTask>;

export const TemplateDependency = z.object({ from: Key, to: Key, lagDays: z.number().int().min(-365).max(365) });
export type TemplateDependency = z.infer<typeof TemplateDependency>;

/** `project_templates.content`. */
export const ProjectTemplateContent = z
  .object({
    version: z.literal(TEMPLATE_VERSION),
    project: z.object({
      color: Hex.nullable(),
      icon: z.string().min(1).max(40).nullable(),
      descriptionMd: z.string().max(20_000).nullable(),
      /** Koniec projektu względem początku; `null` = szablon bez dat. */
      endDay: Day.min(0).nullable(),
      /** `lists.view_prefs` projektu (kopiowane bez zmian). */
      viewPrefs: z.record(z.string(), z.unknown()).nullable(),
      /** Nazwy własnych kolumn tablicy w kolejności. */
      boardColumns: z.array(Name(60)).max(50),
    }),
    /** Zadania w kolejności: rodzic przed podzadaniami, rodzeństwo w kolejności ręcznej. */
    tasks: z.array(TemplateTask).max(2000),
    dependencies: z.array(TemplateDependency).max(5000),
  })
  .superRefine((content, ctx) => {
    const depth = new Map<string, number>();
    content.tasks.forEach((task, index) => {
      if (depth.has(task.key)) ctx.addIssue({ code: 'custom', message: `Powtórzony klucz zadania „${task.key}”.`, path: ['tasks', index, 'key'] });
      const parentDepth = task.parent === null ? 0 : depth.get(task.parent);
      if (parentDepth === undefined) ctx.addIssue({ code: 'custom', message: 'Podzadanie przed swoim rodzicem.', path: ['tasks', index, 'parent'] });
      else if (parentDepth + 1 > MAX_TASK_DEPTH) ctx.addIssue({ code: 'custom', message: 'Za dużo poziomów podzadań.', path: ['tasks', index, 'parent'] });
      if (task.boardColumn !== null && task.boardColumn >= content.project.boardColumns.length) {
        ctx.addIssue({ code: 'custom', message: 'Nieznana kolumna tablicy.', path: ['tasks', index, 'boardColumn'] });
      }
      depth.set(task.key, (parentDepth ?? 0) + 1);
    });
    content.dependencies.forEach((d, index) => {
      if (!depth.has(d.from) || !depth.has(d.to) || d.from === d.to) ctx.addIssue({ code: 'custom', message: 'Zależność bez zadania.', path: ['dependencies', index] });
    });
  });
export type ProjectTemplateContent = z.infer<typeof ProjectTemplateContent>;

/** Treść z lokalnego wiersza (tekst JSON albo obiekt); zła / z nowszej wersji → `null`. */
export function parseTemplateContent(raw: unknown): ProjectTemplateContent | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = ProjectTemplateContent.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── Migawka projektu → szablon ───────────────────────────────────────────────────────────────

/** Wiersze projektu z lokalnej bazy (kolumny jsonb już zdekodowane) — `readProjectSource` w `packages/sync`. */
export interface ProjectSource {
  list: {
    color: string | null;
    icon: string | null;
    description_md: string | null;
    start_date: string | null;
    end_date: string | null;
    view_prefs: unknown;
    board_columns: unknown;
  };
  tasks: readonly {
    id: string;
    parent_id: string | null;
    kind: string;
    title: string;
    description_md: string | null;
    status: string;
    priority: number;
    start_date: string | null;
    due_date: string | null;
    due_time: string | null;
    duration_min: number | null;
    time_zone?: string | null;
    recurrence: unknown;
    sort_key: string;
    board_column_id?: string | null;
    deleted_at?: string | null;
  }[];
  /** Tagi zadań z nazwami, w kolejności zadania (`task_tags.sort_key`, potem kolejność dodania). */
  tags: readonly { task_id: string; name: string }[];
  reminders: readonly { task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }[];
  dependencies: readonly { predecessor_id: string; successor_id: string; lag_days: number }[];
}

const byKey = <T extends { sort_key: string; id: string }>(a: T, b: T) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isDate = (value: unknown): value is LocalDate => typeof value === 'string' && LocalDate.safeParse(value).success;
const asObject = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Zadania, które trafiają do szablonu: bez kosza, anulowanych i nawyków — razem z ich poddrzewem. */
function templateTasks(tasks: ProjectSource['tasks']): ProjectSource['tasks'][number][] {
  const children = new Map<string | null, ProjectSource['tasks'][number][]>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    if (task.deleted_at || task.status === 'cancelled' || task.kind !== 'task') continue;
    // Rodzic spoza projektu (nie powinno się zdarzyć) — zadanie główne.
    const parent = task.parent_id && ids.has(task.parent_id) ? task.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  const out: ProjectSource['tasks'][number][] = [];
  const walk = (parent: string | null, depth: number) => {
    if (depth > MAX_TASK_DEPTH) return;
    for (const task of (children.get(parent) ?? []).sort(byKey)) {
      out.push(task);
      walk(task.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

/** Kotwica i `UNTIL` cyklu według harmonogramu (zły zapis → bez cyklu). */
function scheduleParts(recurrence: unknown): { rrule: string; anchor: LocalDate; until: LocalDate | null } | null {
  const value = asObject(recurrence);
  if (!value || value.mode !== 'schedule' || typeof value.rrule !== 'string' || !isDate(value.anchor)) return null;
  try {
    const rule = parseRrule(value.rrule);
    const until = rule.until ?? null;
    delete rule.until;
    return { rrule: formatRrule(rule), anchor: value.anchor, until };
  } catch {
    return null;
  }
}

/**
 * Projekt → treść szablonu. Status, ukończenia, osoby, komentarze, załączniki, czas i pozycje
 * karteczek pomijane; zadania anulowane, w koszu i nawyki — razem z poddrzewem.
 */
export function projectTemplateContent(source: ProjectSource): ProjectTemplateContent {
  const tasks = templateTasks(source.tasks);
  const keyOf = new Map(tasks.map((task, index) => [task.id, `t${(index + 1).toString(36)}`]));
  const reminders = source.reminders.filter((r) => keyOf.has(r.task_id));

  // Dzień 0: początek projektu albo najwcześniejsza data w projekcie (także koniec projektu — długość ≥ 0).
  const dates: LocalDate[] = [];
  for (const task of tasks) {
    for (const value of [task.start_date, task.due_date, scheduleParts(task.recurrence)?.anchor]) if (isDate(value)) dates.push(value);
  }
  for (const r of reminders) if (r.kind === 'absolute' && isDate(r.at_date)) dates.push(r.at_date);
  const end = isDate(source.list.end_date) ? source.list.end_date : null;
  const base = isDate(source.list.start_date) ? source.list.start_date : [...dates, ...(end ? [end] : [])].sort()[0] ?? null;
  const day = (date: unknown): number | null => (base && isDate(date) ? daysBetween(base, date) : null);
  const latest = dates.reduce<number>((max, date) => Math.max(max, day(date) ?? 0), 0);
  const endDay = base === null ? null : end ? Math.max(0, day(end)!) : latest;

  const columns = z.array(z.object({ id: z.string(), name: z.string() })).safeParse(source.list.board_columns);
  const boardColumns = columns.success ? columns.data.slice(0, 50) : [];
  const columnIndex = new Map(boardColumns.map((c, i) => [c.id, i]));

  const content: ProjectTemplateContent = {
    version: TEMPLATE_VERSION,
    project: {
      color: source.list.color && /^#[0-9a-fA-F]{6}$/.test(source.list.color) ? source.list.color : null,
      icon: source.list.icon || null,
      descriptionMd: source.list.description_md || null,
      endDay,
      viewPrefs: asObject(source.list.view_prefs),
      boardColumns: boardColumns.map((c) => c.name.trim().slice(0, 60) || 'Kolumna'),
    },
    tasks: tasks.map((task) => {
      const schedule = scheduleParts(task.recurrence);
      const every = asObject(task.recurrence)?.mode === 'after_completion' ? TemplateRecurrence.safeParse(task.recurrence) : null;
      const recurrence: TemplateRecurrence | null =
        schedule && base
          ? { mode: 'schedule', rrule: schedule.rrule, anchorDay: day(schedule.anchor)!, untilDay: schedule.until ? daysBetween(base, schedule.until) : null }
          : every?.success
            ? every.data
            : null;
      const dueDay = day(task.due_date);
      return {
        key: keyOf.get(task.id)!,
        parent: task.parent_id ? (keyOf.get(task.parent_id) ?? null) : null,
        title: task.title.trim().slice(0, 500) || 'Zadanie',
        descriptionMd: task.description_md || null,
        priority: ([1, 2, 3, 4].includes(Number(task.priority)) ? Number(task.priority) : 4) as Priority,
        startDay: dueDay === null ? null : day(task.start_date),
        dueDay,
        dueTime: dueDay === null ? null : (task.due_time ?? null),
        durationMin: task.duration_min ?? null,
        timeZone: task.time_zone ?? null,
        recurrence,
        tags: [...new Set(source.tags.filter((t) => t.task_id === task.id).map((t) => t.name.trim().slice(0, 60)))].filter(Boolean).slice(0, 50),
        reminders: reminders
          .filter((r) => r.task_id === task.id)
          .flatMap((r): TemplateReminder[] =>
            r.kind === 'relative' && r.offset_min !== null
              ? [{ kind: 'relative', offsetMin: r.offset_min }]
              : r.kind === 'absolute' && r.at_time && day(r.at_date) !== null
                ? [{ kind: 'absolute', day: day(r.at_date)!, time: r.at_time }]
                : [],
          )
          .slice(0, 20),
        boardColumn: task.board_column_id ? (columnIndex.get(task.board_column_id) ?? null) : null,
      };
    }),
    dependencies: source.dependencies
      .filter((d) => keyOf.has(d.predecessor_id) && keyOf.has(d.successor_id) && d.predecessor_id !== d.successor_id)
      .map((d) => ({ from: keyOf.get(d.predecessor_id)!, to: keyOf.get(d.successor_id)!, lagDays: Math.max(-365, Math.min(365, Math.round(d.lag_days))) })),
  };
  return ProjectTemplateContent.parse(content);
}

// ── Szablon → nowy projekt ───────────────────────────────────────────────────────────────────

/** Od której daty liczyć: początek albo koniec nowego projektu. */
export type TemplateAnchor = { kind: 'start' | 'end'; date: LocalDate };

/** Czy szablon ma daty (bez nich projekt powstaje bez dat i data nie jest potrzebna). */
export const templateHasDates = (content: ProjectTemplateContent): boolean => content.project.endDay !== null;

/** Początek i koniec nowego projektu; szablon bez dat → `null`. */
export function templateDates(content: ProjectTemplateContent, anchor: TemplateAnchor): { start: LocalDate; end: LocalDate } | null {
  const length = content.project.endDay;
  if (length === null) return null;
  const start = anchor.kind === 'start' ? anchor.date : addDays(anchor.date, -length);
  return { start, end: addDays(start, length) };
}

export interface TemplateTarget {
  userId: string;
  /** Przestrzeń nowego projektu. */
  workspaceId: string;
  name: string;
  /** Wymagana, gdy szablon ma daty. */
  anchor?: TemplateAnchor | null;
  /** Tagi do dopasowania po nazwie (jak w szybkim dodawaniu; także kopie z przestrzeni). */
  tags: QuickAddScope['tags'];
  /** Ostatni klucz kolejności list w przestrzeni (nowy projekt na końcu). */
  lastListSortKey?: string;
  newId?: () => string;
}

/**
 * Operacje nowego projektu z szablonu — jedna paczka `mutateMany`: lista (projekt aktywny), zadania
 * z nowymi id („Do zrobienia”), tagi (istniejący po nazwie albo nowy w przestrzeni projektu),
 * kolejność tagów, przypomnienia, zależności i własne kolumny tablicy.
 */
export function projectFromTemplateOps(content: ProjectTemplateContent, target: TemplateTarget): { listId: string; ops: TaskOp[] } {
  const newId = target.newId ?? (() => uuidv7());
  const name = target.name.trim().slice(0, 200);
  if (!name) throw new Error('Projekt musi mieć nazwę.');
  const dates = target.anchor ? templateDates(content, target.anchor) : null;
  if (templateHasDates(content) && !dates) throw new Error('Podaj datę startu albo końca projektu.');
  const date = (offset: number | null): LocalDate | null => (dates && offset !== null ? addDays(dates.start, offset) : null);

  const listId = newId();
  const columnIds = content.project.boardColumns.map(() => newId());
  const ops: TaskOp[] = [
    {
      table: 'lists',
      id: listId,
      patch: {
        scope_id: target.workspaceId,
        kind: 'project',
        name,
        color: content.project.color,
        icon: content.project.icon,
        description_md: content.project.descriptionMd,
        start_date: dates?.start ?? null,
        end_date: dates?.end ?? null,
        project_status: 'active',
        sort_key: keyBetween(target.lastListSortKey ?? 'a'),
        view_prefs: content.project.viewPrefs ?? {},
        board_columns: columnIds.length ? content.project.boardColumns.map((n, i) => ({ id: columnIds[i]!, name: n })) : null,
      },
    },
  ];

  const ids = new Map(content.tasks.map((t) => [t.key, newId()]));
  // Klucze kolejności w grupach rodzeństwa (kolejność z szablonu).
  const siblings = new Map<string | null, string[]>();
  for (const t of content.tasks) siblings.set(t.parent, [...(siblings.get(t.parent) ?? []), t.key]);
  const sortKey = new Map<string, string>();
  for (const keys of siblings.values()) renumber(keys.length).forEach((k, i) => sortKey.set(keys[i]!, k));

  const tags = [...target.tags];
  for (const t of content.tasks) {
    const id = ids.get(t.key)!;
    const dueDate = date(t.dueDay);
    ops.push({
      table: 'tasks',
      id,
      patch: {
        list_id: listId,
        parent_id: t.parent ? ids.get(t.parent)! : null,
        kind: 'task',
        title: t.title,
        description_md: t.descriptionMd,
        status: 'todo',
        priority: t.priority,
        start_date: dueDate ? date(t.startDay) : null,
        due_date: dueDate,
        due_time: dueDate ? t.dueTime : null,
        duration_min: t.durationMin,
        time_zone: t.timeZone,
        recurrence: recurrenceFrom(t.recurrence, date),
        sort_key: sortKey.get(t.key)!,
        source: { kind: 'manual' },
        postpone_count: 0,
        board_column_id: t.boardColumn === null ? null : (columnIds[t.boardColumn] ?? null),
      },
    });

    const tagOps = taskTagOps({ userId: target.userId, tags }, id, t.tags, target.workspaceId);
    const order = renumber(tagOps.filter((op) => op.table === 'task_tags').length);
    let n = 0;
    for (const op of tagOps) {
      if (op.table === 'tags') tags.push({ id: op.id, name: String(op.patch.name), sortKey: String(op.patch.sort_key) });
      ops.push(op.table === 'task_tags' ? { ...op, patch: { ...op.patch, sort_key: order[n++]! } } : op);
    }

    for (const r of t.reminders) {
      if (r.kind === 'relative') {
        ops.push({ table: 'reminders', id: newId(), patch: { task_id: id, kind: 'relative', offset_min: r.offsetMin, at_date: null, at_time: null } });
      } else if (dates) {
        ops.push({ table: 'reminders', id: newId(), patch: { task_id: id, kind: 'absolute', offset_min: null, at_date: date(r.day), at_time: r.time } });
      }
    }
  }

  for (const d of content.dependencies) {
    ops.push({
      table: 'task_dependencies',
      id: newId(),
      patch: { predecessor_id: ids.get(d.from)!, successor_id: ids.get(d.to)!, kind: 'finish_to_start', lag_days: d.lagDays },
    });
  }
  return { listId, ops };
}

function recurrenceFrom(recurrence: TemplateRecurrence | null, date: (offset: number | null) => LocalDate | null): Record<string, unknown> | null {
  if (!recurrence) return null;
  if (recurrence.mode === 'after_completion') return { mode: 'after_completion', every: recurrence.every };
  const anchor = date(recurrence.anchorDay);
  if (!anchor) return null;
  try {
    const rule = parseRrule(recurrence.rrule);
    const until = date(recurrence.untilDay);
    if (until && !rule.count) rule.until = until;
    return { mode: 'schedule', rrule: formatRrule(rule), anchor };
  } catch {
    return null;
  }
}

// ── Wiersze szablonów ────────────────────────────────────────────────────────────────────────

/** Szablon z lokalnej bazy w postaci dla aplikacji. */
export interface ProjectTemplate {
  id: string;
  name: string;
  sortKey: string;
  /** `null` = zły zapis albo szablon z nowszej wersji aplikacji. */
  content: ProjectTemplateContent | null;
}

/** Wiersz `project_templates` (treść jako tekst JSON albo obiekt) → szablon. */
export const projectTemplateOf = (row: { id: string; name: string; sort_key: string; content: unknown }): ProjectTemplate => ({
  id: row.id,
  name: row.name,
  sortKey: row.sort_key,
  content: parseTemplateContent(row.content),
});

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase('pl') === b.trim().toLocaleLowerCase('pl');

/** Szablon o tej nazwie (bez wielkości liter) — „Zapisz jako szablon” go zastąpi. */
export const templateNamed = <T extends { name: string }>(templates: readonly T[], name: string): T | undefined => templates.find((t) => sameName(t.name, name));

/**
 * Zapis szablonu: z nazwą istniejącego — zastąpienie treści tego wiersza (też gdy był w koszu),
 * z nową — nowy wiersz na końcu.
 */
export function saveTemplateOps(
  templates: readonly { id: string; name: string; sortKey: string }[],
  name: string,
  content: ProjectTemplateContent,
  newId: () => string = () => uuidv7(),
): { id: string; replaced: boolean; ops: TaskOp[] } {
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) throw new Error('Szablon musi mieć nazwę.');
  const existing = templateNamed(templates, trimmed);
  if (existing) return { id: existing.id, replaced: true, ops: [{ table: 'project_templates', id: existing.id, patch: { name: trimmed, content, deleted_at: null } }] };
  const last = templates.reduce<string | undefined>((max, t) => (!max || t.sortKey > max ? t.sortKey : max), undefined);
  const id = newId();
  return { id, replaced: false, ops: [{ table: 'project_templates', id, patch: { name: trimmed, content, sort_key: keyBetween(last) } }] };
}

export function renameTemplateOp(id: string, name: string): TaskOp {
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) throw new Error('Szablon musi mieć nazwę.');
  return { table: 'project_templates', id, patch: { name: trimmed } };
}

/** Usunięcie (kosz synchronizacji) i „Cofnij”. */
export const deleteTemplateOps = (id: string, now: Date | string = new Date()): { ops: TaskOp[]; undo: TaskOp[] } => ({
  ops: [{ table: 'project_templates', id, patch: { deleted_at: typeof now === 'string' ? now : now.toISOString() } }],
  undo: [{ table: 'project_templates', id, patch: { deleted_at: null } }],
});

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;
const DEPENDENCIES = ['zależność', 'zależności', 'zależności'] as const;
const DAYS = ['dzień', 'dni', 'dni'] as const;

/** Opis szablonu na liście: „12 zadań · 3 zależności · 30 dni” (długość = dni od startu do końca włącznie). */
export function templateSummary(content: ProjectTemplateContent | null): string {
  if (!content) return 'Szablon z nowszej wersji aplikacji — zaktualizuj ją';
  return [
    plural(content.tasks.length, TASKS),
    content.dependencies.length ? plural(content.dependencies.length, DEPENDENCIES) : null,
    content.project.endDay === null ? 'bez dat' : plural(content.project.endDay + 1, DAYS),
  ]
    .filter(Boolean)
    .join(' · ');
}
