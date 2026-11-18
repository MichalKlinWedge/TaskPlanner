/**
 * `npm run dev:user` — konto deweloperskie w LOKALNYM Supabase (`dev@taskplanner.test`).
 * Hasło: `DEV_USER_PASSWORD` z głównego `.env.local`; bez niego — nowe, dopisane do `.env.local`
 * (plik poza repozytorium). Konto już istnieje → nic się nie dzieje. Hasła nie wypisuje.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = `${root}.env.local`;
const EMAIL = 'dev@taskplanner.test';

const env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
let password = /^DEV_USER_PASSWORD=(.+)$/m.exec(env)?.[1]?.trim();
if (!password) {
  password = randomBytes(12).toString('base64url');
  appendFileSync(envFile, `${env.endsWith('\n') || env === '' ? '' : '\n'}# Konto deweloperskie lokalnego Supabase (npm run dev:user)\nDEV_USER_EMAIL=${EMAIL}\nDEV_USER_PASSWORD=${password}\n`);
}

const raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const status = JSON.parse(raw.slice(raw.indexOf('{')));
const admin = createClient(status.API_URL, status.SECRET_KEY ?? status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { error } = await admin.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
if (error && !/already|registered|exists/i.test(error.message)) throw error;
console.log(error ? `${EMAIL}: już istnieje` : `${EMAIL}: utworzone (hasło w .env.local: DEV_USER_PASSWORD)`);
