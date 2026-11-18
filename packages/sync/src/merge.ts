/**
 * Kodowanie wierszy (serwer ↔ lokalna baza) i scalanie per pole po HLC (SPECYFIKACJA §6).
 * Czyste funkcje — ta sama reguła co w `push_changes`: pole z nowszym HLC wygrywa.
 */
import type { SqlRow, SqlValue } from './local-db.ts';
import { localColumns, TABLES, writableFields, type SyncedTable } from './specs.ts';

export type RemoteRow = Record<string, unknown>;
export type FieldClock = Record<string, string>;

const toSql = (value: unknown): SqlValue => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || value instanceof Uint8Array) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return JSON.stringify(value);
};

/** Wartość pola do zapisu lokalnego (`jsonb` → tekst JSON). */
export function encodeValue(table: SyncedTable, column: string, value: unknown): SqlValue {
  if ((TABLES[table].json as readonly string[]).includes(column) || column === 'field_clock') {
    return value === undefined || value === null ? (column === 'field_clock' ? '{}' : null) : JSON.stringify(value);
  }
  return toSql(value);
}

/** Wiersz z serwera → wiersz lokalny (tylko znane kolumny). */
export function encodeRow(table: SyncedTable, row: RemoteRow): SqlRow {
  const out: SqlRow = {};
  for (const column of localColumns(table)) out[column] = encodeValue(table, column, row[column]);
  return out;
}

/** Wiersz lokalny → obiekt dla UI (`jsonb` odczytane). */
export function decodeRow<T = RemoteRow>(table: SyncedTable, row: SqlRow): T {
  const out: RemoteRow = { ...row };
  for (const column of [...TABLES[table].json, 'field_clock']) {
    const value = row[column];
    out[column] = typeof value === 'string' ? JSON.parse(value) : value;
  }
  return out as T;
}

export const parseClock = (value: SqlValue | unknown): FieldClock =>
  typeof value === 'string' ? (JSON.parse(value) as FieldClock) : ((value ?? {}) as FieldClock);

/** Większy HLC każdego pola z obu zegarów. */
export function mergeClocks(a: FieldClock, b: FieldClock): FieldClock {
  const out: FieldClock = { ...a };
  for (const [field, hlc] of Object.entries(b)) if (hlc && (!out[field] || hlc > out[field]!)) out[field] = hlc;
  return out;
}

/**
 * Scal wiersz z serwera z lokalnym. Pole zostaje lokalne tylko wtedy, gdy jego HLC jest ściśle
 * nowszy (zmiana w outboxie, jeszcze niewysłana); remis = serwer (np. pole wyliczone przez trigger
 * mimo zapisu klienta). Kolumny systemowe zawsze z serwera. `localWon` mówi, czy coś zostało lokalne.
 */
export function mergeRemote(table: SyncedTable, local: SqlRow | undefined, remote: RemoteRow): { row: SqlRow; localWon: boolean } {
  const encoded = encodeRow(table, remote);
  if (!local) return { row: encoded, localWon: false };
  const localClock = parseClock(local.field_clock);
  const remoteClock = parseClock(remote.field_clock);
  let localWon = false;
  for (const field of writableFields(table)) {
    if ((localClock[field] ?? '') > (remoteClock[field] ?? '')) {
      encoded[field] = local[field] ?? null;
      localWon = true;
    }
  }
  encoded.field_clock = JSON.stringify(mergeClocks(localClock, remoteClock));
  return { row: encoded, localWon };
}
