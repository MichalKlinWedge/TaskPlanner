/**
 * `npm run real --workspace tools/edge-tests -- <polecenie>` — próby PoC-6 na prawdziwych usługach przez
 * LOKALNE funkcje (`npm run serve --workspace tools/edge-tests`) i konto dev@taskplanner.test (`npm run dev:user`).
 *
 *   ics            dodaje kalendarz z `ICS_TEST_URL` (`.env.local`)
 *   poll           to, co robi cron co 15 min (`calendar-sync/cron/poll`)
 *   sync           odświeża teraz konta Google użytkownika (`accounts/sync`, przyrost z `syncToken`)
 *   google-start   wypisuje adres zgody Google (otwórz go w przeglądarce)
 *   status         konta, kalendarze, liczba wydarzeń, ostatnie zmiany
 *   watch <tytuł>  czeka, aż w `calendar_events` pojawi się wydarzenie o tym tytule (pomiar opóźnienia)
 *   ics-watch <tytuł>  co 30 s pobiera `ICS_TEST_URL`; gdy tytuł się pojawi — `cron/poll` i opóźnienie względem Google
 *
 * `--cloud`: to samo na projekcie w chmurze (`supabase link`, sekrety z `supabase/functions/.env.cloud`,
 * hasło `CLOUD_DEV_USER_PASSWORD` z `.env.local`). Sekretów nie wypisuje (adres ICS, tokeny).
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { readEnv } from './setup.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const mainRoot = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim().replace(/[\\/]\.git$/, '');
const env = { ...readEnv(`${mainRoot}/.env.local`), ...readEnv(`${root}.env.local`) };
const cloud = process.argv.includes('--cloud');
const fnEnv = readEnv(`${root}supabase/functions/${cloud ? '.env.cloud' : '.env'}`);
const status = cloud ? cloudStatus() : localStatus();
const functionsUrl = `${status.API_URL}/functions/v1`;
const DEV_PASSWORD = cloud ? env.CLOUD_DEV_USER_PASSWORD : env.DEV_USER_PASSWORD;

function localStatus() {
  const raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

/** Projekt z `supabase link` (`supabase/.temp/project-ref`), klucze z Management API przez CLI. */
function cloudStatus() {
  const ref = readFileSync(`${root}supabase/.temp/project-ref`, 'utf8').trim();
  const raw = execSync(`npx --yes supabase@2.122.0 projects api-keys --project-ref ${ref} -o json`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const keys = JSON.parse(raw.slice(raw.indexOf('['))) as { name: string; api_key: string }[];
  const key = (name: string) => keys.find((k) => k.name === name)!.api_key;
  return { API_URL: `https://${ref}.supabase.co`, ANON_KEY: key('anon'), SERVICE_ROLE_KEY: key('service_role') };
}
const admin = createClient(status.API_URL, status.SECRET_KEY ?? status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function session() {
  const client = createClient(status.API_URL, status.PUBLISHABLE_KEY ?? status.ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: 'dev@taskplanner.test', password: DEV_PASSWORD ?? '' });
  if (error || !data.session) throw new Error(`Logowanie dev@taskplanner.test: ${error?.message} (npm run dev:user)`);
  return { jwt: data.session.access_token, userId: data.user.id };
}

async function call(path: string, init: { jwt?: string; cron?: boolean; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.jwt) headers.authorization = `Bearer ${init.jwt}`;
  if (init.cron) headers['x-cron-secret'] = fnEnv.CRON_SECRET!;
  const t0 = performance.now();
  const res = await fetch(`${functionsUrl}/${path}`, { method: 'POST', headers, body: JSON.stringify(init.body ?? {}) });
  const text = await res.text();
  return { status: res.status, ms: Math.round(performance.now() - t0), body: text.length > 2000 ? `${text.slice(0, 2000)}…` : text };
}

async function printStatus(userId: string) {
  const { data: accounts } = await admin.from('calendar_accounts').select('id, provider, label, status, last_error, last_synced_at').eq('user_id', userId);
  for (const a of accounts ?? []) {
    console.log(`konto ${a.provider} „${a.label}”: ${a.status}${a.last_error ? ` (${a.last_error})` : ''}, ostatnio ${a.last_synced_at}`);
    const { data: cals } = await admin.from('calendars').select('id, name, visible, last_synced_at, sync_state').eq('account_id', a.id);
    for (const c of cals ?? []) {
      const { count } = await admin.from('calendar_events').select('id', { count: 'exact', head: true }).eq('calendar_id', c.id).is('deleted_at', null);
      const ch = c.sync_state?.channel ? `, kanał do ${new Date(c.sync_state.channel.expiration).toISOString()}` : ', bez kanału';
      console.log(`  ${c.visible ? '●' : '○'} ${c.name}: ${count} wydarzeń${c.sync_state?.syncToken ? ', syncToken' : ''}${ch}`);
    }
  }
  const { data: recent } = await admin.from('calendar_events').select('title, start_at, start_date, updated_at, deleted_at').eq('user_id', userId).order('updated_at', { ascending: false }).limit(5);
  for (const e of recent ?? []) console.log(`  zmiana ${e.updated_at}: „${e.title}” ${e.start_at ?? e.start_date}${e.deleted_at ? ' (usunięte)' : ''}`);
}

/** Znacznik `updated` wydarzenia w Google (chwila zapisu zmiany przez użytkownika) — token z Vault. */
async function googleUpdated(title: string): Promise<string | null> {
  const { data: acc } = await admin.from('calendar_accounts').select('id').eq('user_id', userId).eq('provider', 'google').limit(1).maybeSingle();
  if (!acc) return null;
  const { data: secretRaw } = await admin.rpc('account_secret_get', { p_account: acc.id });
  const secret = JSON.parse(secretRaw);
  let token = secret.accessToken as string;
  if (!secret.expiresAt || secret.expiresAt < Date.now() + 60_000) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: secret.refreshToken, grant_type: 'refresh_token' }),
    });
    token = (await res.json()).access_token;
  }
  const q = new URLSearchParams({ q: title, singleEvents: 'true', timeMin: new Date(Date.now() - 86_400_000).toISOString() });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  return (body.items as { summary?: string; updated: string }[] | undefined)?.find((e) => e.summary === title)?.updated ?? null;
}

