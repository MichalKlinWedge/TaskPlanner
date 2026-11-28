"use client";

/**
 * Szybkie dodawanie (M13): pole z parserem z `core/quick-add.ts`, rozpoznane fragmenty jako chipy
 * (klik cofa rozpoznanie), podgląd tytułu i listy docelowej, wiele linii naraz (wklejenie).
 * Ten sam komponent w widokach (pole na górze) i w oknie wywoływanym klawiszem `Q` / `Ctrl+Spacja`;
 * okno pokazuje od razu pola opisu, terminu i godziny (`details`, pierwszeństwo: core `quickAddWhenContext`).
 */
import { CLIP_DESCRIPTION_MAX, clipQuote, findUrl, linkName, localDateTimeAt, parseQuickAdd, withLinkOps, plural, QUICK_ADD_FIELD, READONLY_LIST_NOTE, QUICK_ADD_HELP, QUICK_ADD_HELP_NOTES, quickAddChip, quickAddTaskOps, quickAddWhenContext, quickAddWhenInitial, suppressToken, taskTagOps, type LocalDate, type TaskOp, type QuickAddContext, type QuickAddSlot, type QuickAddTokenKind, type QuickAddWhen, type WebClip } from "@taskplanner/core";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react";

import { listEditable } from "@/lib/app-data";
import { useDialogFocus } from "@/lib/use-dialog-focus";

