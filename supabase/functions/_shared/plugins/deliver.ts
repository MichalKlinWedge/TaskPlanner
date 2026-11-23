/**
 * Dostarczanie wysyłek pluginów (SPECYFIKACJA M21) — klient `service_role`, bez Deno (testy w Node).
 *
 * Jeden przebieg (`runDeliveries`, pod dzierżawą `plugin_runs` — flush, cron i „Ponów” nie pracują równolegle):
 *   1. kolejka `plugin_outbox` → wysyłki `plugin_deliveries` z deterministycznym id (prośba „Wyślij do…” →
 *      `requestDeliveryId`; powtórne przetworzenie tego samego wiersza nic nie podwaja — `on conflict do nothing`),
 *      zmiana zadania (I2) → reguły zdarzeniowe osób, które je widzą (`plugin_event_rules`): nowa wysyłka
 *      z opóźnieniem reguły albo dołączenie do otwartego okna tej samej reguły i zadania (`core/plugins/dispatch.ts`),
 *   2. należne wysyłki (`claim_plugin_deliveries`: limit na połączenie, przerwane wracają po 5 min) →
 *      sprawdzenie na **bieżącym** stanie: reguła, połączenie aktywne, dostęp właściciela reguły do zadania,
 *      zadanie nie w koszu, zdarzenia policzone od nowa (cofnięte w oknie = pominięte) → ładunek → `deliver()`
 *      pluginu → wynik: wysłane / ponowienie / błąd / połączenie wyłączone,
 *   3. okno kończy się za chwilę (≤ 45 s, w budżecie) — przebieg czeka i wysyła sam (cron co minutę to zabezpieczenie).
 * Gwarancja „co najmniej raz”: id wysyłki jako `Idempotency-Key` u odbiorcy.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { localDateAt } from '../../../../packages/core/src/dates.ts';
import { pluginDef, type PluginDef } from '../../../../packages/core/src/plugins/catalog.ts';
import {
  EventContext,
  eventContext,
  eventDeliveryId,
  mergeEventContext,
  outboxEvents,
  parseOutboxRow,
  recheckEvents,
  ruleDelaySec,
  ruleEvents,
} from '../../../../packages/core/src/plugins/dispatch.ts';
import { PLUGIN_EVENTS, PluginTaskState, type PluginEvent } from '../../../../packages/core/src/plugins/events.ts';
import { PluginTaskData, pluginPayload, requestDeliveryId, retryDelaySec, taskUrl } from '../../../../packages/core/src/plugins/payload.ts';
import { parsePluginRule, type PluginRule } from '../../../../packages/core/src/plugins/rules.ts';
import { renderActionFields } from '../../../../packages/core/src/plugins/template.ts';
import type { LocalDate } from '../../../../packages/core/src/schemas/primitives.ts';
import type { DeliveryResult, NetDeps, PluginRuntime } from './types.ts';
import { gitlab } from './gitlab.ts';
import { webhook } from './webhook.ts';

export const RUNTIMES: Record<string, PluginRuntime> = { webhook, gitlab };

/** Najwięcej wysłanych na połączenie w ciągu minuty (nadmiar czeka na następny przebieg). */
export const PER_MINUTE = 60;
const LEASE = 'deliver';
const LEASE_TTL_SEC = 170;
/** Po tylu ms przebieg nie bierze nowych wysyłek (limit funkcji 150 s). */
const BUDGET_MS = 100_000;
const CLAIM_BATCH = 20;
const PARALLEL = 4;
/** Najdłużej, ile przebieg czeka na koniec okna opóźnienia (dłuższe — cron). */
const WAIT_MAX_MS = 45_000;
/** Co ile przy czekaniu sprawdzić, czy w kolejce nie ma nowej pracy („Wyślij do…” bez opóźnienia). */
const WAIT_STEP_MS = 2_000;

