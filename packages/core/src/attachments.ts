/**
 * Załączniki i linki (M5, Etap 10): ścieżka pliku w Storage, wiersze `attachments`, link → zadanie
 * i uzupełnienie tytułu z podglądu strony (`link-preview`). Wspólne dla webu i telefonu.
 */
import { uuidv7 } from './ids.ts';
import { AttachmentPreview, MAX_ATTACHMENT_BYTES } from './schemas/model.ts';
import type { TaskOp } from './tasks.ts';

export { MAX_ATTACHMENT_BYTES };

/** Pierwszy adres `http(s)://` w tekście (bez kropki / przecinka / nawiasu zamykającego zdanie). */
export function findUrl(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"']+/i.exec(text);
  if (!match) return null;
  let url = match[0];
  // Interpunkcja na końcu zdania nie należy do adresu; nawias — tylko gdy niesparowany.
  for (;;) {
    const last = url.at(-1)!;
    if (/[.,;:!?…]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    else break;
  }
  return parseHttpUrl(url) ? url : null;
}

/** Adres `http(s)` z hostem albo `null`. */
export function parseHttpUrl(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** Czy tekst to sam adres (tytuł do uzupełnienia z podglądu strony). */
export const isUrlOnly = (text: string): boolean => findUrl(text.trim()) === text.trim() && text.trim() !== '';

/** Krótka nazwa linku bez podglądu: host bez `www.` i początek ścieżki. */
export function linkName(url: string): string {
  const parsed = parseHttpUrl(url);
  if (!parsed) return url.slice(0, 255);
  const path = decodeSafe(parsed.pathname).replace(/\/$/, '');
  const name = `${parsed.hostname.replace(/^www\./, '')}${path}`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

const decodeSafe = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * Bezpieczna nazwa pliku w kluczu Storage (klucz nie przyjmuje polskich znaków i części symboli):
 * bez ogonków, inne znaki → `-`, najwyżej 100 znaków z zachowanym rozszerzeniem. Wyświetlana
 * nazwa zostaje oryginalna (`attachments.name`).
 */
export function storageFileName(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L');
  const dot = folded.lastIndexOf('.');
  const ext = dot > 0 ? folded.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 10) : '';
  const base = (dot > 0 ? folded.slice(0, dot) : folded)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100 - (ext ? ext.length + 1 : 0));
  return `${base || 'plik'}${ext ? `.${ext.toLowerCase()}` : ''}`;
}

/** Ścieżka pliku: `{user_id}/{task_id}/{attachment_id}-{nazwa}` (reguły Storage sprawdzają folder i zadanie). */
export const attachmentPath = (userId: string, taskId: string, attachmentId: string, name: string): string =>
  `${userId}/${taskId}/${attachmentId}-${storageFileName(name)}`;

export type AttachmentView = 'image' | 'pdf' | 'other';

/** Rodzaj podglądu po typie MIME (obrazy i PDF w aplikacji, reszta — pobranie). */
export function attachmentView(mime: string | null | undefined): AttachmentView {
  if (!mime) return 'other';
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i.test(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'other';
}

export interface NewFile {
  name: string;
  mime: string;
  size: number;
}

/** Sprawdzenie pliku przed kolejką: `null` = w porządku, inaczej komunikat. */
export function fileProblem(file: NewFile): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return `„${file.name}” ma więcej niż 25 MB.`;
  if (!file.name.trim()) return 'Plik bez nazwy.';
  return null;
}

/** Pola wiersza `attachments` dla pliku (zapisywane po udanej wysyłce). */
export function fileAttachmentPatch(input: { taskId: string; storagePath: string } & NewFile): Record<string, unknown> {
  return {
    task_id: input.taskId,
    kind: 'file',
    storage_path: input.storagePath,
    name: input.name.trim().slice(0, 255),
    mime: input.mime ? input.mime.slice(0, 200) : null,
    size_bytes: input.size,
    url: null,
    preview: null,
    deleted_at: null,
  };
}

/** Wiersz `attachments` dla linku; podgląd (`preview`) uzupełnia się później. */
export function linkAttachmentOp(taskId: string, url: string, id: string = uuidv7()): TaskOp {
  return { table: 'attachments', id, patch: { task_id: taskId, kind: 'link', storage_path: null, name: linkName(url), mime: null, size_bytes: null, url, preview: null, deleted_at: null } };
}

/**
 * Link → zadanie: do operacji nowego zadania (szybkie dodawanie, udostępnienie, zakładka) dokłada
 * załącznik z adresem z tytułu albo z `url`. Udostępnienie / zakładka (`shared`) zapisuje też
 * `source = { kind: 'link' }`. Tytuł będący samym adresem uzupełni podgląd strony.
 */
export function withLinkOps(created: { taskId: string; ops: TaskOp[] }, input: { title: string; url?: string | null; shared?: boolean; newId?: () => string }): TaskOp[] {
  const url = (input.url && parseHttpUrl(input.url) ? input.url : null) ?? findUrl(input.title);
  if (!url) return created.ops;
  const ops = created.ops.map((op) =>
    input.shared && op.table === 'tasks' && op.id === created.taskId ? { ...op, patch: { ...op.patch, source: { kind: 'link', url, ...(isUrlOnly(input.title) ? {} : { title: input.title.slice(0, 500) }) } } } : op,
  );
  return [...ops, linkAttachmentOp(created.taskId, url, input.newId?.())];
}

/** Tekst udostępnienia (Web Share Target, Android) → wpis szybkiego dodawania i adres. */
export function sharedText(input: { title?: string | null; text?: string | null; url?: string | null }): { text: string; url: string | null } {
  const title = input.title?.trim() ?? '';
  const body = input.text?.trim() ?? '';
  // Chrome na Androidzie często wkłada adres do `text`, a `url` zostawia pusty.
  const url = (input.url && parseHttpUrl(input.url) ? input.url.trim() : null) ?? findUrl(body) ?? findUrl(title);
  const words = [title, body]
    .map((part) => (url ? part.replace(url, '') : part).trim())
    .filter(Boolean)
    .filter((part, i, all) => all.indexOf(part) === i);
  const text = words.join(' — ').replace(/\s+/g, ' ').trim();
  return { text: (text || url || '').slice(0, 500), url };
}

/** Tytuł z podglądu: bez białych znaków na brzegach i wielokrotnych spacji. */
const clean = (text: string | undefined, max: number) => text?.replace(/\s+/g, ' ').trim().slice(0, max) || undefined;

/** Podgląd z odpowiedzi `link-preview` (niepoprawne pola pominięte). */
export function normalizePreview(value: unknown): AttachmentPreview {
  const raw = (typeof value === 'object' && value ? value : {}) as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof raw[k] === 'string' ? clean(raw[k] as string, max) : undefined);
  const url = (k: string) => {
    const v = typeof raw[k] === 'string' ? (raw[k] as string) : undefined;
    return v && parseHttpUrl(v) && v.length <= 2000 ? v : undefined;
  };
  const preview = { title: str('title', 500), description: str('description', 2000), siteName: str('siteName', 200), image: url('image'), icon: url('icon') };
  const parsed = AttachmentPreview.safeParse(Object.fromEntries(Object.entries(preview).filter(([, v]) => v !== undefined)));
  return parsed.success ? parsed.data : {};
}

/**
 * Uzupełnienie po podglądzie strony: załącznik dostaje `preview` (pusty obiekt = podgląd
 * niedostępny, bez ponawiania) i nazwę z tytułu strony; zadanie — tytuł strony, jeśli jego tytuł
 * to wciąż sam adres (użytkownik nie zdążył go zmienić).
 */
export function linkPreviewOps(attachment: { id: string; url: string }, task: { id: string; title: string } | null, preview: AttachmentPreview): TaskOp[] {
  const title = clean(preview.title, 500);
  const ops: TaskOp[] = [{ table: 'attachments', id: attachment.id, patch: { preview, ...(title && { name: title.slice(0, 255) }) } }];
  if (task && title && task.title.trim() === attachment.url) ops.push({ table: 'tasks', id: task.id, patch: { title } });
  return ops;
}
