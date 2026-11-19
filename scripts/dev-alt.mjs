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
 *   node scripts/dev-alt.mjs --local --port 3011 --prod   — `next build` + `next start` (Service Worker działa tylko tu)
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
// Przez cały czas działania (build też dopisuje ścieżki typów).
setInterval(() => {
  if (!readFileSync(tsconfig).equals(original)) writeFileSync(tsconfig, original);
}, 1000);

const run = (script, extra) =>
  new Promise((resolve) => {
    const child = spawn('npm', ['run', script, '--workspace', 'apps/web', '--', ...extra], { cwd: root, env, stdio: 'inherit', shell: true });
    child.on('exit', (code) => resolve(code ?? 0));
  });

if (args.includes('--prod')) {
  const built = await run('build', []);
  if (built !== 0) process.exit(built);
  process.exit(await run('start', ['-p', port]));
} else {
  process.exit(await run('dev', ['-p', port]));
}
