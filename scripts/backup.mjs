#!/usr/bin/env node
/**
 * Zrzut bazy (`pg_dump`) i odtworzenie na lokalnym Supabase z porównaniem danych (Etap 13,
 * „Kopie zapasowe”). Używa go nocny workflow `.github/workflows/db-backup.yml` i ręczne
 * odtwarzanie — instrukcja w `docs/KOPIE_ZAPASOWE.md`.
 *
 *   node scripts/backup.mjs dump    --out <katalog> (--db-url <url> | --container <nazwa>)
 *   node scripts/backup.mjs restore --in <katalog>  (--db-url <url> | --container <nazwa>) [--force]
 *   node scripts/backup.mjs verify  [--source <kontener>] [--keep]
 *
 * `--db-url` — natywne `pg_dump`/`psql` (wersja ≥ serwera, w CI 17); adres bazy także ze zmiennej
 * `DATABASE_URL`. `--container` — narzędzia z kontenera bazy lokalnego Supabase (`docker exec`,
 * np. `supabase_db_taskplanner`), bez instalowania Postgresa na Windows. Adres bazy nie trafia do logów.
 *
 * Zrzut (katalog):
 *   data.sql        dane: wszystkie tabele `public` + `auth.users`, `auth.identities` (konta)
 *   schema.sql      schemat `public` (do wglądu; odtworzenie stawia schemat z `supabase/migrations`)
 *   checksums.json  liczba wierszy i skrót md5 każdej tabeli z danych — porównanie po odtworzeniu
 *   meta.json       chwila zrzutu, wersja serwera, lista zastosowanych migracji
 *
 * `restore` wymaga pustej bazy z tymi samymi migracjami (`npm run supabase -- db reset`), wgrywa
 * dane z wyłączonymi triggerami (`session_replication_role = replica` — `row_version`,
 * `field_clock` i znaczniki czasu zostają jak w zrzucie) i porównuje sumy kontrolne.
 * `verify` robi całość bez ruszania wspólnego lokalnego Supabase: zrzut z niego (tylko odczyt),
 * osobny, tymczasowy stos `taskplanner-restore` (porty 546xx, tylko baza i Auth), odtworzenie,
 * porównanie i zatrzymanie stosu (`--keep` zostawia go do obejrzenia).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE_CLI = 'supabase@2.122.0';
/** Tabele `auth` z kontami (sesje, tokeny odświeżania i dziennik audytu nie są potrzebne do odtworzenia). */
const AUTH_TABLES = ['auth.users', 'auth.identities'];
const RESTORE_PROJECT = 'taskplanner-restore';

// ── Argumenty ────────────────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) args[key] = true;
  else (args[key] = next), i++;
}

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

/** Cel połączenia: natywne narzędzia z adresem albo kontener lokalnego Supabase. */
function target(prefix = '') {
  const container = args[`${prefix}container`];
  const url = args[`${prefix}db-url`] ?? (prefix ? undefined : process.env.DATABASE_URL);
  if (container) return { container };
  if (url) return { url };
  fail(`Podaj --${prefix}db-url (albo DATABASE_URL) lub --${prefix}container.`);
}

// ── Uruchamianie pg_dump / psql ──────────────────────────────────────────────────────────────

/**
 * `tool` (pg_dump / psql) z argumentami; stdout do pliku albo zwrócony jako tekst, stdin z pliku.
 * Hasło do kontenera lokalnego to domyślne `postgres` z `supabase start`.
 */
function pg(db, tool, toolArgs, { stdout, stdin, input } = {}) {
  const [cmd, argv, env] = db.container
    ? ['docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', '-e', 'PGTZ=UTC', db.container, tool, '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', ...toolArgs], process.env]
    : [tool, [...toolArgs, '--dbname', db.url], { ...process.env, PGTZ: 'UTC' }];
  return new Promise((done, reject) => {
    const child = spawn(cmd, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    // Plik wyjściowy musi być domknięty, zanim ktoś go przeczyta.
    const written = stdout
      ? new Promise((ok, bad) => child.stdout.pipe(createWriteStream(stdout)).on('finish', ok).on('error', bad))
      : (child.stdout.on('data', (chunk) => (out += chunk)), Promise.resolve());
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (e) => reject(new Error(`${tool}: ${e.message}${db.container ? '' : ' (zainstaluj klienta PostgreSQL 17 albo użyj --container)'}`)));
    child.on('close', (code) =>
      code === 0 ? written.then(() => done(out), reject) : reject(new Error(`${tool} zakończył się kodem ${code}: ${err.trim().split('\n').slice(-5).join(' | ')}`)),
    );
    if (stdin) {
      if (input) child.stdin.write(input);
      const stream = createReadStream(stdin);
      stream.pipe(child.stdin);
    } else {
      child.stdin.end(input ?? '');
    }
  });
}

