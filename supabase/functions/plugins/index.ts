/**
 * `plugins` — integracje wychodzące (SPECYFIKACJA M21, D21; etap I1: fundament + Webhook).
 *
 *   POST flush                (pg_net, sekret crona) → przebieg wysyłek w tle (wyzwalacze na `plugin_requests`, `tasks`,
 *                                                       `task_tags`, `task_completions`, `task_comments`; „Ponów”)
 *   POST cron/tick            (pg_cron co minutę, tylko gdy jest co robić — `plugins_tick()`) → to samo: ponowienia,
 *                                                       zgubione sygnały, przerwane wysyłki
 *   POST connections/create   (użytkownik) → {plugin, label, config, secrets} → połączenie, sekrety do Vault → {connectionId}
 *   POST connections/update   (użytkownik) → {connectionId, label?, config?, secrets?, enabled?}
 *   POST connections/delete   (użytkownik) → {connectionId} → usunięcie sekretu, `deleted_at`
 *   POST test                 (użytkownik) → {connectionId} → „Wyślij próbne” → {ok, error?, httpStatus?}
 *
 * Połączenia wracają do klientów zwykłą synchronizacją (`pull_changes`, tabela tylko do odczytu).
 * Sekrety: `CRON_SECRET`; opcjonalnie `APP_URL` (link do zadania w ładunku), `PLUGIN_TEST_HOSTS` (tylko `.env.test`).
 */
import { pluginDef } from '../../../packages/core/src/plugins/catalog.ts';
import { RUNTIMES, runDeliveries } from '../_shared/plugins/deliver.ts';
import type { NetDeps } from '../_shared/plugins/types.ts';
import { admin, HttpError, json, optionalEnv, requireCron, requireUser, route, serve } from '../_shared/runtime.ts';

const FN = 'plugins';
/** Najwięcej połączeń na konto. */
const MAX_CONNECTIONS = 20;
const DEFAULT_APP_URL = 'https://task-planner-omega-indol.vercel.app';

/** Tylko testy integracyjne (`.env.test`): fałszywy odbiorca pod `host.docker.internal` (http, port spoza 80/443). */
const allowHosts = optionalEnv('PLUGIN_TEST_HOSTS')?.split(',').map((h) => h.trim()).filter(Boolean) ?? [];

async function resolve(host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([Deno.resolveDns(host, 'A').catch(() => []), Deno.resolveDns(host, 'AAAA').catch(() => [])]);
  return [...a, ...aaaa];
}

const net: NetDeps = { fetch, resolve, allowHosts };
const appUrl = () => optionalEnv('APP_URL') ?? DEFAULT_APP_URL;

interface ConnectionRow {
  id: string;
  user_id: string;
  plugin: string;
  label: string;
  config: Record<string, unknown>;
  status: string;
  deleted_at: string | null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Oczekiwano obiektu JSON');
  return value as Record<string, unknown>;
}

async function ownConnection(userId: string, id: unknown): Promise<ConnectionRow> {
  if (typeof id !== 'string') throw new HttpError(400, 'Brak connectionId');
  const { data } = await admin().from('plugin_connections').select('id, user_id, plugin, label, config, status, deleted_at').eq('id', id).eq('user_id', userId).is('deleted_at', null).maybeSingle();
  if (!data) throw new HttpError(404, 'Nie ma takiego połączenia');
  return data as ConnectionRow;
}

const firstIssue = (error: { issues: { message: string }[] }) => error.issues[0]?.message ?? 'Niepoprawne dane';

function label(value: unknown, fallback?: string): string {
  const text = typeof value === 'string' ? value.trim() : fallback ?? '';
  if (!text) throw new HttpError(400, 'Nazwa połączenia nie może być pusta');
  if (text.length > 100) throw new HttpError(400, 'Nazwa połączenia: najwyżej 100 znaków');
  return text;
}

async function connectionCreate(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const b = await body(req);
  const def = pluginDef(String(b.plugin ?? ''));
  const runtime = def && RUNTIMES[def.id];
  if (!def || !runtime) throw new HttpError(400, 'Nieznany plugin');
  const config = def.configSchema.safeParse(b.config ?? {});
  if (!config.success) throw new HttpError(400, firstIssue(config.error));
  const secrets = def.secretSchema.safeParse(b.secrets ?? {});
  if (!secrets.success) throw new HttpError(400, firstIssue(secrets.error));
  const problem = runtime.validateConfig(config.data, net);
  if (problem) throw new HttpError(400, problem);
  const db = admin();
  const { count } = await db.from('plugin_connections').select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('deleted_at', null);
  if ((count ?? 0) >= MAX_CONNECTIONS) throw new HttpError(400, `Najwyżej ${MAX_CONNECTIONS} połączeń`);
  const { data, error } = await db.from('plugin_connections').insert({ user_id: user.id, plugin: def.id, label: label(b.label, def.name), config: config.data }).select('id').single();
  if (error) throw error;
  const { error: secretError } = await db.rpc('plugin_secret_set', { p_connection: data.id, p_secret: JSON.stringify(secrets.data) });
  if (secretError) {
    await db.rpc('plugin_connection_remove', { p_connection: data.id });
    throw new Error(`Vault: ${secretError.message}`);
  }
  return json({ connectionId: data.id });
}

