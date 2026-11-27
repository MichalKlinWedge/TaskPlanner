/**
 * Ładunek wysyłki pluginu (SPECYFIKACJA M21): rzut zadania z serwera (`plugin_task_context`), identyfikator
 * wysyłki (UUIDv5 = `Idempotency-Key` — ta sama wysyłka zawsze ma ten sam id) i harmonogram ponowień.
 * Czysty TS — liczy to Edge Function `plugins`, a podgląd reguły pokazuje to samo w aplikacji.
 */
import { z } from 'zod';

import { uuidv5 } from '../ids.ts';
import { TaskSource } from '../schemas/model.ts';
import { LocalDate, LocalTime, Priority, TaskStatus } from '../schemas/primitives.ts';
import type { PluginEvent } from './events.ts';
import { templateValues, type TemplateField } from './template.ts';

/** Rzut zadania do ładunku — kształt zwracany przez `plugin_task_context` w bazie. */
export const PluginTaskData = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatus,
  priority: Priority,
  startDate: LocalDate.nullable(),
  dueDate: LocalDate.nullable(),
  dueTime: LocalTime.nullable(),
  durationMin: z.number().int().nullable(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  listId: z.uuid(),
  list: z.string(),
  listKind: z.enum(['inbox', 'project', 'list']),
  workspaceId: z.uuid(),
  workspace: z.string().nullable(),
  tags: z.array(z.string()),
  assignee: z.string().nullable(),
  /** Zadanie z integracji (e-mail, kalendarz) — reguły zdarzeniowe domyślnie je pomijają. */
  fromIntegration: z.boolean(),
  /**
   * Skąd zadanie przyszło (`tasks.source`), np. `{kind:'expeditionplan', tripId, ref, url}` z przychodzącego
   * API — webhook `task.completed` niesie wyjazd i zadanie po stronie EP. Nieczytelne / brak = `null`.
   */
  source: TaskSource.nullable().catch(null),
});
export type PluginTaskData = z.infer<typeof PluginTaskData>;

/** Najdłuższy opis w ładunku (znaki); dłuższy ucięty z „…”. */
export const MAX_PAYLOAD_DESCRIPTION = 10_000;

export interface PluginPayload {
  /** Id wysyłki — też w nagłówku `Idempotency-Key`. */
  id: string;
  /** Główne zdarzenie (pierwsze z `events`). */
  event: PluginEvent;
  /** Wszystkie zdarzenia połączone w tę wysyłkę. */
  events: PluginEvent[];
  /** Chwila wysłania (ISO). */
  sentAt: string;
  rule: { id: string; name: string } | null;
  task: {
    id: string;
    title: string;
    description: string | null;
    status: TaskStatus;
    priority: Priority;
    startDate: string | null;
    dueDate: string | null;
    dueTime: string | null;
    durationMin: number | null;
    completedAt: string | null;
    list: { id: string; name: string };
    workspace: { id: string; name: string | null };
    tags: string[];
    assignee: string | null;
    url: string;
    /** `tasks.source` — m.in. wyjazd i zadanie EP (`tripId`, `ref`) przy zadaniu z przychodzącego API. */
    source: TaskSource | null;
  };
  /** Wszystkie pola szablonów (`TEMPLATE_FIELDS`) z wartościami jak w `{{…}}` — niezależnie od treści reguły; brak = pusty napis. */
  fields: Record<TemplateField, string>;
  /** Treść z szablonu reguły (jeśli jest). */
  message?: string;
  /** Ukończone wystąpienie serii (`task.completed` z `task_completions`). */
  occurrence?: string;
  /** Nowy komentarz (`task.commented`). */
  comment?: { id: string; body: string };
}

/** Link do zadania w aplikacji webowej (`/?task=<id>` otwiera panel zadania). */
export const taskUrl = (appUrl: string, taskId: string): string => `${appUrl.replace(/\/+$/, '')}/?task=${taskId}`;

