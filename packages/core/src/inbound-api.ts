/**
 * Przychodzące API (v1.x): inna aplikacja — na start Expedition Plan — tworzy i aktualizuje zadania w Task
 * Plannerze tokenem osobistym (Edge Function `inbound-api`, migracja `*_v1x_inbound_api.sql`).
 *
 *   PUT /functions/v1/inbound-api/tasks/<klucz>   Authorization: Bearer tpk_…   → utworzenie / scalenie
 *   GET /functions/v1/inbound-api/tasks/<klucz>                                  → bieżący stan zadania
 *
 * Kontrakt ustalony z Expedition Plan: `docs/INTEGRACJA_TP.md` w repozytorium EP (`PlannerTaskInput`,
 * `PlannerTaskResult` w jego `packages/core/src/taskplanner.ts`).
 *
 * Klucz zewnętrzny (`ep:<tripId>:<ref>`) wyznacza id zadania (`apiTaskId`), więc powtórka jest idempotentna.
 * Kolejne zapisy scalają się trójstronnie z ostatnią wysyłką: nadpisane są tylko pola, których użytkownik nie
 * zmienił w Task Plannerze. Token daje dostęp wyłącznie do zadań ze swoim kluczem — nigdy do innych.
 * Czysty TS: te same schematy w Edge Function (Deno), na webie i w testach.
 */
import { z } from 'zod';

import { tagId, taskTagId } from './ids.ts';
import { PluginTaskData, taskUrl } from './plugins/payload.ts';
import { TimeZone, type TaskSource } from './schemas/model.ts';
import { LocalDate, type Priority, type TaskStatus } from './schemas/primitives.ts';

/** Najwięcej bajtów treści jednego zapytania. */
export const INBOUND_MAX_BODY_BYTES = 64 * 1024;
/** Najwięcej zapytań na token w minucie (nadmiar = 429). */
export const INBOUND_RATE_PER_MINUTE = 60;
/** Najwięcej aktywnych tokenów na konto. */
export const MAX_API_TOKENS = 10;
/** Najwięcej tagów zadania w jednym zapisie. */
export const INBOUND_MAX_TAGS = 20;
/** Najdłuższy opis (znaki). */
export const INBOUND_MAX_DESCRIPTION = 20_000;

// ── Token ────────────────────────────────────────────────────────────────────────────────────

/** Przedrostek tokenu — łatwo go rozpoznać w konfiguracji i w skanerach sekretów. */
export const API_TOKEN_PREFIX = 'tpk_';
/** `tpk_` + 32 losowe bajty w base64url (43 znaki). */
export const API_TOKEN_RE = /^tpk_[A-Za-z0-9_-]{43}$/;

/** Nowy token (pokazany użytkownikowi raz; w bazie tylko jego skrót SHA-256). */
export function generateApiToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return API_TOKEN_PREFIX + btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Skrót tokenu w bazie (`api_tokens.token_hash`): SHA-256, szesnastkowo. */
export async function apiTokenHash(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Końcówka tokenu do rozpoznania na liście („…x1Y2”) — jedyna część tokenu, którą zapisujemy jawnie. */
export const apiTokenHint = (token: string): string => `…${token.slice(-4)}`;

/** Token z nagłówka `Authorization: Bearer tpk_…` albo `null` (brak, inny schemat, zły format). */
export function bearerApiToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  return match && API_TOKEN_RE.test(match[1]!) ? match[1]! : null;
}

/** `inbound-api/tokens/create` (użytkownik): etykieta i lista, na której API zakłada zadania. */
export const ApiTokenCreate = z.object({
  label: z.string().trim().min(1, 'Nazwa tokenu nie może być pusta.').max(100, 'Nazwa tokenu: najwyżej 100 znaków.'),
  listId: z.uuid('Wybierz listę.'),
});
export type ApiTokenCreate = z.infer<typeof ApiTokenCreate>;

