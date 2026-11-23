"use client";

/**
 * Szablony projektów (v1.x): „Zapisz jako szablon” w nagłówku projektu, wybór szablonu przy dodawaniu
 * projektu (z datą startu albo końca) i karta „Szablony projektów” na ekranie „Przestrzenie i listy”.
 * Logika w core (`templates.ts`), odczyt projektu — `readProjectSource` z `@taskplanner/sync`.
 */
import {
  deleteTemplateOps,
  projectFromTemplateOps,
  projectTemplateContent,
  projectTemplateOf,
  renameTemplateOp,
  saveTemplateOps,
  shortDate,
  templateDates,
  templateHasDates,
  templateNamed,
  templateSummary,
  compareText,
  type LocalDate,
  type ProjectTemplate,
  type TemplateAnchor,
} from "@taskplanner/core";
import { readProjectSource, type TabStore } from "@taskplanner/sync";
import { useMemo, useState, type FormEvent } from "react";

import { useLocalQuery } from "@/lib/local-store";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { Button, Card, IconButton, Input, Select } from "./ui";

interface TemplateRow extends Record<string, string | null> {
  id: string;
  name: string;
  sort_key: string;
  content: string;
}

/** Szablony użytkownika (bez kosza), alfabetycznie. */
export function useProjectTemplates(store: TabStore): ProjectTemplate[] {
  const { rows } = useLocalQuery<TemplateRow>(store, "select id, name, sort_key, content from project_templates where deleted_at is null", [], ["project_templates"]);
  return useMemo(() => rows.map(projectTemplateOf).sort((a, b) => compareText(a.name, b.name)), [rows]);
}

/** Przycisk w nagłówku projektu: nazwa szablonu (domyślnie nazwa projektu) → migawka projektu w `project_templates`. */
export function SaveTemplateButton({ listId, listName }: { listId: string; listName: string }) {
  const { store } = useAppEnv();
  const { run, notify } = useTaskActions();
  const templates = useProjectTemplates(store);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!name?.trim() || busy) return;
    const existing = templateNamed(templates, name);
    if (existing && !window.confirm(`Szablon „${existing.name}” już jest. Zastąpić go tym projektem?`)) return;
    setBusy(true);
    try {
      const content = projectTemplateContent(await readProjectSource(store.query, listId));
      const saved = saveTemplateOps(templates, name, content);
      await run(saved.ops, { text: `${saved.replaced ? "Zastąpiono" : "Zapisano"} szablon „${name.trim()}” · ${templateSummary(content)}` });
      setName(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (name === null) {
    return (
      <Button kind="ghost" className="text-xs" onClick={() => setName(listName)} title="Zadania, podzadania, tagi, przypomnienia i zależności z datami względnymi" data-testid="save-template">
        Zapisz jako szablon
      </Button>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)} className="flex items-center gap-1" data-testid="save-template-form">
      <Input
        autoFocus
        aria-label="Nazwa szablonu"
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setName(null)}
        className="w-48 py-1 text-xs"
      />
      <Button type="submit" kind="primary" className="text-xs" disabled={!name.trim() || busy}>
        {templateNamed(templates, name) ? "Zastąp" : "Zapisz"}
      </Button>
      <IconButton label="Anuluj" onClick={() => setName(null)}>
        ✕
      </IconButton>
    </form>
  );
}

/** Wybór szablonu przy dodawaniu projektu: szablon + data startu / końca z podglądem dat. */
export interface TemplateChoice {
  template: ProjectTemplate;
  anchor: TemplateAnchor | null;
}

