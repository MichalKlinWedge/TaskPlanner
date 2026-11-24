"use client";

/**
 * Eksport i import całej przestrzeni do pliku JSON (v1.x): listy, zadania, komentarze, tagi,
 * współpracownicy, członkowie z rolami i pliki załączników (ekran „Przestrzenie i listy”). Format
 * i zasady importu są w `core/workspace-file.ts`; tu pobranie plików i ról, podgląd, zapis przez
 * `mutateMany`, kolejka plików i zaproszenia. Wymaga sieci (role i załączniki są na serwerze).
 */
import {
  attachmentQuotaMessage,
  BACKUP_TABLE,
  BackupError,
  bytesToBase64,
  exportFileName,
  formatBytes,
  importedWorkspaceName,
  plural,
  readWorkspaceFile,
  SCOPE_ROLE,
  uuidv7,
  WORKSPACE_FILE_TAIL,
  workspaceFileCounts,
  workspaceFileEntry,
  workspaceFileHead,
  workspaceFilePeople,
  workspaceImportPlan,
  type InvalidRow,
  type ShareRole,
  type WorkspaceFile,
  type WorkspaceFilePerson,
} from "@taskplanner/core";
import { applyBackupPlan, exportWorkspace, workspaceImportContext, type TabStore, type WorkspaceImportContext } from "@taskplanner/sync";
import { useRef, useState } from "react";

import { reportError } from "@/lib/error-log";
import { shareWorkspace, workspaceSharing } from "@/lib/sharing";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { useAppEnv } from "./app-env";
import { useAttachments } from "./attachments";
import { downloadBlob } from "./export";
import { Button, Card, Input, Notice, Select } from "./ui";

const OFFLINE = "Wymaga połączenia z internetem (role i załączniki są na serwerze).";
const JSON_MIME = "application/json";
/** Najdłuższe czekanie na wysłanie zaimportowanych wierszy przed zaproszeniami. */
const SEND_ATTEMPTS = 180;

type Message = { tone: "error" | "ok" | "info"; text: string };

const errorText = (e: unknown) =>
  e instanceof BackupError ? e.message : e instanceof SyntaxError ? "To nie jest plik JSON." : !navigator.onLine ? OFFLINE : e instanceof Error ? e.message : String(e);

const FILES = ["plik", "pliki", "plików"] as const;