const clip = (text: string | null, max: number) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function pluginPayload(input: {
  id: string;
  events: readonly PluginEvent[];
  sentAt: string;
  rule: { id: string; name: string } | null;
  task: PluginTaskData;
  appUrl: string;
  message?: string;
  occurrence?: string;
  comment?: { id: string; body: string };
}): PluginPayload {
  const task = { ...input.task, description: clip(input.task.description, MAX_PAYLOAD_DESCRIPTION) };
  const event = input.events[0] ?? 'task.sent';
  const url = taskUrl(input.appUrl, task.id);
  return {
    id: input.id,
    event,
    events: [...input.events],
    sentAt: input.sentAt,
    rule: input.rule,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      startDate: task.startDate,
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      durationMin: task.durationMin,
      completedAt: task.completedAt,
      list: { id: task.listId, name: task.list },
      workspace: { id: task.workspaceId, name: task.workspace },
      tags: [...task.tags],
      assignee: task.assignee,
      url,
      source: task.source ?? null,
    },
    fields: templateValues(task, { event, url }),
    ...(input.message !== undefined && input.message !== '' && { message: input.message }),
    ...(input.occurrence && { occurrence: input.occurrence }),
    ...(input.comment && { comment: { id: input.comment.id, body: clip(input.comment.body, MAX_PAYLOAD_DESCRIPTION)! } }),
  };
}

/** Przykładowe zadanie do „Wyślij próbne” i podglądu reguły bez wybranego zadania. */
export const SAMPLE_TASK: PluginTaskData = {
  id: '00000000-0000-4000-8000-000000000000',
  title: 'Przykładowe zadanie z Task Plannera',
  description: 'To jest wysyłka próbna — sprawdź, czy dotarła i czy podpis się zgadza.',
  status: 'todo',
  priority: 2,
  startDate: null,
  dueDate: '2026-11-24',
  dueTime: '09:30',
  durationMin: 30,
  completedAt: null,
  deletedAt: null,
  createdAt: '2026-11-23T08:00:00.000Z',
  listId: '00000000-0000-4000-8000-000000000001',
  list: 'Inbox',
  listKind: 'inbox',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  workspace: 'Praca',
  tags: ['zgłoś'],
  assignee: null,
  fromIntegration: false,
  source: null,
};

// ── Wysyłki ──────────────────────────────────────────────────────────────────────────────────

/** Id wysyłki: reguła + klucz zdarzenia (prośba, zmiana zadania, termin reguły czasowej). */
export const deliveryId = (ruleId: string, key: string): string => uuidv5(`plugin-delivery:${ruleId}:${key}`);
/** Id wysyłki z „Wyślij do…” — powtórzone przetworzenie tej samej prośby to ta sama wysyłka. */
export const requestDeliveryId = (ruleId: string, requestId: string): string => deliveryId(ruleId, `request:${requestId}`);

/** Odstępy ponowień po kolejnych nieudanych próbach: 1 min, 5 min, 30 min, 2 h, 12 h; potem `dead`. */
export const RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 43_200] as const;
/** Najwięcej prób jednej wysyłki (pierwsza + ponowienia). */
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_SEC.length + 1;
/** Najdłużej czekamy na wskazanie odbiorcy (`Retry-After`). */
const MAX_RETRY_AFTER_SEC = 43_200;

/**
 * Za ile sekund ponowić wysyłkę po `attempts` nieudanych próbach (licząc tę, która właśnie się nie udała),
 * albo `null` — koniec prób. `Retry-After` odbiorcy wydłuża (nigdy nie skraca) odstęp.
 */
export function retryDelaySec(attempts: number, retryAfterSec?: number): number | null {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return null;
  const base = RETRY_DELAYS_SEC[Math.max(0, attempts - 1)]!;
  return retryAfterSec && retryAfterSec > base ? Math.min(retryAfterSec, MAX_RETRY_AFTER_SEC) : base;
}