const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== '--cloud');
const { jwt, userId } = await session();
switch (cmd) {
  case 'ics': {
    if (!env.ICS_TEST_URL) throw new Error('Brak ICS_TEST_URL w .env.local');
    const r = await call('calendar-sync/ics/add', { jwt, body: { url: env.ICS_TEST_URL } });
    console.log(`ics/add: HTTP ${r.status}, ${r.ms} ms`);
    if (r.status !== 200) console.log(r.body);
    await printStatus(userId);
    break;
  }
  case 'poll': {
    const r = await call('calendar-sync/cron/poll', { cron: true });
    console.log(`cron/poll: HTTP ${r.status}, ${r.ms} ms, ${r.body}`);
    break;
  }
  case 'sync': {
    const { data: accounts } = await admin.from('calendar_accounts').select('id').eq('user_id', userId).eq('provider', 'google');
    for (const a of accounts ?? []) {
      const r = await call('calendar-sync/accounts/sync', { jwt, body: { accountId: a.id } });
      const results = r.status === 200 ? JSON.parse(r.body).results : r.body;
      console.log(`accounts/sync: HTTP ${r.status}, ${r.ms} ms, ${JSON.stringify(results)}`);
    }
    await printStatus(userId);
    break;
  }
  case 'google-start': {
    const r = await call('calendar-sync/google/start', { jwt });
    if (r.status !== 200) throw new Error(r.body);
    console.log(JSON.parse(r.body).url);
    break;
  }
  case 'status':
    await printStatus(userId);
    break;
  case 'watch': {
    const title = args.join(' ');
    const t0 = Date.now();
    for (;;) {
      const { data } = await admin.from('calendar_events').select('title, updated_at').eq('user_id', userId).eq('title', title).is('deleted_at', null).limit(1);
      if (data?.length) {
        console.log(`„${title}” w calendar_events po ${Math.round((Date.now() - t0) / 1000)} s od startu (updated_at ${data[0]!.updated_at})`);
        const google = await googleUpdated(title);
        if (google) console.log(`Google: zmiana zapisana ${google}; opóźnienie do calendar_events: ${((Date.parse(data[0]!.updated_at) - Date.parse(google)) / 1000).toFixed(1)} s`);
        break;
      }
      if (Date.now() - t0 > 30 * 60_000) throw new Error('Brak po 30 min');
      await new Promise((r) => setTimeout(r, 2000));
    }
    break;
  }
  case 'ics-watch': {
    const title = args.join(' ');
    const t0 = Date.now();
    let checks = 0;
    for (;;) {
      checks++;
      let text = '';
      try {
        text = await (await fetch(env.ICS_TEST_URL!, { headers: { 'cache-control': 'no-cache' } })).text();
      } catch (error) {
        // Przerwa w sieci (uśpienie, DNS) — następna próba za 30 s.
        console.warn(`${new Date().toISOString()} pobranie nieudane: ${(error as Error).cause ?? error}`);
      }
      if (text.includes(`SUMMARY:${title}`)) {
        const seen = new Date();
        console.log(`ICS z Google zawiera „${title}” o ${seen.toISOString()} (${checks}. pobranie, ${Math.round((Date.now() - t0) / 1000)} s od startu)`);
        const r = await call('calendar-sync/cron/poll', { cron: true });
        const { data } = await admin.from('calendar_events').select('updated_at, calendars!inner(calendar_accounts!inner(provider))')
          .eq('user_id', userId).eq('title', title).eq('calendars.calendar_accounts.provider', 'ics').is('deleted_at', null).limit(1);
        console.log(`cron/poll: HTTP ${r.status}, ${r.ms} ms; w calendar_events (ICS): ${data?.[0]?.updated_at ?? 'BRAK'}`);
        const google = await googleUpdated(title);
        if (google) console.log(`Google: zmiana zapisana ${google}; plik ICS po ${((seen.getTime() - Date.parse(google)) / 1000).toFixed(0)} s (dokładność ±30 s)`);
        break;
      }
      if (Date.now() - t0 > 6 * 3600_000) throw new Error('Brak po 6 h');
      await new Promise((r) => setTimeout(r, 30_000));
    }
    break;
  }
  default:
    console.log('Polecenia: ics | poll | sync | google-start | status | watch <tytuł> | ics-watch <tytuł>');
}
