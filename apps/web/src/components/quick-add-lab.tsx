"use client";

import {
  dayChip,
  formatMinutes,
  parseQuickAdd,
  PRIORITY,
  suppressToken,
  type QuickAddContext,
  type QuickAddResult,
  type QuickAddTokenKind,
} from "@taskplanner/core";
import { useMemo, useState } from "react";

// Kontekst przykładowy (w MVP-2: przestrzenie, listy i tagi z lokalnej bazy).
const SAMPLE: Omit<QuickAddContext, "now"> = {
  currentWorkspace: "Dom",
  workspaces: ["Dom", "Praca"],
  lists: [
    { workspace: "Dom", kind: "project", name: "Remont kuchni" },
    { workspace: "Dom", kind: "list", name: "Zakupy" },
    { workspace: "Praca", kind: "project", name: "Wdrożenie CRM" },
  ],
  tags: ["telefon", "szybkie", "na_mieście"],
};

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

const KIND_LABEL: Record<QuickAddTokenKind, string> = {
  date: "Data",
  time: "Godzina",
  duration: "Czas",
  priority: "Priorytet",
  target: "Lista",
  tag: "Tag",
  recurrence: "Powtarzanie",
  reminder: "Przypomnienie",
};

const localNow = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function chipValue(kind: QuickAddTokenKind, text: string, { fields }: QuickAddResult): string {
  switch (kind) {
    case "date":
      return fields.dueDate ? dayChip(fields.dueDate) : text;
    case "time":
      return fields.dueTime ?? text;
    case "duration":
      return fields.durationMin ? formatMinutes(fields.durationMin) : text;
    case "priority":
      return fields.priority ? PRIORITY[fields.priority].label : text;
    case "target":
      return fields.target ? (fields.target.kind === "workspace" ? `${fields.target.name} (Inbox)` : `${fields.target.workspace} › ${fields.target.name}`) : text;
    case "recurrence":
      return fields.recurrence?.mode === "after_completion"
        ? `${fields.recurrence.every.n} × ${fields.recurrence.every.unit} po ukończeniu`
        : (fields.recurrence?.rrule ?? text);
    default:
      return text;
  }
}

/** PoC-2: wpis na żywo → tytuł, chipy i podświetlenie rozpoznanych fragmentów. */
export function QuickAddLab() {
  const [text, setText] = useState("Zapłacić rachunek za prąd jutro o 10:00 #dom !wysoki");
  const [now] = useState(localNow);
  const result = useMemo(() => parseQuickAdd(text, { ...SAMPLE, now }), [text, now]);

  const highlighted: React.ReactNode[] = [];
  let cursor = 0;
  for (const token of result.tokens) {
    highlighted.push(text.slice(cursor, token.start));
    highlighted.push(
      <mark key={token.start} className={`rounded px-0.5 ${KIND_STYLE[token.kind]}`}>
        {token.text}
      </mark>,
    );
    cursor = token.end;
  }
  highlighted.push(text.slice(cursor));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-8 text-sm">
      <h1 className="text-xl font-semibold">PoC-2: szybkie dodawanie</h1>
      <p className="opacity-70">Teraz: {now.replace("T", " ")} · przestrzeń „Dom” · klik w chip cofa rozpoznanie</p>
      <input
        aria-label="Szybkie dodawanie"
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-base"
      />
      <p data-testid="highlight" className="whitespace-pre-wrap rounded border border-dashed border-[var(--line)] px-3 py-2 text-base">
        {highlighted}
      </p>
      <div>
        <span className="opacity-70">Tytuł: </span>
        <strong data-testid="title">{result.title || "—"}</strong>
      </div>
      <ul className="flex flex-wrap gap-2" data-testid="chips">
        {result.tokens.map((token) => {
          const label = `${KIND_LABEL[token.kind]}: ${token.kind === "tag" ? token.text.replace(/^[#@]/, "") : chipValue(token.kind, token.text, result)}`;
          return (
            <li key={token.start}>
              <button
                type="button"
                aria-label={`${label} — cofnij rozpoznanie`}
                onClick={() => setText(suppressToken(text, token))}
                className={`rounded-full px-3 py-1 text-xs font-medium ${KIND_STYLE[token.kind]}`}
              >
                {label} <span aria-hidden>×</span>
              </button>
            </li>
          );
        })}
      </ul>
      <pre className="overflow-x-auto rounded bg-[var(--surface)] p-3 text-xs" data-testid="fields">
        {JSON.stringify(result.fields, null, 2)}
      </pre>
    </main>
  );
}