const sql = async (db, query) => (await pg(db, 'psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query])).trim();

/** Tabele z danymi zrzutu: wszystkie zwykłe tabele `public` i konta z `auth`. */
async function dumpedTables(db) {
  const rows = await sql(db, "select 'public.' || quote_ident(tablename) from pg_tables where schemaname = 'public' order by 1");
  return [...rows.split('\n').filter(Boolean), ...AUTH_TABLES];
}

/**
 * Liczba wierszy i md5 z posortowanych skrótów wierszy (niezależne od kolejności fizycznej;
 * tekst wiersza w strefie UTC — `PGTZ`). Jedno zapytanie na wszystkie tabele.
 */
async function checksums(db, tables) {
  const query = tables
    .map((t) => `select '${t}', count(*), coalesce(md5(string_agg(md5(r::text), ',' order by md5(r::text))), '') from ${t} r`)
    .join(' union all ');
  const out = {};
  for (const line of (await sql(db, query)).split('\n').filter(Boolean)) {
    const [table, rows, md5] = line.split('|');
    out[table] = { rows: Number(rows), md5 };
  }
  return out;
}

const migrations = async (db) => (await sql(db, 'select version from supabase_migrations.schema_migrations order by 1')).split('\n').filter(Boolean);

// ── dump ─────────────────────────────────────────────────────────────────────────────────────

async function dump(db, out) {
  mkdirSync(out, { recursive: true });
  const tables = await dumpedTables(db);
  const common = ['--no-owner', '--no-privileges', '--quote-all-identifiers'];
  // Sumy kontrolne przed i po zrzucie: równe = zrzut ma dokładnie te dane (pg_dump ma własną
  // migawkę). Zapis w trakcie (cron kalendarzy, przypomnienia) — zrzut jeszcze raz.
  let sums;
  for (let attempt = 1; ; attempt++) {
    const before = await checksums(db, tables);
    await pg(db, 'pg_dump', ['--data-only', ...common, ...['public.*', ...AUTH_TABLES].flatMap((t) => ['--table', t])], { stdout: join(out, 'data.sql') });
    const after = await checksums(db, tables);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      sums = after;
      break;
    }
    if (attempt === 3) fail('Dane zmieniały się w trakcie każdego z 3 zrzutów — spróbuj później.');
    console.warn(`! Dane zmieniły się w trakcie zrzutu — próba ${attempt + 1}.`);
  }
  await pg(db, 'pg_dump', ['--schema-only', '--schema', 'public', ...common], { stdout: join(out, 'schema.sql') });
  const meta = {
    createdAt: new Date().toISOString(),
    server: await sql(db, 'show server_version'),
    migrations: await migrations(db),
    tables,
  };
  writeFileSync(join(out, 'checksums.json'), `${JSON.stringify(sums, null, 2)}\n`);
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const total = Object.values(sums).reduce((sum, t) => sum + t.rows, 0);
  console.log(`✓ Zrzut: ${tables.length} tabel, ${total} wierszy → ${out}`);
  return { sums, meta };
}

// ── restore ──────────────────────────────────────────────────────────────────────────────────

async function restore(db, dir, { force = false } = {}) {
  for (const file of ['data.sql', 'checksums.json', 'meta.json']) if (!existsSync(join(dir, file))) fail(`Brak ${file} w ${dir}.`);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const expected = JSON.parse(readFileSync(join(dir, 'checksums.json'), 'utf8'));

  const have = await migrations(db);
  if (have.join() !== meta.migrations.join()) {
    const missing = meta.migrations.filter((m) => !have.includes(m));
    const extra = have.filter((m) => !meta.migrations.includes(m));
    const text = `Migracje bazy docelowej różnią się od zrzutu (brak: ${missing.join(', ') || '—'}; nadmiarowe: ${extra.join(', ') || '—'}). Odtwarzaj z checkoutu z tymi samymi migracjami.`;
    if (!force) fail(text);
    console.warn(`! ${text}`);
  }
  const used = Number(await sql(db, 'select (select count(*) from auth.users) + (select count(*) from public.sync_scopes)'));
  if (used > 0 && !force) fail('Baza docelowa nie jest pusta (konta albo zakresy) — najpierw `npm run supabase -- db reset` (kasuje lokalne dane).');

  // Triggery wyłączone: wiersze wchodzą z `row_version`, `field_clock` i znacznikami ze zrzutu.
  await pg(db, 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], {
    stdin: join(dir, 'data.sql'),
    input: 'set session_replication_role = replica;\n',
  });

  const actual = await checksums(db, Object.keys(expected));
  const differ = Object.keys(expected).filter((t) => actual[t]?.rows !== expected[t].rows || actual[t]?.md5 !== expected[t].md5);
  const total = Object.values(actual).reduce((sum, t) => sum + t.rows, 0);
  if (differ.length) {
    for (const t of differ) console.error(`  ${t}: zrzut ${expected[t].rows} wierszy, po odtworzeniu ${actual[t]?.rows ?? '—'}${actual[t]?.rows === expected[t].rows ? ' (inna treść)' : ''}`);
    fail(`Dane po odtworzeniu różnią się w ${differ.length} tabelach.`);
  }
  console.log(`✓ Odtworzono ${Object.keys(expected).length} tabel, ${total} wierszy — liczby i sumy kontrolne zgodne ze zrzutem (${meta.createdAt}).`);
}

