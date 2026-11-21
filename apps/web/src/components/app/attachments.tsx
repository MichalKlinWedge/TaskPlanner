"use client";
/* eslint-disable @next/next/no-img-element -- obrazy z `blob:` i ikony obcych stron; next/image tu nie pasuje */

/**
 * Załączniki zadania (M5, Etap 10). Pliki: wybór / upuszczenie / wklejenie → kolejka plików
 * (`@taskplanner/sync` `createFileQueue`, zawartość w IndexedDB) → Storage → wiersz `attachments`
 * dopiero po wysyłce. Podgląd obrazów i PDF w oknie; pobrane pliki w pamięci podręcznej przeglądarki
 * (Cache API), więc otwierają się też offline. Linki: wiersz od razu, podgląd strony (`link-preview`)
 * dociąga karta-lider w tle — z tytułem zadania, jeśli był samym adresem.
 */
import {
  attachmentPath,
  attachmentView,
  fileAttachmentPatch,
  fileProblem,
  formatBytes,
  linkAttachmentOp,
  linkPreviewOps,
  normalizePreview,
  parseHttpUrl,
  plural,
  uuidv7,
  type ViewTask,
} from "@taskplanner/core";
import { createFileQueue, supabaseUploader, type FileQueue, type PendingFile, type TabStore } from "@taskplanner/sync";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";

import type { Attachment } from "@/lib/app-data";
import { indexedDbFileStore } from "@/lib/file-store";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { Button, Input } from "./ui";

// ── Kolejka i podgląd linków ─────────────────────────────────────────────────────────────────

interface AttachmentsApi {
  pending: PendingFile[];
  addFiles: (taskId: string, files: readonly File[]) => Promise<void>;
  retry: (id: string) => void;
  discard: (id: string) => void;
  /** Adres do wyświetlenia: plik w kolejce (z IndexedDB) albo pobrany z Storage (pamięć podręczna). */
  objectUrl: (item: { id: string; storagePath: string | null; mime: string | null }) => Promise<string>;
}

const Ctx = createContext<AttachmentsApi | null>(null);

export const useAttachments = (): AttachmentsApi => {
  const api = useContext(Ctx);
  if (!api) throw new Error("useAttachments poza <AttachmentsProvider>.");
  return api;
};

/** Pobrane pliki (niezmienne) — klucz to ścieżka w Storage; poza prefiksem `tp-`, który czyści Service Worker. */
const FILE_CACHE = "taskplanner-attachments";
const cacheKey = (path: string) => `${location.origin}/__attachments/${encodeURIComponent(path)}`;

async function storedFile(path: string): Promise<Blob> {
  const cache = typeof caches !== "undefined" ? await caches.open(FILE_CACHE).catch(() => null) : null;
  const hit = await cache?.match(cacheKey(path));
  if (hit) return hit.blob();
  const { data, error } = await supabaseBrowser().storage.from("attachments").download(path);
  if (error || !data) throw new Error(navigator.onLine ? `Nie udało się pobrać pliku: ${error?.message ?? "brak danych"}` : "Plik nie był pobrany na tym urządzeniu — otworzy się po połączeniu.");
  await cache?.put(cacheKey(path), new Response(data, { headers: { "content-type": data.type || "application/octet-stream" } })).catch(() => undefined);
  return data;
}

const functionsBase = () => `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "")}/functions/v1`;

