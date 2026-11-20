/**
 * Załączniki na telefonie (Etap 10, M5): kolejka plików `createFileQueue` z `@taskplanner/sync` —
 * ta sama co na webie (`apps/web/src/components/app/attachments.tsx`), reguły z `core/attachments.ts`.
 *
 * Plik z aparatu / galerii / wyboru plików jest od razu kopiowany do plików aplikacji
 * (`Paths.document/pending-files/<id>`), metadane kolejki leżą w kv-store (per użytkownik). Wysyłka do
 * bucketu `attachments` rusza po udanej synchronizacji (`onSynced` — zadanie z tego samego offline'u
 * musi już być na serwerze, bo reguły Storage sprawdzają zadanie), a wiersz `attachments` trafia do
 * outboxu dopiero po wysyłce. Wysłany plik zostaje w pamięci podręcznej (`Paths.cache/attachments`),
 * więc podgląd działa też bez sieci; pliki z innych urządzeń są pobierane przy pierwszym otwarciu.
 *
 * Podglądy linków (`link-preview`) dla wierszy bez `preview` — też po synchronizacji i po zmianie
 * tabeli `attachments`; tytuł zadania będący samym adresem zastępuje tytuł strony (`linkPreviewOps`).
 */
import { attachmentPath, fileAttachmentPatch, linkPreviewOps, normalizePreview, uuidv7, type NewFile } from '@taskplanner/core';
import { createFileQueue, supabaseUploader, type FileQueue, type FileStore, type PendingFile, type SqlRow } from '@taskplanner/sync';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { readJson, serverConfig, sessionUser, writeJson } from './config';
import { reportError } from './error-log';
import { localEngine, mutate, onSessionChange, onSynced, supabaseClient } from './sync';

// ── Magazyn ─────────────────────────────────────────────────────────────────────────────────

const pendingDir = (userId: string) => new Directory(Paths.document, 'pending-files', userId);
const cacheDir = () => new Directory(Paths.cache, 'attachments');
const metaKey = (userId: string) => `files.pending.${userId}`;

function ensure(dir: Directory) {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Plik w pamięci podręcznej: ostatni człon ścieżki Storage (`<id załącznika>-<nazwa>`, z rozszerzeniem). */
const cachedFile = (storagePath: string) => new File(cacheDir(), storagePath.split('/').pop() ?? storagePath);

/** `FileStore` w plikach aplikacji: zawartość pod `pending-files/<user>/<id>`, metadane w kv-store. */
function appFileStore(userId: string): FileStore {
  const dir = pendingDir(userId);
  const fileOf = (id: string) => new File(dir, id);
  const read = () => readJson<PendingFile[]>(metaKey(userId), []);
  return {
    list: async () => read(),
    async put(file, data) {
      const current = read();
      const known = current.some((f) => f.id === file.id);
      if (!known && !data) return;
      if (data) {
        const target = fileOf(file.id);
        // Plik zwykle już tu jest (`addFile` kopiuje go przed `enqueue`).
        if (!(data instanceof File && data.uri === target.uri)) {
          ensure(dir);
          target.write(data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer()));
        }
      }
      writeJson(metaKey(userId), known ? current.map((f) => (f.id === file.id ? file : f)) : [...current, file]);
    },
    async data(id) {
      const file = fileOf(id);
      return file.exists ? file : null;
    },
    async remove(id) {
      writeJson(
        metaKey(userId),
        read().filter((f) => f.id !== id),
      );
      const file = fileOf(id);
      if (file.exists) file.delete();
    },
  };
}

// ── Kolejka ─────────────────────────────────────────────────────────────────────────────────

let queue: { userId: string; queue: FileQueue } | null = null;
let pending: PendingFile[] = [];
const listeners = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function setPending(files: PendingFile[]) {
  pending = files;
  listeners.forEach((l) => l());
  // Najbliższe ponowienie (kolejka wydłuża przerwy: 5 s, 10 s … 10 min).
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const next = Math.min(...files.filter((f) => !f.failed).map((f) => f.nextAt));
  if (Number.isFinite(next)) retryTimer = setTimeout(() => void flushFiles(), Math.max(1_000, next - Date.now()));
}

function fileQueue(): FileQueue {
  const userId = sessionUser().id;
  if (queue?.userId === userId) return queue.queue;
  const store = appFileStore(userId);
  const created = createFileQueue({
    store,
    // Bajty pliku (RN `fetch` wysyła `Uint8Array`; obiektu `File` z expo-file-system nie umie).
    upload: async (path, data, mime) => supabaseUploader(supabaseClient())(path, data instanceof File ? await data.bytes() : data, mime),
    commit: async (f) => {
      // Wysłany plik zostaje na telefonie jako pobrany (podgląd bez sieci).
      const source = await store.data(f.id);
      if (source instanceof File) {
        const target = cachedFile(f.storagePath);
        ensure(cacheDir());
        if (!target.exists) source.copy(target);
      }
      await mutate('attachments', f.id, fileAttachmentPatch({ taskId: f.taskId, storagePath: f.storagePath, name: f.name, mime: f.mime, size: f.size }));
    },
    onChange: () => void created.list().then(setPending, () => undefined),
  });
  queue = { userId, queue: created };
  void created.list().then(setPending, () => undefined);
  return created;
}

const canSend = () => sessionUser().online && !!serverConfig();

