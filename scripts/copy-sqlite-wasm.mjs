#!/usr/bin/env node
/**
 * SQLite WASM jako pliki statyczne weba (`apps/web/public/sqlite-wasm/`), ładowane w workerze
 * przez `import()` bez bundlera: Turbopack nie rozwiązuje dynamicznego `new Worker(new URL(...))`
 * w `@sqlite.org/sqlite-wasm` (proxy VFS „opfs”, którego nie używamy — mamy `opfs-sahpool`).
 * Uruchamiane przed `next dev` / `next build`. Katalog docelowy jest w .gitignore.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = dirname(createRequire(join(root, 'packages/sync/package.json')).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));
const target = join(root, 'apps/web/public/sqlite-wasm');
mkdirSync(target, { recursive: true });
for (const file of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js', 'sqlite3-worker1.mjs']) {
  copyFileSync(join(dist, file), join(target, file));
}
console.log(`sqlite-wasm → ${target}`);