/** `link-preview`: `null` = spróbuj później (offline, sesja, błąd serwera). */
async function fetchLinkPreview(url: string): Promise<unknown | null> {
  if (!navigator.onLine) return null;
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const res = await fetch(`${functionsBase()}/link-preview`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as { preview?: unknown } | null;
  return json ? (json.preview ?? {}) : null;
}

/**
 * Podglądy linków bez `preview` (także dodane offline i na innych urządzeniach) — tylko w karcie-liderze,
 * po kilka naraz; nieudana próba wraca przy następnym połączeniu.
 */
function useLinkPreviews(store: TabStore) {
  const tried = useRef(new Set<string>());
  useEffect(() => {
    let busy = false;
    let stopped = false;
    const run = async () => {
      if (busy || stopped || !store.isLeader || !navigator.onLine) return;
      busy = true;
      try {
        const rows = await store.query<{ id: string; url: string; task_id: string; title: string | null }>(
          `select a.id, a.url, a.task_id, t.title from attachments a left join tasks t on t.id = a.task_id and t.deleted_at is null
            where a.kind = 'link' and a.preview is null and a.deleted_at is null and a.url is not null order by a.id desc limit 20`,
        );
        for (const row of rows.filter((r) => !tried.current.has(r.id)).slice(0, 5)) {
          tried.current.add(row.id);
          const preview = await fetchLinkPreview(row.url);
          if (preview === null) continue;
          await store.mutateMany(linkPreviewOps({ id: row.id, url: row.url }, row.title === null ? null : { id: row.task_id, title: row.title }, normalizePreview(preview)));
        }
      } catch (error) {
        console.warn("link-preview", error);
      } finally {
        busy = false;
      }
    };
    const online = () => {
      tried.current.clear();
      void run();
    };
    const unwatch = store.watch(["attachments"], () => void run());
    const unrole = store.onRole(() => void run());
    const timer = setInterval(() => void run(), 60_000);
    window.addEventListener("online", online);
    void run();
    return () => {
      stopped = true;
      unwatch();
      unrole();
      clearInterval(timer);
      window.removeEventListener("online", online);
    };
  }, [store]);
}

export function AttachmentsProvider({ store, userId, children }: { store: TabStore; userId: string; children: ReactNode }) {
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [queue] = useState<FileQueue>(() => {
    const files = indexedDbFileStore(userId);
    let refresh = () => {};
    const created = createFileQueue({
      store: files,
      upload: supabaseUploader(supabaseBrowser()),
      commit: (f) => store.mutate("attachments", f.id, fileAttachmentPatch({ taskId: f.taskId, storagePath: f.storagePath, name: f.name, mime: f.mime, size: f.size })),
      onChange: () => refresh(),
      // Jedna karta wysyła naraz (pliki są wspólne dla kart w IndexedDB).
      exclusive: (work) => (typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request(`tp-files-${userId}`, work) : work()),
    });
    refresh = () => void created.list().then(setPending, () => undefined);
    return created;
  });

  const flush = useCallback(async () => {
    if (!navigator.onLine) return;
    // Zadanie z tego samego offline'u musi być na serwerze przed plikiem (reguły Storage).
    await store.sync().catch(() => undefined);
    await queue.flush().catch((e: unknown) => console.warn("files", e));
  }, [store, queue]);

  useEffect(() => {
    void queue.list().then(setPending, () => undefined);
    void flush();
    const timer = setInterval(() => void flush(), 30_000);
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", online);
    };
  }, [queue, flush]);

  useLinkPreviews(store);

  const urls = useRef(new Map<string, string>());
  const api: AttachmentsApi = {
    pending,
    addFiles: async (taskId, files) => {
      for (const file of files) {
        const id = uuidv7();
        await queue.enqueue({ id, taskId, storagePath: attachmentPath(userId, taskId, id, file.name), name: file.name, mime: file.type || "application/octet-stream", size: file.size }, file);
      }
      void flush();
    },
    retry: (id) => void queue.retry(id).then(flush),
    discard: (id) => void queue.discard(id),
    objectUrl: async ({ id, storagePath, mime }) => {
      const known = urls.current.get(id);
      if (known) return known;
      const local = await queue.data(id);
      const blob = local ? new Blob([local as BlobPart], { type: mime ?? "" }) : storagePath ? await storedFile(storagePath) : null;
      if (!blob) throw new Error("Brak pliku.");
      const url = URL.createObjectURL(blob);
      urls.current.set(id, url);
      return url;
    },
  };
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

// ── Panel zadania ────────────────────────────────────────────────────────────────────────────

type Shown = { id: string; storagePath: string | null; name: string; mime: string | null };

/** Sekcja „Załączniki” w panelu zadania: linki, pliki (z wysyłanymi), dodawanie i podgląd. */
/** `readOnly` — przestrzeń udostępniona do podglądu: tylko otwieranie, bez dodawania i usuwania. */
export function AttachmentsField({ task, readOnly = false }: { task: ViewTask; readOnly?: boolean }) {
  const { data } = useAppEnv();
  const { run, notify } = useTaskActions();
  const api = useAttachments();
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const items = data.attachments.get(task.id) ?? [];
  const waiting = api.pending.filter((p) => p.taskId === task.id && !items.some((i) => i.id === p.id));

  const add = (files: readonly File[]) => {
    const problems = files.map((f) => fileProblem({ name: f.name, mime: f.type, size: f.size })).filter(Boolean);
    if (problems.length) notify(problems.join(" "));
    const ok = files.filter((f) => !fileProblem({ name: f.name, mime: f.type, size: f.size }));
    if (ok.length) void api.addFiles(task.id, ok).then(() => notify(navigator.onLine ? `Wysyłanie: ${plural(ok.length, ["plik", "pliki", "plików"])}` : `${plural(ok.length, ["plik czeka", "pliki czekają", "plików czeka"])} na połączenie`));
  };
  const addLink = () => {
    const parsed = parseHttpUrl(url);
    if (!parsed) return notify("Podaj adres zaczynający się od http:// albo https://");
    const op = linkAttachmentOp(task.id, parsed.href);
    void run([op], { text: "Dodano link", undo: [{ table: "attachments", id: op.id, patch: { deleted_at: new Date().toISOString() } }] });
    setUrl("");
    setLinking(false);
  };
  const remove = (a: Attachment) => {
    void run([{ table: "attachments", id: a.id, patch: { deleted_at: new Date().toISOString() } }], { text: `Usunięto „${a.name}”`, undo: [{ table: "attachments", id: a.id, patch: { deleted_at: null } }] });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    add([...event.dataTransfer.files]);
  };
  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    add(files);
  };

  const links = items.filter((a) => a.kind === "link");
  const files = items.filter((a) => a.kind === "file");

  return (
    <section
      className={`border-t border-[var(--line)] pt-3 ${over ? "rounded-md bg-[var(--accent)]/5 outline-2 outline-dashed outline-[var(--accent)]" : ""}`}
      aria-label="Załączniki"
      onDragOver={(e) => {
        if (!readOnly && [...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={readOnly ? undefined : onDrop}
      onPaste={readOnly ? undefined : onPaste}
    >
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
        Załączniki
        {items.length + waiting.length ? <span className="font-normal normal-case">· {items.length + waiting.length}</span> : null}
        <span className="ml-auto flex gap-1 normal-case">
          <Button className="px-2 py-0.5 text-xs" disabled={readOnly} onClick={() => picker.current?.click()}>
            📎 Plik
          </Button>
          <Button className="px-2 py-0.5 text-xs" disabled={readOnly} onClick={() => setLinking((v) => !v)}>
            🔗 Link
          </Button>
        </span>
      </h3>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="Wybierz pliki"
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {linking ? (
        <form
          className="mb-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addLink();
          }}
        >
          <Input type="url" value={url} autoFocus placeholder="https://…" aria-label="Adres linku" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setLinking(false)} className="flex-1 text-sm" />
          <Button type="submit" kind="primary">
            Dodaj
          </Button>
        </form>
      ) : null}

      {links.length ? (
        <ul className="mb-2 flex flex-col gap-1" aria-label="Linki">
          {links.map((a) => (
            <LinkRow key={a.id} item={a} onRemove={readOnly ? undefined : () => remove(a)} />
          ))}
        </ul>
      ) : null}

      {files.length || waiting.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Pliki">
          {files.map((a) => (
            <FileTile key={a.id} item={a} onOpen={() => setShown(a)} onRemove={readOnly ? undefined : () => remove(a)} />
          ))}
          {waiting.map((p) => (
            <PendingTile key={p.id} file={p} onOpen={() => setShown({ id: p.id, storagePath: null, name: p.name, mime: p.mime })} />
          ))}
        </ul>
      ) : null}

      {!items.length && !waiting.length && !linking ? (
        <p className="text-xs text-[var(--muted)]">{readOnly ? "Brak załączników." : "Przeciągnij tu pliki albo wklej obraz (Ctrl+V) — do 25 MB."}</p>
      ) : null}
      {shown ? <PreviewDialog item={shown} onClose={() => setShown(null)} /> : null}
    </section>
  );
}