export interface EngineDeps {
  db: SupabaseClient;
  net: NetDeps;
  /** Adres aplikacji webowej (`{{url}}`, `task.url`). */
  appUrl: string;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Czekanie (testy podmieniają). */
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryRow {
  id: string;
  user_id: string;
  rule_id: string | null;
  connection_id: string | null;
  task_id: string | null;
  source: 'manual' | 'event' | 'schedule';
  events: string[];
  status: string;
  attempts: number;
  context?: unknown;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  plugin: string;
  label: string;
  config: Record<string, unknown>;
  status: string;
  deleted_at: string | null;
}

interface RuleRow {
  id: string;
  scope_id: string;
  name: string;
  connection_id: string;
  enabled: boolean;
  trigger: unknown;
  action: Record<string, unknown>;
  options: unknown;
  sort_key: string;
  deleted_at: string | null;
}

const RULE_COLUMNS = 'id, scope_id, name, connection_id, enabled, trigger, action, options, sort_key, deleted_at';

interface OutboxRow {
  id: number;
  scope_id: string;
  table_name: string;
  row_id: string;
  task_id: string | null;
  before: unknown;
  after: Record<string, unknown> | null;
  extra: unknown;
  origin: string;
  created_at: string;
}

export interface RunSummary {
  locked: boolean;
  queued: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

const check = <T>({ data, error }: { data: T; error: { message: string } | null }, what: string): T => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

// ── Kolejka → wysyłki ────────────────────────────────────────────────────────────────────────

/** „Dziś” właściciela reguły (strefa z ustawień profilu; brak albo zła = UTC). */
function ownerToday(deps: EngineDeps): (userId: string) => Promise<LocalDate> {
  const zones = new Map<string, string>();
  return async (userId) => {
    if (!zones.has(userId)) {
      const { data } = await deps.db.from('profiles').select('settings').eq('id', userId).maybeSingle();
      const zone = (data?.settings as { timeZone?: unknown } | null)?.timeZone;
      zones.set(userId, typeof zone === 'string' ? zone : 'UTC');
    }
    const now = (deps.now ?? (() => new Date()))();
    try {
      return localDateAt(now, zones.get(userId));
    } catch {
      return localDateAt(now, 'UTC');
    }
  };
}

const union = (a: readonly string[], b: readonly string[]): PluginEvent[] => PLUGIN_EVENTS.filter((e) => a.includes(e) || b.includes(e));

/** Prośby „Wyślij do…” z jednej porcji kolejki → wysyłki (od razu). */
async function queueRequests(deps: EngineDeps, rows: OutboxRow[], now: string): Promise<number> {
  const { db } = deps;
  const requests = rows.filter((r) => r.table_name === 'plugin_requests' && r.after);
  if (!requests.length) return 0;
  const ruleIds = [...new Set(requests.map((r) => String(r.after?.rule_id ?? '')).filter(Boolean))];
  const rules = new Map<string, RuleRow>();
  for (const r of check(await db.from('plugin_rules').select(RULE_COLUMNS).in('id', ruleIds), 'plugin_rules') as RuleRow[]) rules.set(r.id, r);
  const deliveries = requests.map((row) => {
    const ruleId = String(row.after!.rule_id);
    const rule = rules.get(ruleId);
    const problem = !rule || rule.deleted_at || rule.scope_id !== row.scope_id ? 'Reguła usunięta' : !rule.enabled ? 'Reguła wyłączona' : null;
    return {
      id: requestDeliveryId(ruleId, row.row_id),
      user_id: row.scope_id,
      rule_id: ruleId,
      connection_id: rule?.connection_id ?? null,
      task_id: row.task_id,
      source: 'manual',
      events: ['task.sent'],
      status: problem ? 'skipped' : 'pending',
      error: problem,
      next_attempt_at: now,
    };
  });
  const inserted = check(await db.from('plugin_deliveries').upsert(deliveries, { onConflict: 'id', ignoreDuplicates: true }).select('id'), 'plugin_deliveries') as { id: string }[] | null;
  return inserted?.length ?? 0;
}

interface OpenWindow {
  id: string;
  events: PluginEvent[];
  context: EventContext;
}

interface OwnedRule {
  rule: PluginRule;
  owner: string;
}

/**
 * Zmiany zadań z jednej porcji kolejki (po kolei) → wysyłki reguł zdarzeniowych: pierwsze pasujące zdarzenie
 * otwiera okno (wysyłka za `delaySec`), kolejne tej samej reguły i zadania dołączają do niego. Powtórne
 * przetworzenie wiersza (przerwany przebieg) trafia w to samo okno albo ten sam id — nic się nie dubluje.
 */
async function queueEvents(deps: EngineDeps, rows: OutboxRow[]): Promise<number> {
  const { db } = deps;
  const today = ownerToday(deps);
  const rulesByTask = new Map<string, OwnedRule[]>();
  const windows = new Map<string, OpenWindow | null>();
  let queued = 0;
  for (const raw of rows) {
    if (!raw.task_id) continue;
    const row = parseOutboxRow(raw);
    if (!row) continue;
    const events = outboxEvents(row);
    if (!events.length) continue;
    if (!rulesByTask.has(raw.task_id)) {
      const found = (check(await db.rpc('plugin_event_rules', { p_task: raw.task_id }), 'plugin_event_rules') as RuleRow[] | null) ?? [];
      rulesByTask.set(
        raw.task_id,
        found.flatMap((r) => {
          const rule = parsePluginRule(r as unknown as Record<string, unknown>);
          return rule ? [{ rule, owner: r.scope_id }] : [];
        }),
      );
    }
    for (const { rule, owner } of rulesByTask.get(raw.task_id)!) {
      const matched = ruleEvents(rule, events, raw.task_id, row.after, { today: await today(owner), fromIntegration: row.origin === 'integration' });
      if (!matched.length) continue;
      const key = `${rule.id}:${raw.task_id}`;
      if (!windows.has(key)) {
        const { data } = await db
          .from('plugin_deliveries')
          .select('id, events, context')
          .eq('rule_id', rule.id)
          .eq('task_id', raw.task_id)
          .eq('source', 'event')
          .eq('status', 'pending')
          .eq('attempts', 0)
          .order('created_at')
          .limit(1)
          .maybeSingle();
        const context = data ? EventContext.safeParse(data.context ?? {}) : null;
        windows.set(key, data && context?.success ? { id: data.id as string, events: union((data.events as string[]) ?? [], []), context: context.data } : null);
      }
      const open = windows.get(key);
      if (open) {
        const next: OpenWindow = { id: open.id, events: union(open.events, matched), context: mergeEventContext(open.context, row) };
        check(
          await db.from('plugin_deliveries').update({ events: next.events, context: next.context, updated_at: new Date().toISOString() }).eq('id', open.id).eq('status', 'pending').eq('attempts', 0),
          'plugin_deliveries window',
        );
        windows.set(key, next);
        continue;
      }
      const created: OpenWindow = { id: eventDeliveryId(rule.id, raw.task_id, raw.id), events: matched, context: eventContext(row) };
      const inserted = check(
        await db
          .from('plugin_deliveries')
          .upsert(
            {
              id: created.id,
              user_id: owner,
              rule_id: rule.id,
              connection_id: rule.connectionId,
              task_id: raw.task_id,
              source: 'event',
              events: created.events,
              context: created.context,
              status: 'pending',
              next_attempt_at: new Date(Date.parse(raw.created_at) + ruleDelaySec(rule) * 1000).toISOString(),
            },
            { onConflict: 'id', ignoreDuplicates: true },
          )
          .select('id'),
        'plugin_deliveries event',
      ) as { id: string }[] | null;
      queued += inserted?.length ?? 0;
      windows.set(key, created);
    }
  }
  return queued;
}

/** Nieprzetworzone wiersze `plugin_outbox` → `plugin_deliveries`; zwraca liczbę nowych wysyłek. */
export async function processOutbox(deps: EngineDeps): Promise<number> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let queued = 0;
  for (let round = 0; round < 10; round++) {
    const rows = check(
      await db.from('plugin_outbox').select('id, scope_id, table_name, row_id, task_id, before, after, extra, origin, created_at').is('processed_at', null).order('id').limit(200),
      'plugin_outbox',
    ) as OutboxRow[];
    if (!rows.length) break;
    queued += await queueRequests(deps, rows, now);
    queued += await queueEvents(deps, rows);
    check(await db.from('plugin_outbox').update({ processed_at: now }).in('id', rows.map((r) => r.id)), 'plugin_outbox processed');
    if (rows.length < 200) break;
  }
  return queued;
}

// ── Jedna wysyłka ────────────────────────────────────────────────────────────────────────────

type Outcome = 'sent' | 'retried' | 'failed' | 'skipped';

async function finish(deps: EngineDeps, id: string, patch: Record<string, unknown>) {
  check(await deps.db.from('plugin_deliveries').update({ ...patch, updated_at: (deps.now ?? (() => new Date()))().toISOString() }).eq('id', id), 'plugin_deliveries update');
}

const skip = async (deps: EngineDeps, d: DeliveryRow, error: string): Promise<Outcome> => {
  await finish(deps, d.id, { status: 'skipped', error });
  return 'skipped';
};

interface EventCheck {
  events: PluginEvent[];
  occurrence?: string;
  comment?: { id: string; body: string };
}

/**
 * Wysyłka zdarzeniowa tuż przed wysłaniem: zdarzenia od stanu z początku okna do bieżącego (+ ukończenia
 * wystąpień i komentarze, które nadal istnieją), reguła i jej filtr na bieżącym stanie. `string` = powód pominięcia.
 */
async function recheck(deps: EngineDeps, d: DeliveryRow, rule: PluginRule): Promise<EventCheck | string> {
  const { db } = deps;
  const context = EventContext.safeParse(d.context ?? {});
  if (!context.success) return 'Nieczytelna wysyłka';
  const state = PluginTaskState.safeParse(check(await db.rpc('plugin_task_state_now', { p_task: d.task_id }), 'plugin_task_state_now'));
  const current = state.success ? state.data : null;
  const completionIds = context.data.completions.map((c) => c.id);
  const commentIds = context.data.comments;
  const completions = completionIds.length
    ? ((check(await db.from('task_completions').select('id, occurrence_date').in('id', completionIds).is('deleted_at', null).eq('kind', 'done'), 'task_completions') as { id: string; occurrence_date: string }[] | null) ?? [])
    : [];
  const comments = commentIds.length
    ? ((check(await db.from('task_comments').select('id, body, posted_at').in('id', commentIds).is('deleted_at', null).order('posted_at'), 'task_comments') as { id: string; body: string }[] | null) ?? [])
    : [];
  const events = recheckEvents(context.data, current, { completions: new Set(completions.map((c) => c.id)), comments: new Set(comments.map((c) => c.id)) });
  if (!events.length) return 'Zmiana cofnięta przed wysyłką';
  const matched = ruleEvents(rule, events, d.task_id!, current, { today: await ownerToday(deps)(d.user_id) });
  if (!matched.length) return 'Zadanie już nie pasuje do reguły';
  const last = completions.at(-1);
  const comment = comments.at(-1);
  return {
    events: matched,
    ...(matched.includes('task.completed') && last && { occurrence: last.occurrence_date }),
    ...(matched.includes('task.commented') && comment && { comment: { id: comment.id, body: comment.body } }),
  };
}

/** Wynik pluginu → stan wysyłki (i połączenia przy 401 / 403 / 410). */
async function settle(deps: EngineDeps, d: DeliveryRow, result: DeliveryResult, extra: Record<string, unknown>, connectionId: string | null): Promise<Outcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (result.ok && result.skipped) {
    await finish(deps, d.id, { ...extra, status: 'skipped', error: result.skipped, external_id: result.externalId ?? null, external_url: result.externalUrl ?? null });
    return 'skipped';
  }
  if (result.ok) {
    await finish(deps, d.id, { ...extra, status: 'sent', sent_at: now.toISOString(), error: null, http_status: result.httpStatus ?? null, external_id: result.externalId ?? null, external_url: result.externalUrl ?? null });
    if (connectionId) await deps.db.from('plugin_connections').update({ last_used_at: now.toISOString() }).eq('id', connectionId);
    return 'sent';
  }
  const base = { ...extra, error: result.error.slice(0, 1000), http_status: result.httpStatus ?? null };
  if (result.disable && connectionId) {
    await finish(deps, d.id, { ...base, status: 'failed' });
    await deps.db.from('plugin_connections').update({ status: 'error', last_error: `${result.error.slice(0, 500)} — połączenie wyłączone` }).eq('id', connectionId).eq('status', 'active');
    return 'failed';
  }
  if (result.retryable) {
    const delay = retryDelaySec(d.attempts, result.retryAfterSec);
    if (delay === null) {
      await finish(deps, d.id, { ...base, status: 'dead' });
      return 'failed';
    }
    await finish(deps, d.id, { ...base, status: 'pending', next_attempt_at: new Date(now.getTime() + delay * 1000).toISOString() });
    return 'retried';
  }
  await finish(deps, d.id, { ...base, status: 'failed' });
  return 'failed';
}

