/**
 * Lokalna baza w Node (`node:sqlite`): testy integracyjne i narzędzia. Nie importować w aplikacjach.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { createLocalDb, type LocalDb, type SqlRow } from '../local-db.ts';

export function openNodeDb(path = ':memory:'): LocalDb & { close(): void } {
  const db = new DatabaseSync(path);
  const local = createLocalDb({
    all: (sql, params) => db.prepare(sql).all(...(params as SQLInputValue[])) as SqlRow[],
    run: (sql, params) => db.prepare(sql).run(...(params as SQLInputValue[])),
  });
  return Object.assign(local, { close: () => db.close() });
}
