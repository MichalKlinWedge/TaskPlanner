/**
 * `inbound-api` — przychodzące API (v1.x, SPECYFIKACJA M22): inna aplikacja (Expedition Plan) tworzy
 * i aktualizuje zadania tokenem osobistym.
 *
 *   PUT  tasks/<klucz>   (Authorization: Bearer tpk_…) → utworzenie (201) / scalenie (200)
 *   GET  tasks/<klucz>   (Authorization: Bearer tpk_…) → stan (200), klucz nieznany (404)
 *        oba → {id, key, created, status, deleted, url, applied, kept}; usunięte na stałe = 410
 *   POST tokens/create   (użytkownik, JWT) → {label, listId} → {tokenId, token} — token jawny tylko w tej odpowiedzi
 *   POST tokens/revoke   (użytkownik, JWT) → {tokenId}
 *
 * Token = skrót SHA-256 w `api_tokens`; daje dostęp tylko do zadań ze swoim kluczem zewnętrznym (`ep:<tripId>:<ref>`,
 * id zadania = `apiTaskId(konto, klucz)`), nigdy do innych. Limit `INBOUND_RATE_PER_MINUTE` zapytań na token,
 * treść do `INBOUND_MAX_BODY_BYTES`. Scalanie trójstronne i uprawnienia w RPC `upsert_integration_task`.
 * Kontrakt z Expedition Plan: `docs/INTEGRACJA_TP.md` w repozytorium EP. Błędy = `{error, details?}`.
 * Sekrety: opcjonalnie `APP_URL` (link do zadania w odpowiedzi).
 */
import { apiTaskId } from '../../../packages/core/src/ids.ts';
import {
  ApiTokenCreate,
  ApiTokenRef,
  apiTokenHash,
  apiTokenHint,
  bearerApiToken,
  generateApiToken,
  INBOUND_MAX_BODY_BYTES,
  INBOUND_RATE_PER_MINUTE,
  InboundTaskInput,
  inboundIssue,
  inboundIssues,
  inboundSource,
  inboundTags,
  inboundTaskResult,
  inboundTaskRow,
  inboundUpsertOutcome,
  parseExternalKey,
  type ExternalKey,
} from '../../../packages/core/src/inbound-api.ts';
import { dbError, InboundError, readJsonObject } from '../_shared/inbound-api.ts';
import { admin, json, optionalEnv, requireUser, route, serve } from '../_shared/runtime.ts';

const FN = 'inbound-api';
const DEFAULT_APP_URL = 'https://task-planner-omega-indol.vercel.app';
const appUrl = () => optionalEnv('APP_URL') ?? DEFAULT_APP_URL;

interface TokenAuth {
  id: string;
  userId: string;
  listId: string;
}

/** Błąd RPC → odpowiedź z komunikatem z bazy (TP003 = 403…) albo wyjątek (500). */
function check<T>(result: { data: T; error: { code?: string; message?: string } | null }): T {
  if (result.error) throw dbError(result.error) ?? new Error(result.error.message ?? 'Błąd bazy');
  return result.data;
}

async function requireToken(req: Request): Promise<TokenAuth> {
  const token = bearerApiToken(req.headers.get('authorization'));
  const challenge = { 'www-authenticate': 'Bearer realm="taskplanner"' };
  if (!token) throw new InboundError(401, 'Wymagany nagłówek Authorization: Bearer tpk_… (token z Ustawień → Integracje).', challenge);
  const auth = check(await admin().rpc('api_token_auth', { p_hash: await apiTokenHash(token), p_per_minute: INBOUND_RATE_PER_MINUTE })) as
    | (TokenAuth & { allowed: boolean; retryAfter: number })
    | null;
  if (!auth) throw new InboundError(401, 'Nieznany albo odwołany token.', challenge);
  if (!auth.allowed) {
    throw new InboundError(429, `Za dużo zapytań — najwyżej ${INBOUND_RATE_PER_MINUTE} na minutę. Spróbuj za ${auth.retryAfter} s.`, {
      'retry-after': String(auth.retryAfter),
    });
  }
  return auth;
}

function externalKey(path: string): ExternalKey {
  const key = parseExternalKey(path.slice('tasks/'.length));
  if (!key) throw new InboundError(400, 'Niepoprawny klucz zadania — oczekiwano ep:<tripId>:<ref> (litery, cyfry, „-”, „.”, „_”, „~”).');
  return key;
}

