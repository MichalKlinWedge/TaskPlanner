/**
 * `npm run setup --workspace tools/edge-tests` — lokalne sekrety Edge Functions PoC-6:
 *
 * - `supabase/functions/.env` (prawdziwe usługi lokalnie): CRON_SECRET, INBOUND_SECRET, VAPID_KEYS,
 *   VAPID_PUBLIC_KEY, VAPID_SUBJECT, FUNCTIONS_PUBLIC_URL, GOOGLE_CLIENT_ID/SECRET (z głównego `.env.local`),
 * - `supabase/functions/.env.test` — to samo + fałszywe Google i push po http (testy integracyjne),
 * - Vault lokalnej bazy: `functions_url` i `cron_secret` dla `pg_cron` (`call_edge_function`).
 *
 * Istniejące wartości zostają (klucze VAPID nie zmieniają się, więc subskrypcje przeglądarek są ważne).
 * Niczego tajnego nie wypisuje. Pliki są w `.gitignore`.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fnEnv = `${root}supabase/functions/.env`;
const fnEnvTest = `${root}supabase/functions/.env.test`;
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_taskplanner';
/** Adres funkcji widziany z kontenera bazy (sieć Dockera Supabase). */
const FUNCTIONS_URL_FROM_DB = process.env.FUNCTIONS_URL_FROM_DB ?? 'http://supabase_kong_taskplanner:8000/functions/v1';
export const FAKE_PORT = 54590;
const HOST = 'http://host.docker.internal';

export function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function writeEnv(path: string, values: Record<string, string>, header: string) {
  const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
  writeFileSync(path, `# ${header}\n# Wygenerowane przez tools/edge-tests/src/setup.ts — nie commitować.\n${body}\n`);
}

async function vapidKeys(): Promise<{ keys: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = JSON.stringify({
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  });
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { keys, publicKey: Buffer.from(raw).toString('base64url') };
}

export function sql(query: string): string {
  return execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: query,
    encoding: 'utf8',
  }).trim();
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

function vaultPut(name: string, value: string) {
  sql(`do $$ begin
    if exists (select 1 from vault.secrets where name = ${quote(name)}) then
      perform vault.update_secret((select id from vault.secrets where name = ${quote(name)}), ${quote(value)});
    else
      perform vault.create_secret(${quote(value)}, ${quote(name)}, 'PoC-6: pg_cron → Edge Functions');
    end if;
  end $$;`);
}

async function main() {
  const current = readEnv(fnEnv);
  // `.env.local` głównego checkoutu (sekrety użytkownika), nadpisany przez `.env.local` bieżącego worktree.
  const mainRoot = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim().replace(/[\\/]\.git$/, '');
  const rootEnv = { ...readEnv(`${mainRoot}/.env.local`), ...readEnv(`${root}.env.local`) };
  const secret = () => randomBytes(32).toString('base64url');
  const values: Record<string, string> = {
    CRON_SECRET: current.CRON_SECRET ?? secret(),
    INBOUND_SECRET: current.INBOUND_SECRET ?? secret(),
    VAPID_SUBJECT: current.VAPID_SUBJECT ?? 'mailto:push@taskplanner.invalid',
    FUNCTIONS_PUBLIC_URL: current.FUNCTIONS_PUBLIC_URL ?? 'http://127.0.0.1:54521/functions/v1',
  };
  if (current.VAPID_KEYS && current.VAPID_PUBLIC_KEY) {
    values.VAPID_KEYS = current.VAPID_KEYS;
    values.VAPID_PUBLIC_KEY = current.VAPID_PUBLIC_KEY;
  } else {
    const v = await vapidKeys();
    values.VAPID_KEYS = v.keys;
    values.VAPID_PUBLIC_KEY = v.publicKey;
  }
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    const v = rootEnv[k] ?? current[k];
    if (v) values[k] = v;
  }
  writeEnv(fnEnv, values, 'Edge Functions lokalnie (prawdziwe usługi zewnętrzne)');

  const fake = `${HOST}:${FAKE_PORT}`;
  writeEnv(fnEnvTest, {
    ...values,
    GOOGLE_CLIENT_ID: 'fake-client-id',
    GOOGLE_CLIENT_SECRET: 'fake-client-secret',
    GOOGLE_AUTH_URL: `${fake}/o/oauth2/v2/auth`,
    GOOGLE_TOKEN_URL: `${fake}/token`,
    GOOGLE_REVOKE_URL: `${fake}/revoke`,
    GOOGLE_API_BASE: `${fake}/calendar/v3`,
    GOOGLE_ALLOW_HTTP_WEBHOOK: '1',
    PUSH_ALLOW_HTTP: '1',
    LINK_PREVIEW_TEST_HOSTS: `host.docker.internal:${FAKE_PORT}`,
    PLUGIN_TEST_HOSTS: `host.docker.internal:${FAKE_PORT}`,
    AI_TEST_GEMINI_BASE: `${fake}/gemini/v1beta`,
    APP_URL: 'https://app.taskplanner.test',
  }, 'Edge Functions w testach integracyjnych (fałszywe Google i usługa push)');

  vaultPut('functions_url', FUNCTIONS_URL_FROM_DB);
  vaultPut('cron_secret', values.CRON_SECRET!);
  console.log('Zapisano supabase/functions/.env, .env.test i sekrety Vault (functions_url, cron_secret).');
  console.log(`Klucz publiczny VAPID (dla przeglądarki): ${values.VAPID_PUBLIC_KEY}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