/** „12 zadań · 3 listy · 4 pliki (1,2 MB) · …” */
function countsText(file: WorkspaceFile): string {
  const c = workspaceFileCounts(file);
  return [
    plural(c.lists, ["lista", "listy", "list"]),
    plural(c.tasks, ["zadanie", "zadania", "zadań"]),
    c.comments ? plural(c.comments, ["komentarz", "komentarze", "komentarzy"]) : null,
    c.tags ? plural(c.tags, ["tag", "tagi", "tagów"]) : null,
    c.collaborators ? plural(c.collaborators, ["współpracownik", "współpracowników", "współpracowników"]) : null,
    c.files ? `${plural(c.files, FILES)} (${formatBytes(c.fileBytes)})` : null,
    c.links ? plural(c.links, ["link", "linki", "linków"]) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── Eksport ──────────────────────────────────────────────────────────────────────────────────

/** „Eksportuj” w karcie przestrzeni; komunikat pokazuje karta (`onMessage`). */
export function WorkspaceExportButton({ workspaceId, name, email, onMessage }: { workspaceId: string; name: string; email: string | null; onMessage: (message: Message | null) => void }) {
  const { store, userId, today } = useAppEnv();
  const attachments = useAttachments();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async () => {
    setBusy("Eksport…");
    onMessage(null);
    try {
      if (!navigator.onLine) throw new Error(OFFLINE);
      await store.sync();
      const sharing = await workspaceSharing(workspaceId);
      const file = await exportWorkspace(store.query, { workspaceId, userId, email, accounts: sharing.members, invites: sharing.invites });

      const rows = file.tables.attachments.filter((a) => a.kind === "file");
      const parts: Blob[] = [];
      const missing: string[] = [];
      for (const [index, row] of rows.entries()) {
        setBusy(`Eksport… ${index + 1}/${rows.length} plików`);
        try {
          const blob = await attachments.readFile(String(row.storage_path));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          row.size_bytes = bytes.length;
          // Osobny `Blob` na plik — przeglądarka trzyma go poza pamięcią JS.
          parts.push(new Blob([workspaceFileEntry({ attachmentId: row.id, data: bytesToBase64(bytes) }, parts.length === 0)]));
        } catch (e) {
          if (!navigator.onLine) throw e;
          missing.push(String(row.name));
        }
      }
      downloadBlob(exportFileName(name, today, "json"), new Blob([workspaceFileHead(file), ...parts, WORKSPACE_FILE_TAIL], { type: JSON_MIME }));

      const tasks = new Set(file.tables.tasks.map((t) => t.id));
      const unsent = attachments.pending.filter((p) => tasks.has(p.taskId)).length;
      const problems = [
        missing.length ? `nie udało się pobrać: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` i ${missing.length - 5} więcej` : ""}` : null,
        unsent ? `${plural(unsent, FILES)} czeka jeszcze na wysyłkę i nie weszło do eksportu` : null,
      ].filter(Boolean);
      onMessage({
        tone: problems.length ? "info" : "ok",
        text: `Zapisano przestrzeń „${name}”: ${countsText(file)}, ${plural(file.accounts.length, ["osoba z rolą", "osoby z rolami", "osób z rolami"])}.${problems.length ? ` Uwaga: ${problems.join("; ")}.` : ""}`,
      });
    } catch (e) {
      onMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Button kind="ghost" disabled={!!busy} onClick={() => void run()} title="Zapisz całą przestrzeń do pliku JSON: zadania, załączniki, współpracownicy i role" data-testid="workspace-export">
      {busy ?? "Eksportuj"}
    </Button>
  );
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────

type Choice = ShareRole | "none";

interface Pending {
  fileName: string;
  file: WorkspaceFile;
  invalid: InvalidRow[];
  contents: Map<string, Blob>;
  context: WorkspaceImportContext;
  importId: string;
  usage: { used: number; quota: number } | null;
  /** Włączone reguły zdarzeniowe bez ograniczenia do list i przestrzeni — zareagują na nowe zadania. */
  openRules: number;
}

async function* textChunks(blob: Blob): AsyncGenerator<string> {
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

async function attachmentUsage(): Promise<Pending["usage"]> {
  const { data } = await supabaseBrowser().rpc("attachment_usage");
  const usage = (data ?? {}) as { used?: unknown; quota?: unknown };
  return typeof usage.used === "number" && typeof usage.quota === "number" ? { used: usage.used, quota: usage.quota } : null;
}

async function countOpenRules(store: TabStore): Promise<number> {
  const rows = await store.query<{ trigger: string }>("select trigger from plugin_rules where deleted_at is null and enabled = 1");
  return rows.filter((r) => {
    try {
      const trigger = JSON.parse(r.trigger) as { kind?: string; filter?: { lists?: unknown; workspaces?: unknown } };
      return trigger.kind === "event" && !trigger.filter?.lists && !trigger.filter?.workspaces;
    } catch {
      return false;
    }
  }).length;
}

/** Czeka, aż outbox będzie pusty (w karcie, która nie jest liderem, `sync()` może przekroczyć czas odpowiedzi). */
async function waitUntilSent(store: TabStore): Promise<boolean> {
  for (let i = 0; i < SEND_ATTEMPTS && navigator.onLine; i++) {
    await store.sync().catch(() => undefined);
    if ((await store.pendingCount()) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/** Karta „Import przestrzeni” pod listą przestrzeni. */
export function WorkspaceImportCard({ email }: { email: string | null }) {
  const { store, userId } = useAppEnv();
  const attachments = useAttachments();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const choose = async (picked: File) => {
    setBusy("Sprawdzanie pliku…");
    setMessage(null);
    setPending(null);
    try {
      const contents = new Map<string, Blob>();
      const { file, invalid } = await readWorkspaceFile(textChunks(picked), (id, bytes) => void contents.set(id, new Blob([bytes])));
      const [context, usage, openRules] = await Promise.all([workspaceImportContext(store.query, userId), attachmentUsage().catch(() => null), countOpenRules(store)]);
      setPending({ fileName: picked.name, file, invalid, contents, context, importId: uuidv7(), usage, openRules });
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const run = async (p: Pending, name: string, invites: readonly { email: string; role: ShareRole }[]) => {
    setBusy("Import…");
    setMessage(null);
    try {
      if (!navigator.onLine) throw new Error(OFFLINE);
      const plan = workspaceImportPlan(p.file, { userId, email, importId: p.importId, name, ...p.context, contents: new Set(p.contents.keys()) });
      await applyBackupPlan(store.mutateMany, plan, (done, total) => setBusy(`Import… ${done}/${total}`));
      await attachments.restoreFiles(plan.files.map(({ sourceId, ...file }) => ({ ...file, data: p.contents.get(sourceId)! })));
      setBusy("Wysyłanie na serwer…");
      const sent = await waitUntilSent(store);
      const invited: string[] = [];
      const failed: string[] = [];
      for (const person of invites) {
        setBusy(`Zaproszenia… ${invited.length + failed.length + 1}/${invites.length}`);
        try {
          if (!sent) throw new Error("przestrzeń nie dotarła jeszcze na serwer");
          await shareWorkspace(plan.workspaceId, person.email, person.role);
          invited.push(person.email);
        } catch (e) {
          failed.push(`${person.email} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      setPending(null);
      const lines = [
        `Utworzono przestrzeń „${name}”.`,
        plan.files.length ? `${plural(plan.files.length, FILES)} wysyła się w tle.` : null,
        invited.length ? `Zaproszenia wysłane: ${invited.join(", ")}.` : null,
        failed.length ? `Bez zaproszenia: ${failed.join("; ")}. Możesz zaprosić ponownie przez „Udostępnij”.` : null,
        plan.missingFiles ? `Bez zawartości w pliku eksportu: ${plural(plan.missingFiles, ["załącznik", "załączniki", "załączników"])}.` : null,
        plan.otherReminders ? `Pominięte przypomnienia innych osób: ${plan.otherReminders}.` : null,
        sent ? null : "Dane wyślą się na serwer po połączeniu.",
      ];
      setMessage({ tone: failed.length || plan.missingFiles || !sent ? "info" : "ok", text: lines.filter(Boolean).join(" ") });
    } catch (e) {
      reportError("error", e, { source: "workspace-import" });
      setMessage({ tone: "error", text: `${errorText(e)} Ponowienie dokończy ten sam import (bez duplikatów).` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold">Import przestrzeni</h3>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Plik JSON z przycisku „Eksportuj” przy przestrzeni: listy, zadania i cykliczne z historią, komentarze, tagi, przypomnienia, zależności, czas pracy, współpracownicy, role i załączniki. Import tworzy nową przestrzeń (istniejących nie
        zmienia). Bez kosza, historii zmian i integracji.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!!busy} onClick={() => input.current?.click()} data-testid="workspace-import">
          Importuj z pliku…
        </Button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="hidden"
          data-testid="workspace-import-file"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (picked) void choose(picked);
          }}
        />
        {busy ? <span className="text-xs text-[var(--muted)]">{busy}</span> : null}
      </div>
      {message ? (
        <div className="mt-3" data-testid="workspace-import-message">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      ) : null}
      {pending ? <ImportPreview key={pending.importId} pending={pending} email={email} busy={!!busy} onImport={(name, invites) => void run(pending, name, invites)} onCancel={() => setPending(null)} /> : null}
    </Card>
  );
}

function ImportPreview({
  pending,
  email,
  busy,
  onImport,
  onCancel,
}: {
  pending: Pending;
  email: string | null;
  busy: boolean;
  onImport: (name: string, invites: { email: string; role: ShareRole }[]) => void;
  onCancel: () => void;
}) {
  const { file, invalid, usage, openRules } = pending;
  const [name, setName] = useState(() => importedWorkspaceName(String(file.workspace.name), pending.context.workspaceNames));
  const [people] = useState(() => workspaceFilePeople(file, email));
  const [choices, setChoices] = useState<Record<string, Choice>>(() => Object.fromEntries(people.map((p) => [p.email, p.suggested ? p.invite : "none"])));
  const invites = people.flatMap((p) => (choices[p.email] === "none" ? [] : [{ email: p.email, role: choices[p.email] as ShareRole }]));
  const counts = workspaceFileCounts(file);
  const bytes = [...pending.contents.values()].reduce((sum, b) => sum + b.size, 0);
  const missing = counts.files - pending.contents.size;
  return (
    <section className="mt-4 rounded-md border border-[var(--line)] p-3 text-sm" aria-label="Podgląd importu przestrzeni" data-testid="workspace-import-preview">
      <p className="mb-2">
        <strong>{pending.fileName}</strong> — przestrzeń „{String(file.workspace.name)}” z {new Date(file.exportedAt).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}
        {file.exportedBy.email ? `, zapisana przez ${file.exportedBy.email}` : ""}.
      </p>
      <p className="mb-3 text-xs text-[var(--muted)]">{countsText(file)}</p>
      <label className="mb-3 flex flex-wrap items-center gap-2">
        Nazwa nowej przestrzeni
        <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className="min-w-48 flex-1" data-testid="workspace-import-name" />
      </label>
      {people.length ? (
        <>
          <p className="mb-1 font-medium">Osoby i role</p>
          <p className="mb-2 text-xs text-[var(--muted)]">Każda wybrana osoba dostanie zaproszenie do nowej przestrzeni i musi je przyjąć. Adres musi mieć konto albo być na liście zaproszonych do aplikacji na tym serwerze.</p>
          <ul className="mb-3 divide-y divide-[var(--line)]">
            {people.map((p) => (
              <PersonRow key={p.email} person={p} value={choices[p.email] ?? "none"} onChange={(value) => setChoices((c) => ({ ...c, [p.email]: value }))} />
            ))}
          </ul>
        </>
      ) : null}
      <div className="flex flex-col gap-2">
        {usage && usage.used + bytes > usage.quota ? <Notice tone="info">{`Załączniki (${formatBytes(bytes)}) nie zmieszczą się w całości — nadmiarowe zostaną jako niewysłane. ${attachmentQuotaMessage(usage.used, usage.quota)}`}</Notice> : null}
        {missing > 0 ? <Notice tone="info">{`Plik eksportu nie ma zawartości ${missing} z ${plural(counts.files, ["załącznika", "załączników", "załączników"])}.`}</Notice> : null}
        {openRules ? <Notice tone="info">{`Masz włączone reguły integracji obejmujące wszystkie przestrzenie (${openRules}) — mogą zareagować na importowane zadania. Wyłącz je na czas importu w Ustawieniach → „Integracje”.`}</Notice> : null}
        {invalid.length ? (
          <Notice tone="error">
            Pominięte błędne wiersze: {invalid.length}
            {invalid.slice(0, 3).map((row, i) => (
              <span key={i} className="block text-xs">
                {BACKUP_TABLE[row.table]} {row.id ?? "?"}: {row.message}
              </span>
            ))}
          </Notice>
        ) : null}
      </div>
      <div className="mt-3 flex gap-2">
        <Button kind="primary" disabled={busy || !name.trim()} onClick={() => onImport(name.trim(), invites)} data-testid="workspace-import-run">
          {invites.length ? `Importuj i zaproś (${plural(invites.length, ["osoba", "osoby", "osób"])})` : "Importuj"}
        </Button>
        <Button kind="ghost" disabled={busy} onClick={onCancel}>
          Anuluj
        </Button>
      </div>
    </section>
  );
}

function PersonRow({ person, value, onChange }: { person: WorkspaceFilePerson; value: Choice; onChange: (value: Choice) => void }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="min-w-0 flex-1 truncate">
        {person.email}
        <span className="ml-2 text-xs opacity-60">
          {SCOPE_ROLE[person.role].toLowerCase()}
          {person.pending ? ", zaproszenie bez odpowiedzi" : ""}
        </span>
      </span>
      <Select aria-label={`Rola po imporcie: ${person.email}`} value={value} onChange={(e) => onChange(e.target.value as Choice)} className="w-40">
        <option value="editor">{SCOPE_ROLE.editor}</option>
        <option value="viewer">{SCOPE_ROLE.viewer}</option>
        <option value="none">Nie zapraszaj</option>
      </Select>
    </li>
  );
}