/** Wysyłka należnych plików (po synchronizacji — zadania są już na serwerze). */
export async function flushFiles(): Promise<number> {
  if (!canSend()) return 0;
  try {
    return await fileQueue().flush();
  } catch (error) {
    reportError('error', error, { area: 'files' });
    return 0;
  }
}

/** Plik ze źródła (aparat, galeria, wybór pliku) → kopia w plikach aplikacji → kolejka. */
export async function addFile(taskId: string, source: { uri: string } & Partial<NewFile>): Promise<PendingFile['id']> {
  const userId = sessionUser().id;
  const id = uuidv7();
  const original = new File(source.uri);
  const name = source.name?.trim() || original.name || `plik-${id}`;
  const target = new File(ensure(pendingDir(userId)), id);
  original.copy(target);
  const size = target.size || source.size || 0;
  await fileQueue().enqueue({ id, taskId, storagePath: attachmentPath(userId, taskId, id, name), name, mime: source.mime || original.type || 'application/octet-stream', size }, target);
  // Synchronizacja najpierw (zadanie mogło powstać przed chwilą), wysyłka pliku po niej (`onSynced`).
  if (canSend()) (await localEngine()).requestSync(0);
  return id;
}

export const retryFile = async (id: string) => {
  await fileQueue().retry(id);
  void flushFiles();
};

export const discardFile = (id: string) => fileQueue().discard(id);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  fileQueue();
  return () => listeners.delete(listener);
};

/** Pliki czekające na wysyłkę (wszystkie zadania). */
export const usePendingFiles = (): PendingFile[] => useSyncExternalStore(subscribe, () => pending);

// ── Pliki do podglądu ───────────────────────────────────────────────────────────────────────

/**
 * Lokalny plik załącznika: oczekujący w kolejce, już pobrany albo pobrany teraz z Storage
 * (podpisany adres, 60 s). Bez sieci i bez kopii — błąd z komunikatem.
 */
export async function localFile(item: { id: string; storagePath: string | null }): Promise<File> {
  const queued = new File(pendingDir(sessionUser().id), item.id);
  if (queued.exists) return queued;
  if (!item.storagePath) throw new Error('Brak pliku.');
  const cached = cachedFile(item.storagePath);
  if (cached.exists) return cached;
  if (!canSend()) throw new Error('Plik nie był pobrany na tym telefonie — otworzy się po zalogowaniu i połączeniu.');
  const { data, error } = await supabaseClient().storage.from('attachments').createSignedUrl(item.storagePath, 60);
  if (error || !data) throw new Error(`Nie udało się pobrać pliku: ${error?.message ?? 'brak adresu'}`);
  ensure(cacheDir());
  return File.downloadFileAsync(data.signedUrl, cached, { idempotent: true });
}

/** Ścieżka `file://` już dostępnego pliku (miniatury bez pobierania). */
export function localUri(item: { id: string; storagePath: string | null }): string | null {
  const queued = new File(pendingDir(sessionUser().id), item.id);
  if (queued.exists) return queued.uri;
  const cached = item.storagePath ? cachedFile(item.storagePath) : null;
  return cached?.exists ? cached.uri : null;
}

// ── Podglądy linków ─────────────────────────────────────────────────────────────────────────

const tried = new Set<string>();
let previewing = false;

/** `link-preview`: `null` = spróbuj później (sieć, sesja, błąd serwera). */
async function fetchLinkPreview(url: string): Promise<unknown | null> {
  const { data, error } = await supabaseClient().functions.invoke<{ preview?: unknown }>('link-preview', { body: { url } });
  if (error || !data) return null;
  return data.preview ?? {};
}

export async function fillLinkPreviews(): Promise<number> {
  if (previewing || !canSend()) return 0;
  previewing = true;
  let filled = 0;
  try {
    const engine = await localEngine();
    const rows = await engine.db.all<SqlRow>(
      `select a.id, a.url, a.task_id, t.title from attachments a left join tasks t on t.id = a.task_id and t.deleted_at is null
        where a.kind = 'link' and a.preview is null and a.deleted_at is null and a.url is not null order by a.id desc limit 20`,
    );
    for (const row of rows.filter((r) => !tried.has(String(r.id))).slice(0, 5)) {
      tried.add(String(row.id));
      const url = String(row.url);
      const preview = await fetchLinkPreview(url).catch(() => null);
      if (preview === null) continue;
      const ops = linkPreviewOps({ id: String(row.id), url }, row.title === null ? null : { id: String(row.task_id), title: String(row.title) }, normalizePreview(preview));
      for (const op of ops) await mutate(op.table, op.id, op.patch);
      filled++;
    }
  } catch (error) {
    reportError('error', error, { area: 'link-preview' });
  } finally {
    previewing = false;
  }
  return filled;
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────

let started = false;

/**
 * Raz na proces (root layout; zadanie w tle woła `flushFiles` / `fillLinkPreviews` samo):
 * po każdej udanej synchronizacji — pliki i podglądy; po nowym linku w bazie — podgląd od razu.
 */
export function startCapture() {
  if (started) return;
  started = true;
  onSynced(() => {
    tried.clear();
    void flushFiles();
    void fillLinkPreviews();
  });
  onSessionChange(() => {
    queue = null;
    setPending([]);
    tried.clear();
  });
  localEngine()
    .then((engine) => engine.watch(['attachments'], () => void fillLinkPreviews()))
    .catch(() => undefined);
  fileQueue();
}
