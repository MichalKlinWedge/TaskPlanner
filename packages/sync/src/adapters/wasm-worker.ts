/**
 * Strona workera lokalnej bazy w przeglądarce: SQLite WASM z VFS `opfs-sahpool` (trwały, bez
 * nagłówków COOP/COEP). VFS daje dostęp wyłączny — worker działa tylko w karcie-liderze
 * (`tabs.ts`). Bez OPFS (tryb prywatny, stara przeglądarka) — baza w pamięci, `persistent: false`.
 *
 * Aplikacja tworzy własny plik workera i podaje, skąd wziąć moduł SQLite — na webie z plików
 * statycznych, bez bundlera (Turbopack nie radzi sobie z `@sqlite.org/sqlite-wasm`):
 *   startSqliteWorker(() => import(/* turbopackIgnore: true *\/ '/sqlite-wasm/index.mjs').then((m) => m.default));
 */
import type sqlite3InitModuleType from '@sqlite.org/sqlite-wasm';

import type { SqlValue } from '../local-db.ts';

export type SqliteInit = typeof sqlite3InitModuleType;

export type WorkerRequest =
  | { id: number; type: 'open'; name: string }
  | { id: number; type: 'all' | 'run'; sql: string; params: SqlValue[] };

export type WorkerResponse = { id: number; result?: unknown; error?: string };

export interface OpenResult {
  persistent: boolean;
  reason?: string;
}

interface Db {
  exec(options: { sql: string; bind?: SqlValue[]; rowMode?: 'object'; returnValue?: 'resultRows' }): unknown;
}

export function startSqliteWorker(loadSqlite: () => Promise<SqliteInit>) {
  const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: WorkerResponse): void;
  };
  let db: Db | null = null;

  async function open(name: string): Promise<OpenResult> {
    const sqlite3 = await (await loadSqlite())();
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({});
      db = new pool.OpfsSAHPoolDb(`/${name}.sqlite3`) as unknown as Db;
      return { persistent: true };
    } catch (error) {
      db = new sqlite3.oo1.DB(':memory:') as unknown as Db;
      return { persistent: false, reason: String(error) };
    }
  }

  scope.onmessage = async (event) => {
    const request = event.data;
    try {
      let result: unknown;
      if (request.type === 'open') result = await open(request.name);
      else if (!db) throw new Error('Baza nie jest otwarta.');
      else if (request.type === 'all') {
        result = db.exec({ sql: request.sql, bind: request.params.length ? request.params : undefined, rowMode: 'object', returnValue: 'resultRows' });
      } else {
        db.exec({ sql: request.sql, bind: request.params.length ? request.params : undefined });
      }
      scope.postMessage({ id: request.id, result });
    } catch (error) {
      scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
