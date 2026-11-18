/**
 * Mail → zadanie (SPECYFIKACJA M19): token z adresu, lista nadawców, wynik DMARC, temat bez przedrostków,
 * treść bez cytatów i stopki, zadanie przez parser szybkiego dodawania. Czysty moduł.
 */
import { taskTagId, uuidv7 } from '../../../packages/core/src/ids.ts';
import { parseQuickAdd, type QuickAddContext } from '../../../packages/core/src/quick-add.ts';
import { normalizeWord } from '../../../packages/core/src/quick-add.ts';

import { zonedParts } from './time.ts';

/** `zadania+<token>@domena` → token (małe litery). */
export function recipientToken(address: string): string | null {
  const m = /^[^+@\s]+\+([a-z0-9]{16,64})@[^@\s]+$/i.exec(address.trim().replace(/^<|>$/g, ''));
  return m ? m[1]!.toLowerCase() : null;
}

/** Wpis listy: pełny adres albo `@domena`. */
export function senderAllowed(from: string | null | undefined, senders: readonly string[]): boolean {
  if (!from) return false;
  const addr = from.trim().toLowerCase();
  const domain = addr.slice(addr.lastIndexOf('@'));
  return senders.some((s) => {
    const entry = s.trim().toLowerCase();
    return entry === addr || (entry.startsWith('@') && entry === domain);
  });
}

/**
 * Wynik uwierzytelnienia z nagłówków `Authentication-Results` / `ARC-Authentication-Results`
 * dodanych przez serwer przyjmujący (Cloudflare). Odrzucamy tylko jawne `dmarc=fail` — brak nagłówka
 * nie przesądza (zostaje token + lista nadawców).
 */
export function authenticationFailure(headerValues: readonly string[]): string | null {
  for (const value of headerValues) {
    if (/\bdmarc\s*=\s*fail\b/i.test(value)) return 'dmarc_fail';
  }
  return null;
}

const SUBJECT_PREFIX = /^\s*(?:\[[^\]]{1,40}\]\s*)?(?:re|fwd?|fw|pd|odp|aw|wg|tr|rv|sv|vs)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;

export function cleanSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 10 && SUBJECT_PREFIX.test(s); i++) s = s.replace(SUBJECT_PREFIX, '').trim();
  return s;
}

const REPLY_HEADER = /^(?:On .+ wrote:|W dniu .+ (?:pisze|napisał(?:\(a\)|a)?):|Dnia .+ (?:pisze|napisał(?:\(a\)|a)?):|.+ <[^>]+> (?:wrote|napisał(?:\(a\)|a)?):)\s*$/;
const MOBILE_FOOTER = /^(?:Sent from my .+|Wysłane z (?:mojego )?.+|Pobierz Outlook dla .+|Get Outlook for .+)$/i;

/**
 * Treść do opisu: bez cytowanej odpowiedzi (linie `>` i wszystko po „W dniu … napisał:”), bez stopki
 * (`-- `) i dopisków „Wysłane z…”. Przekazana wiadomość (Fwd) zostaje — to ona jest treścią zadania.
 */
export function cleanBody(text: string | null | undefined, maxLength = 20_000): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^-- ?$/.test(line) || /^_{10,}$/.test(line.trim())) break;
    if (REPLY_HEADER.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    if (MOBILE_FOOTER.test(line.trim())) continue;
    out.push(line.replace(/\s+$/, ''));
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return body.length > maxLength ? `${body.slice(0, maxLength)}…` : body;
}

/** Bardzo prosty HTML → tekst (gdy mail nie ma części tekstowej). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ── Zadanie ──────────────────────────────────────────────────────────────────────────────────

export interface InboundContext {
  workspaces: { id: string; name: string }[];
  lists: { id: string; name: string; kind: string; workspaceId: string }[];
  tags: { id: string; name: string }[];
}

export interface InboundMail {
  subject: string | null;
  text: string | null;
  html: string | null;
  from: string;
  messageId: string | null;
  receivedAt: string;
}

export interface InboundTask {
  task: Record<string, unknown> & { id: string; list_id: string; title: string };
  tags: { id: string; tagId: string }[];
}

/**
 * Zadanie z maila: temat przez parser szybkiego dodawania („Faktura za prąd jutro #dom !2”), opis =
 * oczyszczona treść. Lista: `#lista`/`#przestrzeń` z tematu, inaczej `defaultListId`, inaczej Inbox
 * pierwszej przestrzeni. `null` = użytkownik nie ma żadnej listy, do której można pisać.
 */
export function buildInboundTask(mail: InboundMail, ctx: InboundContext, opts: { zone: string; nowMs: number; defaultListId?: string | null }): InboundTask | null {
  const inboxOf = (workspaceId: string) => ctx.lists.find((l) => l.workspaceId === workspaceId && l.kind === 'inbox');
  const fallback =
    ctx.lists.find((l) => l.id === opts.defaultListId) ??
    ctx.workspaces.map((w) => inboxOf(w.id)).find(Boolean) ??
    ctx.lists[0];
  if (!fallback) return null;

  const wsName = (id: string) => ctx.workspaces.find((w) => w.id === id)?.name ?? '';
  const local = zonedParts(opts.nowMs, opts.zone);
  const qa: QuickAddContext = {
    now: `${local.date}T${local.time}`,
    currentWorkspace: wsName(fallback.workspaceId) || undefined,
    workspaces: ctx.workspaces.map((w) => w.name),
    lists: ctx.lists.map((l) => ({ workspace: wsName(l.workspaceId), name: l.name, kind: l.kind })),
    tags: ctx.tags.map((t) => t.name),
  };
  const subject = cleanSubject(mail.subject);
  const parsed = subject ? parseQuickAdd(subject, qa) : null;
  const f = parsed?.fields ?? {};

  let list = fallback;
  if (f.target) {
    const ws = ctx.workspaces.find((w) => w.name === f.target!.workspace);
    const hit =
      f.target.kind === 'workspace'
        ? ws && inboxOf(ws.id)
        : ctx.lists.find((l) => l.name === f.target!.name && (!ws || l.workspaceId === ws.id));
    if (hit) list = hit;
  }

  const id = uuidv7(opts.nowMs);
  const task: InboundTask['task'] = {
    id,
    list_id: list.id,
    title: (parsed?.title || subject || '(bez tematu)').slice(0, 500),
    source: { kind: 'email', from: mail.from, messageId: mail.messageId, receivedAt: mail.receivedAt },
  };
  const body = cleanBody(mail.text ?? (mail.html ? htmlToText(mail.html) : ''));
  if (body) task.description_md = body;
  if (f.priority) task.priority = f.priority;
  if (f.dueDate) task.due_date = f.dueDate;
  if (f.dueTime) task.due_time = f.dueTime;
  if (f.durationMin) task.duration_min = f.durationMin;
  if (f.recurrence) task.recurrence = f.recurrence;

  const tags = (f.tags ?? [])
    .map((name) => ctx.tags.find((t) => normalizeWord(t.name) === normalizeWord(name)))
    .filter((t): t is { id: string; name: string } => !!t)
    .map((t) => ({ id: taskTagId(id, t.id), tagId: t.id }));
  return { task, tags };
}
