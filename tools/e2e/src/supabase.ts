/**
 * Lokalny Supabase dla testów E2E i pomiarów: adres i klucze z `supabase status`, konta testowe
 * (osobne od `dev@taskplanner.test`, z którego korzystają inne sesje) i operacje jak z urządzenia
 * (`push_changes`). Hasła są losowe przy każdym utworzeniu konta i nigdzie nie są wypisywane.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { HlcClock, uuidv7 } from '@taskplanner/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface LocalSupabase {
  url: string;
  anonKey: string;
  serviceKey: string;
}

let cached: LocalSupabase | null = null;

export function localSupabase(): LocalSupabase {
  if (cached) return cached;
  const raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(raw.slice(raw.indexOf('{')));
  if (!status.API_URL) throw new Error('Lokalny Supabase nie działa — `npm run supabase -- start`.');
  cached = { url: status.API_URL, anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY, serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY };
  return cached;
}

export function adminClient(): SupabaseClient {
  const { url, serviceKey } = localSupabase();
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Klucz sesji w localStorage przeglądarki — jak `authStorageKey()` w `apps/web/src/lib/supabase-browser.ts`. */
export const authStorageKey = (url: string) => `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;

export interface Account {
  id: string;
  email: string;
  client: SupabaseClient;
  session: Session;
}

async function findUser(email: string): Promise<string | null> {
  const admin = adminClient();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const found = data.users.find((u) => u.email === email);
    if (found) return found.id;
    if (data.users.length < 1000) return null;
  }
}

/**
 * Konto od zera: istniejące o tym adresie jest usuwane (kaskadą znikają jego zakresy i wiersze
 * na serwerze), nowe dostaje losowe hasło, którym od razu się logujemy.
 */
export async function freshAccount(email: string): Promise<Account> {
  const admin = adminClient();
  const old = await findUser(email);
  if (old) {
    const { error } = await admin.auth.admin.deleteUser(old);
    if (error) throw new Error(`deleteUser ${email}: ${error.message}`);
  }
  const password = randomBytes(18).toString('base64url');
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return signIn(email, password);
}

/** Konto istniejące albo nowe (dane zostają) — nowe hasło przy każdym wywołaniu. */
export async function ensureAccount(email: string): Promise<{ account: Account; created: boolean }> {
  const admin = adminClient();
  const password = randomBytes(18).toString('base64url');
  const id = await findUser(email);
  if (id) {
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) throw new Error(`updateUser ${email}: ${error.message}`);
  } else {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
  }
  return { account: await signIn(email, password), created: !id };
}

async function signIn(email: string, password: string): Promise<Account> {
  const { url, anonKey } = localSupabase();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Logowanie ${email}: ${error?.message}`);
  return { id: data.session.user.id, email, client, session: data.session };
}

export interface Op {
  table: string;
  id: string;
  patch: Record<string, unknown>;
}

/** Zmiany jak z urządzenia (`push_changes`, HLC z zegara „e2e”) — porcjami po 200. */
export async function push(account: Account, ops: readonly Op[], device = 'e2e'): Promise<number> {
  const clock = new HlcClock(device);
  const payload = ops.map((o) => ({ op: uuidv7(), table: o.table, id: o.id, set: o.patch, hlc: clock.tick() }));
  let rejected = 0;
  for (let i = 0; i < payload.length; i += 200) {
    const { data, error } = await account.client.rpc('push_changes', { p_ops: payload.slice(i, i + 200) });
    if (error) throw new Error(`push_changes: ${error.message}`);
    rejected += (data as { rejected: unknown[] }).rejected.length;
  }
  return rejected;
}

/** Stan zapisu sesji dla Playwright (`storageState`): sesja Supabase w localStorage strony. */
export function storageState(account: Account, baseURL: string) {
  const { url } = localSupabase();
  return {
    cookies: [],
    origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: authStorageKey(url), value: JSON.stringify(account.session) }] }],
  };
}