async function putTask(req: Request, path: string): Promise<Response> {
  const auth = await requireToken(req);
  const key = externalKey(path);
  const parsed = InboundTaskInput.safeParse(await readJsonObject(req, INBOUND_MAX_BODY_BYTES));
  if (!parsed.success) {
    const { error, details } = inboundIssues(parsed.error);
    throw new InboundError(400, error, {}, details);
  }
  const source = inboundSource(key, parsed.data.source);
  if (!source) {
    throw new InboundError(400, 'source: tripId i ref muszą zgadzać się z kluczem z adresu.', {}, [
      { path: 'source', message: `Klucz ${key.key} = tripId ${key.tripId}, ref ${key.ref}.` },
    ]);
  }
  const db = admin();
  const taskId = apiTaskId(auth.userId, key.key);
  // Tagi nieobecne = bez zmian (`null` w RPC); `null` w treści = zdejmij tagi z poprzednich wysyłek.
  const names = parsed.data.tags === undefined ? null : (parsed.data.tags ?? []);
  const existing = names?.length
    ? ((check(await db.from('tags').select('id, name').eq('scope_id', auth.userId).is('deleted_at', null)) ?? []) as { id: string; name: string }[])
    : [];
  const raw = check(
    await db.rpc('upsert_integration_task', {
      p_token: auth.id,
      p_key: key.key,
      p_task_id: taskId,
      p_task: inboundTaskRow(parsed.data),
      p_tags: names === null ? null : inboundTags(auth.userId, taskId, names, existing),
      p_source: source,
    }),
  ) as { task?: unknown } | null;
  const outcome = inboundUpsertOutcome(raw);
  if (outcome?.result === 'deleted') throw new InboundError(410, GONE);
  const created = outcome?.result === 'created';
  const task = outcome && inboundTaskResult(key.key, raw?.task, appUrl(), { created, applied: outcome.applied, kept: outcome.kept });
  if (!task) throw new Error('Nieczytelny wynik upsert_integration_task');
  return json(task, created ? 201 : 200);
}

const GONE = 'Zadanie usunięto na stałe w Task Plannerze — nie zostanie utworzone ponownie.';

async function getTask(req: Request, path: string): Promise<Response> {
  const auth = await requireToken(req);
  const key = externalKey(path);
  const raw = check(
    await admin().rpc('integration_task_state', { p_token: auth.id, p_key: key.key, p_task_id: apiTaskId(auth.userId, key.key) }),
  ) as { status?: string; task?: unknown } | null;
  if (raw?.status === 'missing') throw new InboundError(404, 'Nie ma zadania z tym kluczem.');
  if (raw?.status === 'deleted') throw new InboundError(410, GONE);
  const task = inboundTaskResult(key.key, raw?.task, appUrl());
  if (!task) throw new Error('Nieczytelny stan zadania');
  return json(task);
}

async function tokenCreate(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const input = ApiTokenCreate.safeParse(await readJsonObject(req, 4096));
  if (!input.success) throw new InboundError(400, inboundIssue(input.error));
  const token = generateApiToken();
  const tokenId = check(
    await admin().rpc('api_token_create', {
      p_user: user.id,
      p_label: input.data.label,
      p_list: input.data.listId,
      p_hash: await apiTokenHash(token),
      p_hint: apiTokenHint(token),
    }),
  ) as string;
  return json({ tokenId, token });
}

async function tokenRevoke(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const input = ApiTokenRef.safeParse(await readJsonObject(req, 4096));
  if (!input.success) throw new InboundError(400, 'Brak tokenId');
  check(await admin().rpc('api_token_revoke', { p_user: user.id, p_token: input.data.tokenId }));
  return json({ ok: true });
}

async function handle(req: Request, url: URL): Promise<Response> {
  const path = route(url, FN);
  if (path.startsWith('tasks/')) {
    if (req.method === 'PUT') return putTask(req, path);
    if (req.method === 'GET') return getTask(req, path);
    throw new InboundError(405, 'Dozwolone: GET, PUT', { allow: 'GET, PUT' });
  }
  if (path === 'tokens/create' || path === 'tokens/revoke') {
    if (req.method !== 'POST') throw new InboundError(405, 'Tylko POST', { allow: 'POST' });
    return path === 'tokens/create' ? tokenCreate(req) : tokenRevoke(req);
  }
  throw new InboundError(404, `Nieznana ścieżka ${path}`);
}

serve(async (req, url) => {
  try {
    return await handle(req, url);
  } catch (error) {
    if (!(error instanceof InboundError)) throw error;
    const res = json(error.details ? { error: error.message, details: error.details } : { error: error.message }, error.status);
    for (const [k, v] of Object.entries(error.headers)) res.headers.set(k, v);
    return res;
  }
});
