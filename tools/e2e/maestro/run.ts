/**
 * Maestro na telefonie (Etap 13): `npm run test:mobile`. Przygotowuje przebieg (identyfikator RUN
 * w tytułach zadań, godzina przypomnienia za 3 min, `adb reverse` do lokalnego Supabase), uruchamia
 * przepływy z `config.yaml`, sprawdza wynik na serwerze kluczem `service_role` (jak `tools/e2e`)
 * i na koniec przenosi zadania „Maestro …” (także z wcześniejszych, przerwanych przebiegów) do kosza.
 *
 * Wymagania: telefon przez USB (`adb devices` → `device`) z zainstalowanym APK zalogowanym na
 * MAESTRO_EMAIL (domyślnie dev@taskplanner.test) przy lokalnym Supabase; widżet „Dziś” na domyślnej
 * stronie ekranu głównego; Maestro CLI (`~/.maestro/bin` albo MAESTRO_BIN) i JDK ≥ 17
 * (MAESTRO_JAVA_HOME albo JAVA_HOME). `--keep` zostawia zadania przebiegu.
 * Uruchamiane wprost przez Node ≥ 22.18 (usuwanie typów; pakiety workspace to źródła TS poza node_modules).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { adminClient, localSupabase, push, type Account } from '../src/supabase.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, '..', 'out', 'maestro');
const WIN = process.platform === 'win32';
const EMAIL = process.env.MAESTRO_EMAIL ?? 'dev@taskplanner.test';
const API_PORT = 54521;
const KEEP = process.argv.includes('--keep');
/** Tytuły zadań z przepływów (`quick-add-today.yaml`, `reminder.yaml`, `widget.yaml`). */
const OURS = /^Maestro [0-9a-z]+ (A|R|Wid)$/;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function javaHome(): string {
  const home = process.env.MAESTRO_JAVA_HOME ?? process.env.JAVA_HOME;
  if (!home) fail('Brak JDK: ustaw MAESTRO_JAVA_HOME (albo JAVA_HOME) na JDK ≥ 17.');
  const release = join(home, 'release');
  const version = existsSync(release) ? /JAVA_VERSION="([^"]+)"/.exec(readFileSync(release, 'utf8'))?.[1] : undefined;
  const major = version ? Number(version.startsWith('1.') ? version.split('.')[1] : version.split('.')[0]) : NaN;
  if (!(major >= 17)) fail(`JDK w ${home} ma wersję ${version ?? '?'} — Maestro potrzebuje ≥ 17 (MAESTRO_JAVA_HOME).`);
  return home;
}

function adbPath(): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (WIN ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(homedir(), 'Android', 'Sdk'));
  const adb = join(sdk, 'platform-tools', WIN ? 'adb.exe' : 'adb');
  return existsSync(adb) ? adb : 'adb';
}

function maestroPath(): string {
  const bin = process.env.MAESTRO_BIN ?? join(homedir(), '.maestro', 'bin', WIN ? 'maestro.bat' : 'maestro');
  if (!existsSync(bin)) fail(`Brak Maestro CLI (${bin}) — instalacja: https://docs.maestro.dev/getting-started/installing-maestro`);
  return bin;
}