async function connectionUpdate(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const b = await body(req);
  const connection = await ownConnection(user.id, b.connectionId);
  const def = pluginDef(connection.plugin);
  const runtime = def && RUNTIMES[def.id];
  if (!def || !runtime) throw new HttpError(400, 'Nieznany plugin');
  const patch: Record<string, unknown> = {};
  if (b.label !== undefined) patch.label = label(b.label);
  if (b.config !== undefined) {
    const config = def.configSchema.safeParse(b.config);
    if (!config.success) throw new HttpError(400, firstIssue(config.error));
    const problem = runtime.validateConfig(config.data, net);
    if (problem) throw new HttpError(400, problem);
    patch.config = config.data;
  }
  if (typeof b.enabled === 'boolean') {
    patch.status = b.enabled ? 'active' : 'disabled';
    if (b.enabled) patch.last_error = null;
  }
  const db = admin();
  if (b.secrets !== undefined) {
    const secrets = def.secretSchema.safeParse(b.secrets);
    if (!secrets.success) throw new HttpError(400, firstIssue(secrets.error));
    const { error } = await db.rpc('plugin_secret_set', { p_connection: connection.id, p_secret: JSON.stringify(secrets.data) });
    if (error) throw new Error(`Vault: ${error.message}`);
    // Nowy sekret zwykle naprawia odrzucone wysyłki (401 / 403).
    if (connection.status === 'error') Object.assign(patch, { status: 'active', last_error: null });
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from('plugin_connections').update(patch).eq('id', connection.id);
    if (error) throw error;
  }
  return json({ ok: true });
}

async function connectionDelete(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const connection = await ownConnection(user.id, (await body(req)).connectionId);
  const { error } = await admin().rpc('plugin_connection_remove', { p_connection: connection.id });
  if (error) throw error;
  return json({ ok: true });
}

async function testConnection(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const connection = await ownConnection(user.id, (await body(req)).connectionId);
  const def = pluginDef(connection.plugin);
  const runtime = def && RUNTIMES[def.id];
  if (!def || !runtime) throw new HttpError(400, 'Nieznany plugin');
  const config = def.configSchema.safeParse(connection.config);
  if (!config.success) return json({ ok: false, error: 'Niepoprawna konfiguracja połączenia' });
  const db = admin();
  const { data: secretText } = await db.rpc('plugin_secret_get', { p_connection: connection.id });
  if (!secretText) return json({ ok: false, error: 'Brak sekretu połączenia — dodaj połączenie ponownie' });
  const result = await runtime.test({ config: config.data, secrets: JSON.parse(secretText as string), net, now: () => new Date() });
  if (result.ok) await db.from('plugin_connections').update({ last_used_at: new Date().toISOString() }).eq('id', connection.id);
  return json(result.ok ? { ok: true, httpStatus: result.httpStatus ?? null } : { ok: false, error: result.error, httpStatus: result.httpStatus ?? null });
}

/**
 * Przebieg wysyłek w tle (`EdgeRuntime.waitUntil`): odpowiedź idzie od razu, a przebieg może poczekać na koniec
 * okna opóźnienia reguły zdarzeniowej (≤ 45 s) — `pg_net` nie trzyma połączenia. Bez `waitUntil` (inne środowisko)
 * odpowiedź czeka na koniec przebiegu.
 */
async function deliveries(req: Request): Promise<Response> {
  requireCron(req);
  const run = runDeliveries({ db: admin(), net, appUrl: appUrl(), log: (m, e) => console.error(m, e) }).catch((e) => {
    console.error('przebieg wysyłek', e);
    return null;
  });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) {
    rt.waitUntil(run);
    return json({ started: true });
  }
  return json((await run) ?? { error: 'przebieg nieudany' });
}

serve(async (req, url) => {
  const path = route(url, FN);
  if (req.method !== 'POST') throw new HttpError(405, 'Tylko POST');
  if (path === 'flush' || path === 'cron/tick') return deliveries(req);
  if (path === 'connections/create') return connectionCreate(req);
  if (path === 'connections/update') return connectionUpdate(req);
  if (path === 'connections/delete') return connectionDelete(req);
  if (path === 'test') return testConnection(req);
  throw new HttpError(404, `Nieznana ścieżka ${path}`);
});