/** `inbound-api/tokens/revoke`. */
export const ApiTokenRef = z.object({ tokenId: z.uuid() });

/** Token u klienta (tylko do odczytu — pisze Edge Function `inbound-api`; bez skrótu). */
export interface ApiToken {
  id: string;
  label: string;
  listId: string;
  tokenHint: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

/** Wiersz lokalnej bazy → token albo `null` (odwołany / niepełny). */
export function parseApiToken(row: Record<string, unknown>): ApiToken | null {
  if (typeof row.id !== 'string' || typeof row.label !== 'string' || typeof row.list_id !== 'string' || row.deleted_at) return null;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return { id: row.id, label: row.label, listId: row.list_id, tokenHint: text(row.token_hint), createdAt: text(row.created_at), lastUsedAt: text(row.last_used_at) };
}

// ── Klucz zewnętrzny ─────────────────────────────────────────────────────────────────────────

/** `ep:<tripId>:<ref>` — wyjazd i punkt (zadanie) w Expedition Plan. */
const EP_KEY = /^ep:([A-Za-z0-9-]{1,64}):([A-Za-z0-9._~-]{1,128})$/;

export interface ExternalKey {
  key: string;
  app: 'expeditionplan';
  tripId: string;
  ref: string;
}

/** Klucz z adresu (`tasks/<klucz>`, także zakodowany `ep%3A…`) albo `null`. */
export function parseExternalKey(raw: string): ExternalKey | null {
  let key = raw;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const ep = EP_KEY.exec(key);
  return ep ? { key, app: 'expeditionplan', tripId: ep[1]!, ref: ep[2]! } : null;
}

// ── Treść zadania (PUT) ──────────────────────────────────────────────────────────────────────

const STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'cancelled'] as const;

const DateField = z
  .string({ error: 'Data w formacie RRRR-MM-DD, np. „2026-12-12”.' })
  .refine((v) => LocalDate.safeParse(v).success, 'Data w formacie RRRR-MM-DD, np. „2026-12-12”.');

/** Nazwa tagu osobistego jak w Task Plannerze (może mieć spacje, np. tytuł wyjazdu „Maroko 2026”). */
const TagName = z
  .string({ error: 'Tag musi być tekstem.' })
  .trim()
  .min(1, 'Tag nie może być pusty.')
  .max(60, 'Tag: najwyżej 60 znaków.')
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f#]/.test(v), 'Tag bez znaku „#” i znaków sterujących.');

const Url = z
  .string()
  .trim()
  .max(2000, 'Adres jest za długi.')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Adres musi zaczynać się od https:// (bez loginu i hasła).');

/** `source` w treści: wymagane, zgodne z kluczem z adresu (sprawdza `inboundSource`). */
const InboundSourceInput = z.strictObject(
  {
    kind: z.literal('expeditionplan', { error: 'Rodzaj źródła: „expeditionplan”.' }),
    tripId: z.string({ error: 'Brak tripId.' }).min(1, 'Brak tripId.').max(100),
    ref: z.string({ error: 'Brak ref.' }).min(1, 'Brak ref.').max(200),
    url: Url.nullish(),
  },
  { error: (issue) => (issue.code === 'unrecognized_keys' ? `Nieznane pole: ${issue.keys.join(', ')}.` : issue.code === 'invalid_type' ? 'Brak obiektu source.' : undefined) },
);

/**
 * Treść `PUT` (kontrakt `docs/INTEGRACJA_TP.md` w Expedition Plan). Pole nieobecne = aplikacja nim nie zarządza:
 * nie zmienia się i nie trafia do rzutu ostatniej wysyłki; `null` = wyczyść. Wymagane są tylko `title` i `source`.
 */