export function TemplatePicker({ templates, value, onChange }: { templates: readonly ProjectTemplate[]; value: TemplateChoice | null; onChange: (choice: TemplateChoice | null) => void }) {
  const { today } = useAppEnv();
  if (!templates.length) return null;
  const content = value?.template.content ?? null;
  const dated = content ? templateHasDates(content) : false;
  const anchor = value?.anchor ?? { kind: "start" as const, date: today };
  const dates = content && dated ? templateDates(content, anchor) : null;
  const choose = (id: string) => {
    const template = templates.find((t) => t.id === id);
    onChange(template ? { template, anchor: template.content && templateHasDates(template.content) ? (value?.anchor ?? { kind: "start", date: today }) : null } : null);
  };
  return (
    <div className="flex w-full flex-wrap items-center gap-2 text-sm" data-testid="template-picker">
      <Select value={value?.template.id ?? ""} onChange={(e) => choose(e.target.value)} aria-label="Szablon projektu" className="min-w-48 flex-1">
        <option value="">Pusty projekt</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id} disabled={!t.content}>
            Z szablonu: {t.name}
          </option>
        ))}
      </Select>
      {value && dated ? (
        <>
          <Select value={anchor.kind} onChange={(e) => onChange({ ...value, anchor: { ...anchor, kind: e.target.value as TemplateAnchor["kind"] } })} aria-label="Data szablonu" className="w-32">
            <option value="start">Start</option>
            <option value="end">Koniec</option>
          </Select>
          <Input
            type="date"
            required
            aria-label={anchor.kind === "start" ? "Data startu projektu" : "Data końca projektu"}
            value={anchor.date}
            onChange={(e) => e.target.value && onChange({ ...value, anchor: { ...anchor, date: e.target.value as LocalDate } })}
            className="w-40"
          />
        </>
      ) : null}
      {value ? (
        <span className="w-full text-xs text-[var(--muted)]" data-testid="template-preview">
          {templateSummary(content)}
          {dates ? ` · ${shortDate(dates.start)} – ${shortDate(dates.end)}` : ""}
        </span>
      ) : null}
    </div>
  );
}

/** Operacje nowego projektu z szablonu w przestrzeni (tagi i kolejność list z danych aplikacji). */
export function useCreateFromTemplate() {
  const { data, userId } = useAppEnv();
  return (choice: TemplateChoice, workspaceId: string, name: string, lastListSortKey: string | undefined) => {
    if (!choice.template.content) throw new Error("Szablon z nowszej wersji aplikacji — zaktualizuj ją.");
    return projectFromTemplateOps(choice.template.content, { userId, workspaceId, name, anchor: choice.anchor, tags: data.tags, lastListSortKey });
  };
}

/** Karta na ekranie „Przestrzenie i listy”: szablony z opisem, zmiana nazwy, usunięcie z „Cofnij”. */
export function TemplatesCard({ store }: { store: TabStore }) {
  const templates = useProjectTemplates(store);
  const { run, notify } = useTaskActions();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const rename = async () => {
    if (!editing) return;
    const template = templates.find((t) => t.id === editing.id);
    setEditing(null);
    if (!template || !editing.name.trim() || editing.name.trim() === template.name) return;
    const other = templateNamed(templates.filter((t) => t.id !== template.id), editing.name);
    if (other) return notify(`Szablon „${other.name}” już jest.`);
    await run([renameTemplateOp(template.id, editing.name)]);
  };

  return (
    <Card>
      <h2 className="text-base font-semibold">Szablony projektów</h2>
      {templates.length ? (
        <ul className="mt-2 flex flex-col divide-y divide-[var(--line)] border-t border-[var(--line)]" data-testid="templates">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              {editing?.id === t.id ? (
                <Input
                  autoFocus
                  aria-label="Nazwa szablonu"
                  value={editing.name}
                  maxLength={100}
                  onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
                  onBlur={() => void rename()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="max-w-xs"
                />
              ) : (
                <button type="button" className="rounded px-1 text-left font-medium hover:bg-[var(--hover)]" title="Zmień nazwę" onClick={() => setEditing({ id: t.id, name: t.name })}>
                  {t.name}
                </button>
              )}
              <span className="text-xs text-[var(--muted)]">{templateSummary(t.content)}</span>
              <span className="flex-1" />
              <Button
                kind="ghost"
                onClick={() => {
                  const { ops, undo } = deleteTemplateOps(t.id);
                  void run(ops, { text: `Usunięto szablon „${t.name}”`, undo });
                }}
              >
                Usuń
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-[var(--muted)]">Brak szablonów.</p>
      )}
      <p className="mt-2 text-xs text-[var(--muted)]">
        Szablon zapiszesz przyciskiem „Zapisz jako szablon” w nagłówku projektu: zadania z podzadaniami, tagi, przypomnienia i zależności, daty liczone od startu projektu. Nowy projekt z szablonu wybierzesz przy dodawaniu projektu w przestrzeni — od daty startu albo końca. Szablony są Twoje (widzisz je na wszystkich urządzeniach) i działają bez sieci.
      </p>
    </Card>
  );
}