/** Wysyłka zajęta przez `claim_plugin_deliveries` (stan `sending`, `attempts` już policzone). */
export async function deliverOne(deps: EngineDeps, d: DeliveryRow): Promise<Outcome> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  try {
    if (!d.rule_id || !d.task_id || !d.connection_id) return await skip(deps, d, 'Niepełna wysyłka');
    const rule = check(await db.from('plugin_rules').select(RULE_COLUMNS).eq('id', d.rule_id).maybeSingle(), 'plugin_rules') as RuleRow | null;
    if (!rule || rule.deleted_at) return await skip(deps, d, 'Reguła usunięta');
    let event: EventCheck | null = null;
    let options: PluginRule['options'] = {};
    if (d.source === 'event') {
      const parsed = parsePluginRule(rule as unknown as Record<string, unknown>);
      if (!parsed || !parsed.enabled || parsed.trigger.kind !== 'event') return await skip(deps, d, 'Reguła wyłączona albo zmieniona');
      const result = await recheck(deps, d, parsed);
      if (typeof result === 'string') return await skip(deps, d, result);
      event = result;
      options = parsed.options;
    }
    const connection = check(await db.from('plugin_connections').select('id, user_id, plugin, label, config, status, deleted_at').eq('id', d.connection_id).maybeSingle(), 'plugin_connections') as ConnectionRow | null;
    if (!connection || connection.deleted_at || connection.user_id !== d.user_id) return await skip(deps, d, 'Połączenie usunięte');
    if (connection.status !== 'active') return await skip(deps, d, `Połączenie „${connection.label}” jest wyłączone`);
    const def: PluginDef | null = pluginDef(connection.plugin);
    const runtime = RUNTIMES[connection.plugin];
    if (!def || !runtime) return await settle(deps, d, { ok: false, retryable: false, error: `Nieznany plugin ${connection.plugin}` }, {}, null);

    const raw = check(await db.rpc('plugin_task_context', { p_task: d.task_id, p_user: d.user_id }), 'plugin_task_context');
    if (!raw) return await skip(deps, d, 'Brak dostępu do zadania');
    const task = PluginTaskData.safeParse(raw);
    if (!task.success) return await settle(deps, d, { ok: false, retryable: false, error: 'Nieczytelne zadanie' }, {}, null);
    if (task.data.deletedAt && !event?.events.includes('task.deleted')) return await skip(deps, d, 'Zadanie w koszu');
    if (event && task.data.fromIntegration && !options.includeIntegrations) return await skip(deps, d, 'Zadanie z integracji (włącz w regule „także zadania z integracji”)');

    const config = def.configSchema.safeParse(connection.config);
    if (!config.success) return await settle(deps, d, { ok: false, retryable: false, error: 'Niepoprawna konfiguracja połączenia' }, {}, null);
    const secretText = check(await db.rpc('plugin_secret_get', { p_connection: connection.id }), 'plugin_secret_get') as string | null;
    const secrets = secretText ? (JSON.parse(secretText) as Record<string, string>) : null;
    if (!secrets) return await settle(deps, d, { ok: false, retryable: false, error: 'Brak sekretu połączenia — dodaj połączenie ponownie' }, {}, null);

    const action = def.actionSchema.safeParse(rule.action ?? {});
    const events = event?.events ?? ((d.events.length ? d.events : ['task.sent']) as PluginEvent[]);
    const url = taskUrl(deps.appUrl, task.data.id);
    const fields = renderActionFields(def, action.success ? action.data : {}, task.data, { event: events[0]!, url });
    const message = fields.message || undefined;
    const payload = pluginPayload({
      id: d.id,
      events,
      sentAt: now.toISOString(),
      rule: { id: rule.id, name: rule.name },
      task: task.data,
      appUrl: deps.appUrl,
      message,
      occurrence: event?.occurrence,
      comment: event?.comment,
    });
    const link = def.linksTasks
      ? (check(await db.from('plugin_links').select('external_id, external_url').eq('connection_id', connection.id).eq('task_id', d.task_id).maybeSingle(), 'plugin_links') as {
          external_id: string;
          external_url: string | null;
        } | null)
      : null;
    const result = await runtime.deliver(
      { config: config.data, secrets, net: deps.net, now: deps.now ?? (() => new Date()) },
      { id: d.id, payload, fields, link: link && { externalId: link.external_id, externalUrl: link.external_url }, retry: d.attempts > 1 },
    );
    if (def.linksTasks && result.ok && result.externalId && result.externalId !== link?.external_id) {
      check(
        await db
          .from('plugin_links')
          .upsert({ connection_id: connection.id, task_id: d.task_id, user_id: d.user_id, external_id: result.externalId, external_url: result.externalUrl ?? null, updated_at: now.toISOString() }, { onConflict: 'connection_id,task_id' }),
        'plugin_links upsert',
      );
    }
    return await settle(deps, d, result, { payload, events }, connection.id);
  } catch (error) {
    deps.log?.(`wysyłka ${d.id}`, error);
    return settle(deps, d, { ok: false, retryable: true, error: `Błąd serwera: ${(error as Error).message}` }, {}, null).catch(() => 'failed' as const);
  }
}

