#!/usr/bin/env node
/**
 * Drugi serwer `next dev` obok już działającego w tym samym katalogu (np. równoległa sesja):
 * własny port i katalog wyników (`NEXT_DIST_DIR` → `.next-<port>`), bez nadpisywania
 * `apps/web/.env.local`. `--local` = lokalny Supabase — adres i klucz publiczny z `supabase status`
 * jako zmienne procesu (mają pierwszeństwo przed plikami env). Next przy starcie dopisuje
 * `.next-<port>/types` do `apps/web/tsconfig.json` (i zmienia mu końce linii) — skrypt przywraca
 * plik, gdy tylko to zrobi (sprawdza tylko przy starcie, więc nie dopisze ponownie).
 *
 *   node scripts/dev-alt.mjs --local --port 3010
 */
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const port = args[args.indexOf('--port') + 1] ?? '3010';
const env = { ...process.env, NEXT_DIST_DIR: `.next-${port}` };

if (args.includes('--local')) {
  const raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(raw.slice(raw.indexOf('{')));
  env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
}

const tsconfig = `${root}apps/web/tsconfig.json`;
const original = readFileSync(tsconfig);
const guard = setInterval(() => {
  if (!readFileSync(tsconfig).equals(original)) writeFileSync(tsconfig, original);
}, 1000);
setTimeout(() => clearInterval(guard), 180_000).unref();

const child = spawn('npm', ['run', 'dev', '--workspace', 'apps/web', '--', '-p', port], { cwd: root, env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