export const InboundTaskInput = z
  .strictObject(
    {
      title: z.string({ error: 'Brak tytułu.' }).trim().min(1, 'Tytuł nie może być pusty.').max(500, 'Tytuł: najwyżej 500 znaków.'),
      description: z.string({ error: 'Opis musi być tekstem.' }).max(INBOUND_MAX_DESCRIPTION, `Opis: najwyżej ${INBOUND_MAX_DESCRIPTION} znaków.`).nullish(),
      status: z.enum(STATUSES, { error: `Status: jeden z ${STATUSES.join(', ')}.` }).optional(),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)], { error: 'Priorytet: 1 (krytyczny) … 4 (niski).' }).optional(),
      startDate: DateField.nullish(),
      dueDate: DateField.nullish(),
      dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Godzina w formacie GG:MM, np. „09:30”.').nullish(),
      timeZone: z.string({ error: 'Strefa IANA, np. „Europe/Warsaw”.' }).refine((v) => TimeZone.safeParse(v).success, 'Strefa IANA, np. „Europe/Warsaw”.').nullish(),
      tags: z
        .array(TagName, { error: 'Tagi: lista nazw.' })
        .max(INBOUND_MAX_TAGS, `Najwyżej ${INBOUND_MAX_TAGS} tagów.`)
        .nullish(),
      source: InboundSourceInput,
    },
    { error: (issue) => (issue.code === 'unrecognized_keys' ? `Nieznane pole: ${issue.keys.join(', ')}.` : undefined) },
  )
  .refine((t) => t.dueDate || (!t.dueTime && !t.startDate), { message: 'Godzina i początek wymagają terminu (dueDate).', path: ['dueDate'] })
  .refine((t) => !t.startDate || !t.dueDate || t.startDate <= t.dueDate, { message: 'Początek po terminie.', path: ['startDate'] });
export type InboundTaskInput = z.infer<typeof InboundTaskInput>;

/** Szczegół błędu walidacji (`details` w odpowiedzi 400): ścieżka pola i komunikat. */
export interface InboundIssueDetail {
  path: string;
  message: string;
}

/** Błąd walidacji → `{error: „pole: komunikat” pierwszego błędu, details: wszystkie}`. */
export function inboundIssues(error: { issues: readonly { message: string; path: readonly PropertyKey[] }[] }): { error: string; details: InboundIssueDetail[] } {
  const details = error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
  const first = details[0];
  return { error: !first ? 'Niepoprawne dane.' : first.path ? `${first.path}: ${first.message}` : first.message, details };
}

/** Pierwszy błąd walidacji jako zdanie „pole: komunikat”. */
export const inboundIssue = (error: Parameters<typeof inboundIssues>[0]): string => inboundIssues(error).error;

/** Kolumny `tasks`, którymi zarządza API → nazwy pól w API (`applied` / `kept` w odpowiedzi). */
export const INBOUND_FIELDS = {
  title: 'title',
  description_md: 'description',
  status: 'status',
  priority: 'priority',
  start_date: 'startDate',
  due_date: 'dueDate',
  due_time: 'dueTime',
  time_zone: 'timeZone',
} as const;
export type InboundColumn = keyof typeof INBOUND_FIELDS;

/** Pola wysłane w treści (snake_case); brak klucza = aplikacja nim nie zarządza. */
export interface InboundTaskPatch {
  title: string;
  description_md?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  start_date?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  time_zone?: string | null;
}

/** Treść `PUT` → pola dla `upsert_integration_task`, tylko obecne w treści (pusty opis = brak opisu). */
export function inboundTaskRow(input: InboundTaskInput): InboundTaskPatch {
  const row: InboundTaskPatch = { title: input.title };
  if (input.description !== undefined) row.description_md = input.description?.trim() ? input.description : null;
  if (input.status !== undefined) row.status = input.status;
  if (input.priority !== undefined) row.priority = input.priority as Priority;
  if (input.startDate !== undefined) row.start_date = input.startDate;
  if (input.dueDate !== undefined) row.due_date = input.dueDate;
  if (input.dueTime !== undefined) row.due_time = input.dueTime;
  if (input.timeZone !== undefined) row.time_zone = input.timeZone;
  return row;
}