import { lastSortKey, useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { inputClass } from "./ui";
import { ClipFieldset } from "./web-clip";

const KIND_STYLE: Record<QuickAddTokenKind, string> = {
  date: "bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100",
  time: "bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100",
  duration: "bg-cyan-100 text-cyan-900 dark:bg-cyan-900/50 dark:text-cyan-100",
  priority: "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100",
  target: "bg-green-100 text-green-900 dark:bg-green-900/50 dark:text-green-100",
  tag: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
  recurrence: "bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100",
  reminder: "bg-pink-100 text-pink-900 dark:bg-pink-900/50 dark:text-pink-100",
};

export interface QuickAddProps {
  /** Lista, gdy wpis nie wskazuje innej; brak = Inbox bieżącej (albo pierwszej) przestrzeni. */
  listId?: string;
  /** Termin, gdy wpis go nie podaje. */
  dueDate?: LocalDate | null;
  /** Kliknięte miejsce kalendarza: dzień i godzina, gdy wpis ich nie podaje. */
  slot?: QuickAddSlot | null;
  /** Pola z kolumny tablicy (status, priorytet), gdy wpis ich nie podaje; tagi dokładane. */
  defaults?: { status?: string; priority?: number; tagNames?: readonly string[]; boardColumnId?: string; /** Komórka karteczki (widok „Karteczki”) — tylko pierwsze zadanie, gdy zostaje na `listId`. */ canvasPos?: { col: number; row: number } };
  /** Podzadanie tego zadania (lista rodzica, wskazanie listy we wpisie pomijane). */
  parent?: { id: string; listId: string };
  placeholder?: string;
  autoFocus?: boolean;
  /** Po dodaniu (Enter); `more` = Ctrl+Enter — okno zostaje otwarte. */
  onAdded?: (more: boolean) => void;
  onCancel?: () => void;
  /** Tekst na start (udostępnienie, zakładka). */
  initialText?: string;
  /** Adres z udostępnienia / zakładki — załącznik i źródło `link` pierwszego zadania (Etap 10). */
  link?: { url: string; shared: true };
  /** Wycinek strony z zakładki: edytowalny opis (cytat zaznaczenia) i „✨ Streść” — tylko pierwsze zadanie. */
  clip?: WebClip;
  /** Pola opisu (pierwsze zadanie), terminu i godziny widoczne od razu (okno `Q`). */
  details?: boolean;
}

export function QuickAdd({ listId, dueDate, slot, parent, defaults, placeholder = "Dodaj zadanie", autoFocus, onAdded, onCancel, initialText, link: sharedLink, clip: initialClip, details }: QuickAddProps) {
  const { data, userId, timeZone, today, workspaceId } = useAppEnv();
  const { run, notify } = useTaskActions();
  const [text, setText] = useState(initialText ?? "");
  // Wycinek (opis i link) należy do pierwszego zadania — po dodaniu okno z Ctrl+Enter zostaje już bez niego.
  const [clip, setClip] = useState(initialClip);
  const [description, setDescription] = useState(() => (initialClip ? clipQuote(initialClip) : ""));
  const link = initialClip && !clip ? undefined : sharedLink;
  const input = useRef<HTMLInputElement>(null);
  // Termin i godzina z pól okna: na start domyślne widoku; ustawione przez użytkownika wygrywają z wpisem.
  const [when, setWhen] = useState(() => quickAddWhenInitial({ dueDate, slot }));
  const whenContext = useMemo((): ReturnType<typeof quickAddWhenContext> => (details ? quickAddWhenContext(when, { dueDate, slot }) : { ...(slot && { slot }), defaultDueDate: dueDate ?? null }), [details, when, dueDate, slot]);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const names = useMemo(() => new Map(data.workspaces.map((w) => [w.id, w.name])), [data.workspaces]);
  const defaultListId = parent?.listId ?? listId ?? data.lists.find((l) => l.kind === "inbox" && l.workspaceId === (workspaceId ?? data.workspaces[0]?.id))?.id;
  const defaultWorkspace = data.lists.find((l) => l.id === defaultListId)?.workspaceId ?? workspaceId;

  const parserContext = useMemo(
    (): Omit<QuickAddContext, "now"> => ({
      currentWorkspace: defaultWorkspace ? names.get(defaultWorkspace) : undefined,
      workspaces: data.workspaces.map((w) => w.name),
      lists: data.lists.filter((l) => l.kind !== "inbox").map((l) => ({ workspace: names.get(l.workspaceId) ?? "", name: l.name, kind: l.kind })),
      tags: data.tags.map((t) => t.name),
      ...(whenContext.slot && { slot: whenContext.slot }),
      ...(whenContext.fixed && { fixed: whenContext.fixed }),
    }),
    [data.workspaces, data.lists, data.tags, names, defaultWorkspace, whenContext],
  );
  const parse = (value: string) => parseQuickAdd(value, { ...parserContext, now: localDateTimeAt(new Date(), timeZone) });
  const result = useMemo(() => parse(text), [text, parserContext, timeZone]); // eslint-disable-line react-hooks/exhaustive-deps

  const scope = (listIdFallback: string) => ({
    userId,
    workspaces: data.workspaces,
    lists: data.lists,
    tags: data.tags,
    defaultListId: listIdFallback,
    defaultDueDate: whenContext.defaultDueDate,
    parent,
    lastSortKey: (id: string) => lastSortKey(data, id),
  });

  const listName = (id: string) => {
    const list = data.lists.find((l) => l.id === id);
    if (!list) return "";
    return list.kind === "inbox" ? `Inbox („${names.get(list.workspaceId)}”)` : list.name;
  };

  const add = async (lines: string[], more: boolean) => {
    if (!defaultListId) return notify("Brak listy docelowej — utwórz przestrzeń w „Przestrzenie i listy”.");
    const ops: TaskOp[] = [];
    const added: { taskId: string; listId: string }[] = [];
    // Kolejne zadania z jednego wklejenia idą po sobie: klucz kolejności z poprzedniego.
    const keys = new Map<string, string>();
    for (const line of lines) {
      const parsed = parse(line);
      if (!parsed.title.trim()) continue;
      const base = scope(defaultListId);
      const result = quickAddTaskOps(parsed, line, { ...base, lastSortKey: (id) => keys.get(id) ?? base.lastSortKey(id), description: !added.length ? description : null });
      keys.set(parent?.id ?? result.listId, result.ops[0]!.patch.sort_key as string);
      if (defaults?.status) Object.assign(result.ops[0]!.patch, { status: defaults.status }, defaults.status === "done" ? { completed_at: new Date().toISOString() } : {});
      if (defaults?.priority && !parsed.fields.priority) result.ops[0]!.patch.priority = defaults.priority;
      if (defaults?.boardColumnId) result.ops[0]!.patch.board_column_id = defaults.boardColumnId;
      if (defaults?.canvasPos && !added.length && result.listId === listId) result.ops[0]!.patch.canvas_pos = defaults.canvasPos;
      // Adres w tytule (wklejony) albo z udostępnienia → załącznik-link; podgląd strony dociągnie tytuł.
      ops.push(...withLinkOps(result, { title: parsed.title, url: added.length === 0 ? link?.url : null, shared: added.length === 0 && Boolean(link) }));
      if (defaults?.tagNames?.length) ops.push(...taskTagOps({ userId, tags: data.tags }, result.taskId, defaults.tagNames, data.lists.find((l) => l.id === result.listId)?.workspaceId).filter((op) => !ops.some((o) => o.table === op.table && o.id === op.id)));
      added.push(result);
    }
    if (!added.length) return notify("Zadanie musi mieć tytuł.");
    const at = new Date().toISOString();
    const saved = await run(ops, {
      text: added.length === 1 ? `Dodano do ${listName(added[0]!.listId)}` : `Dodano ${plural(added.length, ["zadanie", "zadania", "zadań"])}`,
      undo: added.map((a) => ({ table: "tasks" as const, id: a.taskId, patch: { deleted_at: at } })),
    });
    // Odrzucony zapis (np. lista tylko do podglądu, karta za starszym liderem) — wpis zostaje do poprawki.
    if (!saved) return;
    setText("");
    setClip(undefined);
    setDescription("");
    onAdded?.(more);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (text.trim()) void add([text], event.ctrlKey || event.metaKey);
    } else if (event.key === "Escape") {
      if (text) setText("");
      else onCancel?.();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    const lines = pasted
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    event.preventDefault();
    if (window.confirm(`Dodać ${plural(lines.length, ["zadanie", "zadania", "zadań"])} (każda linia osobno)?`)) void add(lines, true);
    else setText(lines.join(" "));
  };

  // Podgląd listy docelowej: te same reguły co zapis (wskazana lista / przestrzeń albo domyślna).
  let target: string | null = null;
  if (text.trim() && defaultListId && result.title.trim()) target = quickAddTaskOps(result, text, { ...scope(defaultListId), newId: () => "podglad" }).listId;

  // Domyślna lista tylko do podglądu (np. wybrana udostępniona przestrzeń z rolą „podgląd”) — zamiast pola, które i tak odrzuci zapis.
  if (defaultListId && !listEditable(data, defaultListId)) return <p className="my-2 px-1 text-sm text-[var(--muted)]">{READONLY_LIST_NOTE}</p>;

  return (
    <div className="my-2">
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={`+ ${placeholder}`}
        aria-label={placeholder}
        aria-describedby={text ? "quick-add-preview" : undefined}
        maxLength={1000}
        disabled={!defaultListId}
        className={`${inputClass} w-full`}
      />
      {text.trim() ? (
        <div id="quick-add-preview" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[var(--muted)]">
            {result.title.trim() ? <strong className="font-medium text-[var(--foreground)]">{result.title}</strong> : <em>bez tytułu</em>}
            {target ? ` → ${listName(target)}` : ""}
          </span>
          {findUrl(result.title) || link ? (
            <span className="rounded-full bg-black/5 px-2 py-0.5 font-medium dark:bg-white/10" title="Link trafi do załączników zadania">
              🔗 {linkName(link?.url ?? findUrl(result.title)!)}
            </span>
          ) : null}
          {result.tokens.map((token) => {
            const label = quickAddChip(token, result, today);
            return (
              <button
                key={token.start}
                type="button"
                title="Cofnij rozpoznanie — fragment wróci do tytułu"
                aria-label={`${label} — cofnij rozpoznanie`}
                onClick={() => {
                  setText(suppressToken(text, token));
                  input.current?.focus();
                }}
                className={`rounded-full px-2 py-0.5 font-medium ${KIND_STYLE[token.kind]} ${token.overridden ? "line-through opacity-70" : ""}`}
              >
                {label} <span aria-hidden>×</span>
              </button>
            );
          })}
          <span className="ml-auto text-[var(--muted)]">Enter — dodaj{onAdded ? " · Ctrl+Enter — dodaj i pisz dalej" : ""}</span>
        </div>
      ) : null}
      {details ? (
        <DetailsFields
          when={when}
          setWhen={setWhen}
          description={clip ? null : description}
          setDescription={setDescription}
          focusTitle={() => input.current?.focus()}
          add={() => void (text.trim() && add([text], false))}
        />
      ) : null}
      {clip ? (
        <ClipFieldset
          clip={clip}
          initialTitle={initialText ?? ""}
          title={text}
          setTitle={setText}
          description={description}
          setDescription={setDescription}
          focusTitle={() => input.current?.focus()}
          add={() => void (text.trim() && add([text], false))}
        />
      ) : null}
      {details ? (
        <div className="mt-3 flex justify-end gap-2">
          {onCancel ? (
            <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-black/5 hover:text-[var(--foreground)] dark:hover:bg-white/10">
              Anuluj
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void add([text], false)}
            disabled={!defaultListId || !result.title.trim()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Dodaj
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Pola okna pod wpisem: termin + godzina i opis (Markdown). Wyczyszczenie terminu czyści też
 * nietkniętą godzinę (domyślną z kalendarza) — godzina bez dnia nie miałaby do czego się odnieść.
 * `description` `null` = opis pokazuje wycinek (`ClipFieldset`).
 */
function DetailsFields({ when, setWhen, description, setDescription, focusTitle, add }: { when: QuickAddWhen; setWhen: (next: QuickAddWhen) => void; description: string | null; setDescription: (value: string) => void; focusTitle: () => void; add: () => void }) {
  const keys = (event: KeyboardEvent<HTMLElement>, multiline: boolean) => {
    if (event.key === "Escape") {
      // Escape wraca do wpisu (nie gubi pól); drugi Escape zamyka okno.
      event.preventDefault();
      event.stopPropagation();
      focusTitle();
    } else if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      add();
    }
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2 text-xs text-[var(--muted)]">
        <label className="flex flex-col gap-1">
          {QUICK_ADD_FIELD.date}
          <input
            type="date"
            value={when.date ?? ""}
            onChange={(e) => {
              const date = (e.target.value || null) as LocalDate | null;
              setWhen({ ...when, date, dateSet: true, ...(!date && !when.timeSet && { time: null }) });
            }}
            onKeyDown={(e) => keys(e, false)}
            className={`${inputClass} text-[var(--foreground)]`}
          />
        </label>
        <label className="flex flex-col gap-1">
          {QUICK_ADD_FIELD.time}
          <input
            type="time"
            value={when.time ?? ""}
            onChange={(e) => setWhen({ ...when, time: (e.target.value || null) as QuickAddWhen["time"], timeSet: true })}
            onKeyDown={(e) => keys(e, false)}
            className={`${inputClass} text-[var(--foreground)]`}
          />
        </label>
        {when.date || when.time ? (
          <button type="button" onClick={() => setWhen({ date: null, time: null, dateSet: true, timeSet: true })} className="mb-1.5 rounded px-1.5 py-0.5 hover:bg-black/5 hover:text-[var(--foreground)] dark:hover:bg-white/10">
            ✕ {QUICK_ADD_FIELD.clear}
          </button>
        ) : null}
        <span className="mb-1.5 basis-full">{QUICK_ADD_FIELD.note}</span>
      </div>
      {description !== null ? (
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          {QUICK_ADD_FIELD.description}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => keys(e, true)}
            maxLength={CLIP_DESCRIPTION_MAX}
            placeholder={QUICK_ADD_FIELD.descriptionPlaceholder}
            rows={3}
            className={`${inputClass} max-h-64 min-h-20 w-full resize-y font-mono text-[13px] leading-relaxed text-[var(--foreground)] [field-sizing:content]`}
          />
        </label>
      ) : null}
    </div>
  );
}

/** Okno szybkiego dodawania nad bieżącym widokiem. */
export function QuickAddDialog({ open, onClose, heading, ...props }: QuickAddProps & { open: boolean; onClose: () => void; heading?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, open);
  if (!open) return null;
  // Klik obok okna zamyka je tylko bez wpisu — inaczej przypadkowy klik gubiłby tytuł, opis i wycinek strony (Esc nadal zamyka).
  const backdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const fields = [...e.currentTarget.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[type=text], input:not([type]), textarea")];
    const filled = fields.find((f) => f.value.trim());
    if (filled) {
      e.preventDefault();
      filled.focus();
    } else onClose();
  };
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[15vh]" onMouseDown={backdrop}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Szybkie dodawanie" className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 shadow-2xl">
        {heading ? <h2 className="px-1 text-sm font-medium">{heading}</h2> : null}
        <QuickAdd {...props} details autoFocus onAdded={(more) => !more && onClose()} onCancel={onClose} />
        <p className="px-1 text-xs text-[var(--muted)]">
          Np. „Zapłacić rachunek jutro o 10 #dom !wysoki @telefon ~15m” · Ctrl+Enter w opisie — dodaj · Esc — zamknij
        </p>
        <SyntaxHelp />
      </div>
    </div>
  );
}

const HELP_KEY = "tp-quick-add-help";

/** Rozwijana ściąga składni (core `QUICK_ADD_HELP`, SPECYFIKACJA §4); rozwinięcie pamiętane per przeglądarka. */
function SyntaxHelp() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(HELP_KEY) === "1";
    } catch {
      return false;
    }
  });
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(HELP_KEY, next ? "1" : "0");
        } catch {
          // Bez pamięci przeglądarki — do zamknięcia okna.
        }
      }}
      className="mt-2 px-1 text-xs"
      data-testid="quick-add-help"
    >
      <summary className="cursor-pointer text-[var(--muted)] select-none hover:text-[var(--foreground)]">Składnia — co rozpoznaje pole</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {QUICK_ADD_HELP.map((row) => (
          <div key={row.kind} className="contents">
            <dt className="pt-0.5">
              <span className={`rounded-full px-2 py-0.5 font-medium whitespace-nowrap ${KIND_STYLE[row.kind]}`}>{row.label}</span>
            </dt>
            <dd className="text-[var(--muted)]">
              <span className="flex flex-wrap gap-1">
                {row.examples.map((example) => (
                  <code key={example} className="rounded bg-black/5 px-1 text-[var(--foreground)] dark:bg-white/10">
                    {example}
                  </code>
                ))}
              </span>
              {row.note ? <span className="mt-0.5 block">{row.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[var(--muted)]">
        {QUICK_ADD_HELP_NOTES.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </details>
  );
}