// ── Przebieg ─────────────────────────────────────────────────────────────────────────────────

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/** Należne wysyłki aż do wyczerpania albo końca budżetu czasu. */
export async function deliverDue(deps: EngineDeps, summary: RunSummary, started = Date.now()): Promise<void> {
  while (Date.now() - started < BUDGET_MS) {
    const claimed = check(await deps.db.rpc('claim_plugin_deliveries', { p_limit: CLAIM_BATCH, p_per_minute: PER_MINUTE }), 'claim_plugin_deliveries') as DeliveryRow[] | null;
    if (!claimed?.length) return;
    // Wysyłki jednego zadania przez jedno połączenie po kolei (plugin z powiązaniem nie założy dwóch issue).
    const groups = new Map<string, DeliveryRow[]>();
    for (const d of claimed) {
      const key = `${d.connection_id}:${d.task_id}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    await eachLimited([...groups.values()], PARALLEL, async (group) => {
      for (const d of group) summary[await deliverOne(deps, d)]++;
    });
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Najbliższa wysyłka (koniec okna opóźnienia) wypada za ≤ 45 s i mieści się w budżecie — przebieg czeka
 * (co 2 s sprawdzając, czy w kolejce nie ma nowej pracy). `true` = jest praca, przebieg idzie dalej.
 */
async function waitForWork(deps: EngineDeps, started: number): Promise<boolean> {
  // Tylko przyszłe: już należna, a niewzięta = limit połączenia na minutę — zostaje dla crona, nie blokuje okien.
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const { data } = await deps.db
    .from('plugin_deliveries')
    .select('next_attempt_at')
    .eq('status', 'pending')
    .gt('next_attempt_at', now)
    .order('next_attempt_at')
    .limit(1)
    .maybeSingle();
  if (!data) return false;
  const due = Date.parse(data.next_attempt_at as string);
  const sleep = deps.sleep ?? defaultSleep;
  for (;;) {
    const left = due - (deps.now ?? (() => new Date()))().getTime();
    if (left <= 0) return true;
    if (left > WAIT_MAX_MS || Date.now() - started + left > BUDGET_MS) return false;
    await sleep(Math.min(WAIT_STEP_MS, left));
    const { data: fresh } = await deps.db.from('plugin_outbox').select('id').is('processed_at', null).limit(1).maybeSingle();
    if (fresh) return true;
  }
}

/** Cały przebieg pod dzierżawą; kto jej nie dostał, zostawia prośbę o powtórkę posiadaczowi. */
export async function runDeliveries(deps: EngineDeps): Promise<RunSummary> {
  const summary: RunSummary = { locked: false, queued: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  const holder = crypto.randomUUID();
  const got = check(await deps.db.rpc('plugin_lock', { p_name: LEASE, p_holder: holder, p_ttl_seconds: LEASE_TTL_SEC }), 'plugin_lock');
  if (!got) return summary;
  summary.locked = true;
  const started = Date.now();
  try {
    for (let round = 0; round < 50; round++) {
      summary.queued += await processOutbox(deps);
      await deliverDue(deps, summary, started);
      if (await waitForWork(deps, started)) continue;
      const again = check(await deps.db.rpc('plugin_unlock', { p_name: LEASE, p_holder: holder, p_ttl_seconds: LEASE_TTL_SEC }), 'plugin_unlock');
      if (!again) return summary;
    }
    await deps.db.rpc('plugin_unlock', { p_name: LEASE, p_holder: holder, p_ttl_seconds: LEASE_TTL_SEC });
    return summary;
  } catch (error) {
    // Oddanie dzierżawy (inaczej wygaśnie sama); następny sygnał albo cron co minutę dokończy.
    deps.log?.('przebieg wysyłek', error);
    await deps.db.rpc('plugin_unlock', { p_name: LEASE, p_holder: holder, p_ttl_seconds: LEASE_TTL_SEC }).then(undefined, () => undefined);
    throw error;
  }
}