/** `tasks.source` zadania z API albo `null`, gdy `source` z treści nie zgadza się z kluczem z adresu. */
export function inboundSource(key: ExternalKey, source: InboundTaskInput['source']): TaskSource | null {
  if (source.kind !== 'expeditionplan' || source.tripId !== key.tripId || source.ref !== key.ref) return null;
  return { kind: 'expeditionplan', tripId: key.tripId, ref: key.ref, ...(source.url ? { url: source.url } : {}) };
}

/** Tag do zapisu: nazwa z treści, id tagu (istniejący o tej nazwie albo `tagId`) i id `task_tags`. */
export interface InboundTag {
  name: string;
  tagId: string;
  id: string;
}

/**
 * Nazwy tagów → tagi konta: istniejący tag o tej nazwie (bez wielkości liter) albo nowy z id `tagId`
 * (serwer utworzy go przy zapisie). Powtórzone nazwy liczą się raz.
 */
export function inboundTags(userId: string, taskId: string, names: readonly string[], existing: readonly { id: string; name: string }[]): InboundTag[] {
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t.id]));
  const seen = new Set<string>();
  const out: InboundTag[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const id = byName.get(lower) ?? tagId(userId, name);
    out.push({ name, tagId: id, id: taskTagId(taskId, id) });
  }
  return out;
}

// ── Odpowiedź ────────────────────────────────────────────────────────────────────────────────

/** Wynik RPC `upsert_integration_task`: nowe, zmienione, bez zmian, w koszu (nic się nie zmienia), usunięte na stałe. */
export const INBOUND_RESULTS = ['created', 'updated', 'unchanged', 'trashed', 'deleted'] as const;
export type InboundResult = (typeof INBOUND_RESULTS)[number];

/** Odpowiedź `PUT` i `GET tasks/<klucz>` (kontrakt EP: `PlannerTaskResult`). */
export interface InboundTaskResult {
  /** Id zadania w Task Plannerze. */
  id: string;
  key: string;
  created: boolean;
  /** Bieżący status w Task Plannerze (także zmieniony przez użytkownika). */
  status: TaskStatus;
  /** Zadanie w koszu — zapisy go nie zmieniają ani nie przywracają. */
  deleted: boolean;
  /** Link do zadania w aplikacji webowej. */
  url: string;
  /** Pola zmienione tym zapisem (nazwy API, `tags` = tagi). */
  applied: string[];
  /** Pola, które aplikacja zmieniła, ale użytkownik zmienił je wcześniej w Task Plannerze — zostały jego wartości. */
  kept: string[];
}

const apiField = (column: string): string => (INBOUND_FIELDS as Record<string, string>)[column] ?? column;

/** Wynik RPC → `result` oraz `applied` / `kept` w nazwach API. */
export function inboundUpsertOutcome(raw: unknown): { result: InboundResult; applied: string[]; kept: string[] } | null {
  const r = z
    .object({ status: z.enum(INBOUND_RESULTS), applied: z.array(z.string()).catch([]), kept: z.array(z.string()).catch([]) })
    .safeParse(raw);
  if (!r.success) return null;
  return { result: r.data.status, applied: r.data.applied.map(apiField), kept: r.data.kept.map(apiField) };
}

/** Rzut `plugin_task_context` → odpowiedź API albo `null` (nieczytelny). `GET` = bez `created`, `applied`, `kept`. */
export function inboundTaskResult(
  key: string,
  raw: unknown,
  appUrl: string,
  change: { created?: boolean; applied?: readonly string[]; kept?: readonly string[] } = {},
): InboundTaskResult | null {
  const parsed = PluginTaskData.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  return {
    id: t.id,
    key,
    created: change.created ?? false,
    status: t.status,
    deleted: t.deletedAt !== null,
    url: taskUrl(appUrl, t.id),
    applied: [...(change.applied ?? [])],
    kept: [...(change.kept ?? [])],
  };
}
