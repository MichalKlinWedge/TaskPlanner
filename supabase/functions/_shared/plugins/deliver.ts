/**
 * Dostarczanie wysyłek pluginów (SPECYFIKACJA M21) — klient `service_role`, bez Deno (testy w Node).
 *
 * Jeden przebieg (`runDeliveries`, pod dzierżawą `plugin_runs` — flush, cron i „Ponów” nie pracują równolegle):
 *   1. kolejka `plugin_outbox` → wysyłki `plugin_deliveries` z deterministycznym id (prośba „Wyślij do…” →
 *      `requestDeliveryId`; powtórne przetworzenie tego samego wiersza nic nie podwaja — `on conflict do nothing`),
 *   2. należne wysyłki (`claim_plugin_deliveries`: limit na połączenie, przerwane wracają po 5 min) →
 *      sprawdzenie na **bieżącym** stanie: reguła, połączenie aktywne, dostęp właściciela reguły do zadania,
 *      zadanie nie w koszu → ładunek → `deliver()` pluginu → wynik: wysłane / ponowienie / błąd / połączenie wyłączone.
 * Gwarancja „co najmniej raz”: id wysyłki jako `Idempotency-Key` u odbiorcy.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { pluginDef, type PluginDef } from '../../../../packages/core/src/plugins/catalog.ts';
import type { PluginEvent } from '../../../../packages/core/src/plugins/events.ts';
import { PluginTaskData, pluginPayload, requestDeliveryId, retryDelaySec, taskUrl } from '../../../../packages/core/src/plugins/payload.ts';
import { renderTemplate, templateValues } from '../../../../packages/core/src/plugins/template.ts';
import type { DeliveryResult, NetDeps, PluginRuntime } from './types.ts';
import { webhook } from './webhook.ts';

export const RUNTIMES: Record<string, PluginRuntime> = { webhook };

/** Najwięcej wysłanych na połączenie w ciągu minuty (nadmiar czeka na następny przebieg). */
export const PER_MINUTE = 60;
const LEASE = 'deliver';
const LEASE_TTL_SEC = 170;
/** Po tylu ms przebieg nie bierze nowych wysyłek (limit funkcji 150 s). */
const BUDGET_MS = 100_000;
const CLAIM_BATCH = 20;
const PARALLEL = 4;

export interface EngineDeps {
  db: SupabaseClient;
  net: NetDeps;
  /** Adres aplikacji webowej (`{{url}}`, `task.url`). */
  appUrl: string;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
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
  action: Record<string, unknown>;
  deleted_at: string | null;
}

interface OutboxRow {
  id: number;
  scope_id: string;
  table_name: string;
  row_id: string;
  task_id: string | null;
  after: Record<string, unknown> | null;
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

/** Nieprzetworzone wiersze `plugin_outbox` → `plugin_deliveries`; zwraca liczbę nowych wysyłek. */
export async function processOutbox(deps: EngineDeps): Promise<number> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let queued = 0;
  for (let round = 0; round < 10; round++) {
    const rows = check(await db.from('plugin_outbox').select('id, scope_id, table_name, row_id, task_id, after').is('processed_at', null).order('id').limit(200), 'plugin_outbox') as OutboxRow[];
    if (!rows.length) break;
    const ruleIds = [...new Set(rows.filter((r) => r.table_name === 'plugin_requests').map((r) => String(r.after?.rule_id ?? '')).filter(Boolean))];
    const rules = new Map<string, RuleRow>();
    if (ruleIds.length) {
      for (const r of check(await db.from('plugin_rules').select('id, scope_id, name, connection_id, enabled, action, deleted_at').in('id', ruleIds), 'plugin_rules') as RuleRow[]) rules.set(r.id, r);
    }
    const deliveries = [];
    for (const row of rows) {
      // I1: tylko „Wyślij do…”; zdarzenia zmian zadań (I2) dojdą tutaj.
      if (row.table_name !== 'plugin_requests' || !row.after) continue;
      const ruleId = String(row.after.rule_id);
      const rule = rules.get(ruleId);
      const problem = !rule || rule.deleted_at || rule.scope_id !== row.scope_id ? 'Reguła usunięta' : !rule.enabled ? 'Reguła wyłączona' : null;
      deliveries.push({
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
      });
    }
    if (deliveries.length) {
      const inserted = check(await db.from('plugin_deliveries').upsert(deliveries, { onConflict: 'id', ignoreDuplicates: true }).select('id'), 'plugin_deliveries') as { id: string }[] | null;
      queued += inserted?.length ?? 0;
    }
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

/** Wynik pluginu → stan wysyłki (i połączenia przy 401 / 403 / 410). */
async function settle(deps: EngineDeps, d: DeliveryRow, result: DeliveryResult, extra: Record<string, unknown>, connectionId: string | null): Promise<Outcome> {
  const now = (deps.now ?? (() => new Date()))();
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
    const rule = check(await db.from('plugin_rules').select('id, scope_id, name, connection_id, enabled, action, deleted_at').eq('id', d.rule_id).maybeSingle(), 'plugin_rules') as RuleRow | null;
    if (!rule || rule.deleted_at) return await skip(deps, d, 'Reguła usunięta');
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
    if (task.data.deletedAt) return await skip(deps, d, 'Zadanie w koszu');

    const config = def.configSchema.safeParse(connection.config);
    if (!config.success) return await settle(deps, d, { ok: false, retryable: false, error: 'Niepoprawna konfiguracja połączenia' }, {}, null);
    const secretText = check(await db.rpc('plugin_secret_get', { p_connection: connection.id }), 'plugin_secret_get') as string | null;
    const secrets = secretText ? (JSON.parse(secretText) as Record<string, string>) : null;
    if (!secrets) return await settle(deps, d, { ok: false, retryable: false, error: 'Brak sekretu połączenia — dodaj połączenie ponownie' }, {}, null);

    const action = def.actionSchema.safeParse(rule.action ?? {});
    const events = (d.events.length ? d.events : ['task.sent']) as PluginEvent[];
    const url = taskUrl(deps.appUrl, task.data.id);
    const template = action.success && typeof action.data.message === 'string' ? action.data.message : '';
    const message = template ? renderTemplate(template, templateValues(task.data, { event: events[0]!, url }), def.escape) : undefined;
    const payload = pluginPayload({ id: d.id, events, sentAt: now.toISOString(), rule: { id: rule.id, name: rule.name }, task: task.data, appUrl: deps.appUrl, message });
    const result = await runtime.deliver({ config: config.data, secrets, net: deps.net, now: deps.now ?? (() => new Date()) }, { id: d.id, payload });
    return await settle(deps, d, result, { payload }, connection.id);
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
    await eachLimited(claimed, PARALLEL, async (d) => {
      summary[await deliverOne(deps, d)]++;
    });
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
    for (let round = 0; round < 5; round++) {
      summary.queued += await processOutbox(deps);
      await deliverDue(deps, summary, started);
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
