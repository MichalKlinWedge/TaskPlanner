/**
 * Dziennik błędów aplikacji (Etap 13, D20 — własny w Supabase zamiast Sentry). Klient zamienia złapany
 * błąd na `ClientErrorReport` (treść, stos, odcisk), dokłada go do kolejki (`queueError` — ten sam
 * odcisk tylko zwiększa licznik) i wysyła paczkami do `report_client_errors`. Odcisk nie zależy od
 * identyfikatorów, liczb ani nazw paczek JS po wdrożeniu, więc powtarzający się błąd to jeden wiersz.
 * Błędy sieci (offline, przerwane zapytanie) nie są błędami aplikacji — `isTransientError`.
 */
import { z } from 'zod';

import { uuidv5 } from './ids.ts';
import { Instant } from './schemas/model.ts';

export const ERROR_KINDS = ['error', 'unhandled', 'render', 'sync', 'rejected'] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];
export type ErrorPlatform = 'web' | 'android';

/** Pozycja kolejki = element `p_items` w `report_client_errors` (limity jak w migracji). */
export const ClientErrorReport = z.object({
  fingerprint: z.string().min(1).max(64),
  kind: z.enum(ERROR_KINDS),
  platform: z.enum(['web', 'android']),
  appVersion: z.string().max(40).optional(),
  message: z.string().min(1).max(1000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(300).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  count: z.number().int().min(1),
  firstAt: Instant,
  lastAt: Instant,
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

export const MAX_QUEUED_ERRORS = 50;
const MAX_STACK_LINES = 30;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Treść i stos z dowolnej rzuconej wartości (nie zawsze `Error`). */
export function describeError(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    const name = value.name && value.name !== 'Error' && !value.message.startsWith(value.name) ? `${value.name}: ` : '';
    return { message: `${name}${value.message || '(bez treści)'}`, ...(value.stack ? { stack: value.stack } : {}) };
  }
  if (typeof value === 'string') return { message: value || '(pusty napis)' };
  if (value && typeof value === 'object') {
    const v = value as { message?: unknown; code?: unknown; stack?: unknown };
    if (typeof v.message === 'string' && v.message) {
      const code = typeof v.code === 'string' && v.code ? `${v.code}: ` : '';
      return { message: `${code}${v.message}`, ...(typeof v.stack === 'string' ? { stack: v.stack } : {}) };
    }
    try {
      return { message: JSON.stringify(value) };
    } catch {
      return { message: Object.prototype.toString.call(value) };
    }
  }
  return { message: String(value) };
}

/** Błąd sieci, nie aplikacji: offline, przerwane zapytanie, przekroczony czas. */
export function isTransientError(value: unknown): boolean {
  const name = value && typeof value === 'object' && 'name' in value ? String((value as { name: unknown }).name) : '';
  if (name === 'AbortError' || name === 'AuthRetryableFetchError') return true;
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_network|err_internet_disconnected|the network connection was lost|timed? ?out/i.test(
    describeError(value).message,
  );
}

/** Treść bez szczegółów zmiennych między wystąpieniami: id, liczby, długie ciągi szesnastkowe. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Pierwsza ramka stosu: nazwa funkcji albo plik bez skrótu paczki i bez wiersza/kolumny. */
export function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  for (const line of stack.split('\n')) {
    const v8 = /^\s*at (?:(.+?) \()?(.+?)(?::\d+){0,2}\)?\s*$/.exec(line);
    const gecko = /^\s*([^@\s]*)@(.+?)(?::\d+){0,2}\s*$/.exec(line);
    const match = v8 ?? gecko;
    if (!match) continue;
    const fn = match[1]?.trim();
    if (fn && fn !== '<anonymous>') return fn;
    const file = (match[2] ?? '').split(/[?#]/)[0]!.split('/').pop() ?? '';
    return file.replace(/[0-9a-f]{6,}/gi, '*').replace(/\d+/g, '<n>');
  }
  return '';
}

export const errorFingerprint = (kind: ErrorKind, message: string, stack?: string) =>
  uuidv5(`error:${kind}:${normalizeMessage(message)}:${topFrame(stack)}`).replace(/-/g, '');

export interface ErrorReportOptions {
  platform: ErrorPlatform;
  now: Date;
  appVersion?: string;
  url?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
}

export function errorReport(kind: ErrorKind, value: unknown, options: ErrorReportOptions): ClientErrorReport {
  const { message, stack } = describeError(value);
  const at = options.now.toISOString();
  const trimmedStack = stack ? clip(stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'), 8000) : undefined;
  return {
    fingerprint: errorFingerprint(kind, message, stack),
    kind,
    platform: options.platform,
    message: clip(message, 1000),
    count: 1,
    firstAt: at,
    lastAt: at,
    ...(trimmedStack ? { stack: trimmedStack } : {}),
    ...(options.appVersion ? { appVersion: clip(options.appVersion, 40) } : {}),
    ...(options.url ? { url: clip(options.url, 500) } : {}),
    ...(options.userAgent ? { userAgent: clip(options.userAgent, 300) } : {}),
    ...(options.context && Object.keys(options.context).length ? { context: options.context } : {}),
  };
}

/** Dokłada błąd do kolejki: ten sam odcisk → licznik i ostatnia chwila; najwyżej `max` pozycji (najstarsze odpadają). */
export function queueError(queue: readonly ClientErrorReport[], report: ClientErrorReport, max = MAX_QUEUED_ERRORS): ClientErrorReport[] {
  const index = queue.findIndex((q) => q.fingerprint === report.fingerprint);
  if (index >= 0) {
    const prev = queue[index]!;
    const merged: ClientErrorReport = {
      ...prev,
      ...report,
      count: Math.min(prev.count + report.count, 10_000),
      firstAt: prev.firstAt < report.firstAt ? prev.firstAt : report.firstAt,
      lastAt: prev.lastAt > report.lastAt ? prev.lastAt : report.lastAt,
    };
    return [...queue.slice(0, index), merged, ...queue.slice(index + 1)];
  }
  return [...queue, report].slice(-max);
}

/** Po wysyłce: z kolejki znika to, co wysłano; błędy dopisane w trakcie (większy licznik) zostają z resztą licznika. */
export function settleQueue(queue: readonly ClientErrorReport[], sent: readonly ClientErrorReport[]): ClientErrorReport[] {
  const sentCount = new Map(sent.map((s) => [s.fingerprint, s.count]));
  return queue.flatMap((q) => {
    const done = sentCount.get(q.fingerprint);
    if (done === undefined) return [q];
    return q.count > done ? [{ ...q, count: q.count - done }] : [];
  });
}

/** Kolejka z pamięci przeglądarki / telefonu — uszkodzone pozycje odpadają. */
export function parseErrorQueue(raw: unknown): ClientErrorReport[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = ClientErrorReport.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}