/** Sesja użytkownika z jednorazowego linku (hasło konta zostaje bez zmian). */
async function signInWithLink(email: string): Promise<Account> {
  const { data, error } = await adminClient().auth.admin.generateLink({ type: 'magiclink', email });
  if (error) fail(`generateLink ${email}: ${error.message}`);
  const { url, anonKey } = localSupabase();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: otpError } = await client.auth.verifyOtp({ type: 'magiclink', token_hash: data.properties.hashed_token });
  if (otpError || !auth.session) fail(`Logowanie ${email}: ${otpError?.message}`);
  return { id: auth.session.user.id, email, client, session: auth.session };
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Konto przed telefonem — bez lokalnego Supabase albo konta nie ma sensu zaczynać.
const admin = adminClient();
const { data: users, error: usersError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (usersError) fail(`listUsers: ${usersError.message}`);
const user = users.users.find((u) => u.email === EMAIL);
if (!user) fail(`Brak konta ${EMAIL} w lokalnym Supabase.`);
const { data: scopes } = await admin.from('scope_members').select('scope_id').eq('user_id', user.id);
const scopeIds = (scopes ?? []).map((s) => s.scope_id as string);

const adb = adbPath();
const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .slice(1)
  .filter((l) => /\tdevice\s*$/.test(l));
if (devices.length !== 1) fail(`Potrzebny dokładnie jeden telefon w \`adb devices\` (jest ${devices.length}).`);
execFileSync(adb, ['reverse', `tcp:${API_PORT}`, `tcp:${API_PORT}`]);

const start = new Date();
const remindAt = new Date(start.getTime() + 3 * 60_000);
if (localDate(remindAt) !== localDate(start)) fail('Przypomnienie wypadłoby po północy — uruchom za kilka minut.');
const today = localDate(start);
const run = start.getTime().toString(36).slice(-5);
const REMIND_AT = localTime(remindAt);
console.log(`Przebieg ${run}: zadania „Maestro ${run} …”, przypomnienie o ${REMIND_AT}. Telefonu nie dotykać (~5 min).`);

mkdirSync(OUT, { recursive: true });
const java = javaHome();
const result = spawnSync(
  maestroPath(),
  ['test', HERE, '--format', 'junit', '--output', join(OUT, 'report.xml'), '--test-output-dir', OUT, '-e', `RUN=${run}`, '-e', `REMIND_AT=${REMIND_AT}`],
  {
    stdio: 'inherit',
    shell: WIN,
    env: { ...process.env, JAVA_HOME: java, PATH: [join(java, 'bin'), join(adb, '..'), process.env.PATH].join(WIN ? ';' : ':') },
  },
);
if (result.status !== 0) fail(`Maestro zakończył się kodem ${result.status} — zrzuty i dziennik w ${OUT}; zadania przebiegu zostają.`);

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  due_date: string | null;
  due_time: string | null;
}

const listOurs = async (): Promise<TaskRow[]> => {
  const { data, error } = await admin
    .from('tasks')
    .select('id, title, status, priority, due_date, due_time')
    .in('scope_id', scopeIds)
    .like('title', 'Maestro %')
    .is('deleted_at', null);
  if (error) fail(`tasks: ${error.message}`);
  return (data as TaskRow[]).filter((t) => OURS.test(t.title));
};

// Serwer: wszystkie trzy zadania ukończone (synchronizacja w tle — czekamy do 30 s).
const expected: Record<string, (t: TaskRow) => string | null> = {
  [`Maestro ${run} A`]: (t) => (t.priority === 1 && t.due_date === '2020-01-02' ? null : `priorytet ${t.priority}, termin ${t.due_date}`),
  [`Maestro ${run} R`]: (t) => (t.due_date === today && t.due_time === REMIND_AT ? null : `termin ${t.due_date} ${t.due_time}`),
  [`Maestro ${run} Wid`]: (t) => (t.due_date === '2020-01-01' ? null : `termin ${t.due_date}`),
};
let problems: string[] = [];
for (let attempt = 0; attempt < 15; attempt++) {
  const rows = await listOurs();
  problems = [];
  for (const [title, check] of Object.entries(expected)) {
    const found = rows.filter((r) => r.title === title);
    if (found.length !== 1) problems.push(`„${title}”: ${found.length} wierszy na serwerze`);
    else if (found[0]!.status !== 'done') problems.push(`„${title}”: status ${found[0]!.status}`);
    else {
      const wrong = check(found[0]!);
      if (wrong) problems.push(`„${title}”: ${wrong}`);
    }
  }
  const reminderTask = rows.find((r) => r.title === `Maestro ${run} R`);
  if (reminderTask) {
    const { data: reminders } = await admin.from('reminders').select('kind, offset_min').eq('task_id', reminderTask.id).is('deleted_at', null);
    if (!(reminders ?? []).some((r) => r.kind === 'relative' && r.offset_min === 1)) problems.push(`„${reminderTask.title}”: brak przypomnienia 1 min przed`);
  }
  if (!problems.length) break;
  await new Promise((r) => setTimeout(r, 2000));
}
if (problems.length) fail(`Serwer:\n  ${problems.join('\n  ')}`);
console.log(`✓ Maestro i serwer: 3 zadania przebiegu ${run} ukończone (szybkie dodawanie + Dziś, przypomnienie, widżet).`);

if (!KEEP) {
  // Do kosza jak z urządzenia (`push_changes`, LWW) — telefon dostanie zmianę przy następnej synchronizacji.
  const leftovers = await listOurs();
  const at = new Date().toISOString();
  const rejected = await push(await signInWithLink(EMAIL), leftovers.map((t) => ({ table: 'tasks', id: t.id, patch: { deleted_at: at } })), 'maestro');
  if (rejected) fail(`Sprzątanie: ${rejected} odrzuconych operacji.`);
  console.log(`Kosz: ${leftovers.length} zadań „Maestro …”.`);
}
