/**
 * `ai` — asystent AI na własnym koncie użytkownika (v1.x, PLAN_ETAPOWY.md → „Asystent AI”).
 *
 *   POST accounts/create   (użytkownik) → {provider, key, billingConfirmed: true, model?} → konto, klucz do Vault → {accountId}
 *   POST accounts/update   (użytkownik) → {accountId, key?, billingConfirmed?, model?} — nowy klucz wymaga oświadczenia
 *                                          i wraca do stanu „niesprawdzone”; model tylko z listy ostatniego „Sprawdź”
 *   POST accounts/delete   (użytkownik) → {accountId} → klucz usunięty z Vault, `deleted_at`
 *   POST accounts/test     (użytkownik) → {accountId} → „Sprawdź” = lista modeli na kluczu → {ok, models, model} | {ok: false, error, badKey}
 *
 * Konto wraca do klientów zwykłą synchronizacją (`pull_changes`, `ai_accounts` tylko do odczytu, bez klucza).
 * Klucz nigdy nie wychodzi z funkcji: do Google jedzie nagłówkiem `x-goog-api-key` (`packages/ai`).
 * Sekrety: brak własnych; `AI_TEST_GEMINI_BASE` tylko w `.env.test` (fałszywy Gemini w testach integracyjnych).
 */
import { AiAccountCreate, AiAccountRef, AiAccountUpdate, type AiAccountStatus, type AiModelEntry, type AiProvider, aiKeyHint } from '../../../packages/core/src/ai.ts';
import { type AiEndpoints, checkAiKey, modelProblem, testPatch } from '../_shared/ai/accounts.ts';
import { admin, HttpError, json, optionalEnv, requireUser, route, serve } from '../_shared/runtime.ts';

const FN = 'ai';
/** Największe ciało zapytania o konto (klucz + kilka pól). */
const MAX_BODY = 4_000;

const endpoints: AiEndpoints = { gemini: optionalEnv('AI_TEST_GEMINI_BASE') };

interface AccountRow {
  id: string;
  provider: AiProvider;
  model: string | null;
  models: AiModelEntry[];
  status: AiAccountStatus;
}

async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Za duże zapytanie');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Oczekiwano obiektu JSON');
  }
}

const firstIssue = (error: { issues: { message: string }[] }) => error.issues[0]?.message ?? 'Niepoprawne dane';

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, firstIssue(result.error));
  return result.data;
}

async function ownAccount(userId: string, id: string): Promise<AccountRow> {
  const { data } = await admin().from('ai_accounts').select('id, provider, model, models, status').eq('id', id).eq('user_id', userId).is('deleted_at', null).maybeSingle();
  if (!data) throw new HttpError(404, 'Nie ma takiego konta AI');
  return data as AccountRow;
}

async function accountCreate(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const input = parse(AiAccountCreate, await body(req));
  const db = admin();
  const { data, error } = await db
    .from('ai_accounts')
    .insert({ user_id: user.id, provider: input.provider, model: input.model ?? null, key_hint: aiKeyHint(input.key), billing_confirmed_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error?.code === '23505') throw new HttpError(409, 'Konto tego dostawcy jest już podpięte — zmień w nim klucz albo je odłącz.');
  if (error) throw error;
  const { error: secretError } = await db.rpc('ai_secret_set', { p_account: data.id, p_secret: input.key });
  if (secretError) {
    await db.rpc('ai_account_remove', { p_account: data.id });
    throw new Error(`Vault: ${secretError.message}`);
  }
  return json({ accountId: data.id });
}

async function accountUpdate(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const input = parse(AiAccountUpdate, await body(req));
  const account = await ownAccount(user.id, input.accountId);
  const db = admin();
  const patch: Record<string, unknown> = {};
  if (input.model !== undefined) {
    const problem = modelProblem(input.model, account.models);
    if (problem) throw new HttpError(400, problem);
    patch.model = input.model;
  }
  if (input.key !== undefined) {
    const { error } = await db.rpc('ai_secret_set', { p_account: account.id, p_secret: input.key });
    if (error) throw new Error(`Vault: ${error.message}`);
    // Nowy klucz: nowe oświadczenie, stan od nowa — „Sprawdź” potwierdzi go i odświeży listę modeli.
    Object.assign(patch, { key_hint: aiKeyHint(input.key), billing_confirmed_at: new Date().toISOString(), status: 'unverified', last_error: null, verified_at: null });
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from('ai_accounts').update(patch).eq('id', account.id);
    if (error) throw error;
  }
  return json({ ok: true });
}

async function accountDelete(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const account = await ownAccount(user.id, parse(AiAccountRef, await body(req)).accountId);
  const { error } = await admin().rpc('ai_account_remove', { p_account: account.id });
  if (error) throw error;
  return json({ ok: true });
}

async function accountTest(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const account = await ownAccount(user.id, parse(AiAccountRef, await body(req)).accountId);
  const db = admin();
  const { data: key } = await db.rpc('ai_secret_get', { p_account: account.id });
  const result = typeof key === 'string' && key
    ? await checkAiKey(account.provider, key, account.model, endpoints)
    : { ok: false as const, error: 'Brak klucza — odłącz konto i podepnij je ponownie.', badKey: true };
  const { error } = await db.from('ai_accounts').update(testPatch(result, account.status, new Date())).eq('id', account.id);
  if (error) throw error;
  return json(result);
}

serve(async (req, url) => {
  const path = route(url, FN);
  if (req.method !== 'POST') throw new HttpError(405, 'Tylko POST');
  if (path === 'accounts/create') return accountCreate(req);
  if (path === 'accounts/update') return accountUpdate(req);
  if (path === 'accounts/delete') return accountDelete(req);
  if (path === 'accounts/test') return accountTest(req);
  throw new HttpError(404, `Nieznana ścieżka ${path}`);
});