function LinkRow({ item, onRemove }: { item: Attachment; onRemove?: () => void }) {
  const p = item.preview;
  return (
    <li className="group flex items-center gap-2 rounded-md border border-[var(--line)] px-2 py-1.5 text-sm" data-attachment-id={item.id}>
      {p?.icon ? <img src={p.icon} alt="" width={16} height={16} className="h-4 w-4 shrink-0" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span aria-hidden>🔗</span>}
      <a href={item.url ?? "#"} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 hover:underline">
        <span className="block truncate">{item.name}</span>
        <span className="block truncate text-xs text-[var(--muted)]">{p === null ? "Pobieranie podglądu…" : [p.siteName, p.description].filter(Boolean).join(" · ") || item.url}</span>
      </a>
      {onRemove ? (
        <button type="button" aria-label={`Usuń „${item.name}”`} className="text-xs opacity-50 group-hover:opacity-100 hover:text-[var(--danger)]" onClick={onRemove}>
          ✕
        </button>
      ) : null}
    </li>
  );
}

/** Miniatura obrazu (po pobraniu) albo ikona typu. */
function Thumb({ item }: { item: { id: string; storagePath: string | null; mime: string | null } }) {
  const api = useAttachments();
  const [src, setSrc] = useState<string | null>(null);
  const image = attachmentView(item.mime) === "image";
  useEffect(() => {
    if (!image) return;
    let alive = true;
    api.objectUrl(item).then(
      (url) => alive && setSrc(url),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [image, item, api]);
  if (src) return <img src={src} alt="" className="h-20 w-full rounded object-cover" />;
  return <span className="flex h-20 items-center justify-center text-3xl" aria-hidden>{attachmentView(item.mime) === "pdf" ? "📄" : image ? "🖼" : "📦"}</span>;
}

function FileTile({ item, onOpen, onRemove }: { item: Attachment; onOpen: () => void; onRemove?: () => void }) {
  return (
    <li className="group relative rounded-md border border-[var(--line)] p-1.5 text-xs" data-attachment-id={item.id}>
      <button type="button" className="block w-full text-left" onClick={onOpen} title={`Otwórz „${item.name}”`}>
        <Thumb item={item} />
        <span className="mt-1 block truncate">{item.name}</span>
        <span className="block text-[var(--muted)]">{item.size !== null ? formatBytes(item.size) : ""}</span>
      </button>
      {onRemove ? (
        <button type="button" aria-label={`Usuń „${item.name}”`} className="absolute top-1 right-1 rounded bg-[var(--surface)] px-1 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[var(--danger)]" onClick={onRemove}>
          ✕
        </button>
      ) : null}
    </li>
  );
}

function PendingTile({ file, onOpen }: { file: PendingFile; onOpen: () => void }) {
  const api = useAttachments();
  return (
    <li className="relative rounded-md border border-dashed border-[var(--line)] p-1.5 text-xs" data-pending-id={file.id}>
      <button type="button" className="block w-full text-left" onClick={onOpen}>
        <Thumb item={{ id: file.id, storagePath: null, mime: file.mime }} />
        <span className="mt-1 block truncate">{file.name}</span>
      </button>
      {file.failed ? (
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[var(--danger)]" title={file.error ?? undefined}>
          Nie wysłano
          <button type="button" className="underline" onClick={() => api.retry(file.id)}>
            ponów
          </button>
          <button type="button" className="underline" onClick={() => api.discard(file.id)}>
            usuń
          </button>
        </span>
      ) : (
        <span className="block text-[var(--muted)]" title={file.error ?? undefined}>
          {formatBytes(file.size)} · {navigator.onLine ? "wysyłanie…" : "czeka na sieć"}
        </span>
      )}
    </li>
  );
}

function PreviewDialog({ item, onClose }: { item: Shown; onClose: () => void }) {
  const api = useAttachments();
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  const view = attachmentView(item.mime);
  useEffect(() => {
    let alive = true;
    api.objectUrl(item).then(
      (url) => alive && setState({ url }),
      (e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [item, api]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={item.name} className="flex max-h-full w-full max-w-4xl flex-col rounded-lg bg-[var(--surface)] shadow-2xl">
        <header className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
          {state.url ? (
            <a href={state.url} download={item.name} className="text-[var(--accent)] hover:underline">
              Pobierz
            </a>
          ) : null}
          <button type="button" aria-label="Zamknij" onClick={onClose} className="px-1 opacity-70 hover:opacity-100">
            ✕
          </button>
        </header>
        <div className="flex min-h-48 flex-1 items-center justify-center overflow-auto p-2">
          {state.error ? (
            <p className="text-sm text-[var(--muted)]">{state.error}</p>
          ) : !state.url ? (
            <p className="text-sm text-[var(--muted)]">Wczytywanie…</p>
          ) : view === "image" ? (
            <img src={state.url} alt={item.name} className="max-h-[75vh] max-w-full object-contain" />
          ) : view === "pdf" ? (
            <iframe src={state.url} title={item.name} className="h-[75vh] w-full rounded border-0" />
          ) : (
            <p className="text-sm">
              Podgląd niedostępny —{" "}
              <a href={state.url} download={item.name} className="text-[var(--accent)] underline">
                pobierz plik
              </a>
              .
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