// ── verify ───────────────────────────────────────────────────────────────────────────────────

/** Polecenie przez powłokę (`npx` na Windows to `.cmd`); argumenty w cudzysłowach. */
const run = (cmd, argv) =>
  new Promise((done, reject) => {
    const child = spawn([cmd, ...argv.map((a) => (/^[\w@.,:=/-]+$/.test(a) ? a : `"${a}"`))].join(' '), { stdio: 'inherit', shell: true });
    child.on('close', (code) => (code === 0 ? done() : reject(new Error(`${cmd} ${argv.slice(0, 3).join(' ')}… → kod ${code}`))));
  });

/** Kopia `supabase/` z innym `project_id` i portami 546xx — drugi, niezależny stos lokalny. */
function restoreProject(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'supabase'), { recursive: true });
  // Migracje i szablony maili z konfiguracji (bez funkcji — Edge Runtime nie startuje).
  for (const sub of ['migrations', 'templates']) cpSync(join(ROOT, 'supabase', sub), join(dir, 'supabase', sub), { recursive: true });
  const config = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8')
    .replace(/^project_id = .*$/m, `project_id = "${RESTORE_PROJECT}"`)
    .replace(/\b545(\d\d)\b/g, '546$1');
  writeFileSync(join(dir, 'supabase', 'config.toml'), config);
}

async function verify() {
  const source = { container: args.source ?? 'supabase_db_taskplanner' };
  const work = join(tmpdir(), 'taskplanner-backup-verify');
  const out = join(work, 'dump');
  const project = join(work, 'stack');
  rmSync(out, { recursive: true, force: true });
  await dump(source, out);

  restoreProject(project);
  const exclude = ['realtime', 'storage-api', 'imgproxy', 'kong', 'mailpit', 'postgrest', 'postgres-meta', 'studio', 'edge-runtime', 'logflare', 'vector', 'supavisor'];
  console.log(`… Tymczasowy stos ${RESTORE_PROJECT} (baza + Auth, porty 546xx)`);
  await run('npx', ['--yes', SUPABASE_CLI, 'start', '--workdir', project, '-x', exclude.join(',')]);
  try {
    await restore({ container: `supabase_db_${RESTORE_PROJECT}` }, out);
  } finally {
    if (args.keep) console.log(`Stos zostaje: npx ${SUPABASE_CLI} stop --workdir "${project}" --no-backup`);
    else await run('npx', ['--yes', SUPABASE_CLI, 'stop', '--workdir', project, '--no-backup']).catch((e) => console.warn(`! ${e.message}`));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

try {
  if (command === 'dump') {
    if (!args.out) fail('Podaj --out <katalog>.');
    await dump(target(), resolve(args.out));
  } else if (command === 'restore') {
    if (!args.in) fail('Podaj --in <katalog>.');
    await restore(target(), resolve(args.in), { force: !!args.force });
  } else if (command === 'verify') {
    await verify();
  } else {
    fail('Użycie: node scripts/backup.mjs dump|restore|verify … (opis na początku pliku).');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
