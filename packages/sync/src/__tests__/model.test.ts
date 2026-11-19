/**
 * Schematy wierszy z `@taskplanner/core` (`MODEL`) mają dokładnie kolumny tabel synchronizowanych
 * (`TABLES`) plus `id` — nowa kolumna w migracji musi trafić i tu, i tam.
 */
import { MODEL } from '@taskplanner/core';
import { describe, expect, it } from 'vitest';

import { SYNCED_TABLES, TABLES } from '../specs.ts';

describe('MODEL ↔ TABLES', () => {
  it.each(SYNCED_TABLES.filter((t) => t in MODEL))('%s', (table) => {
    const schema = MODEL[table as keyof typeof MODEL];
    expect(Object.keys(schema.shape).sort()).toEqual(['id', ...TABLES[table].columns].sort());
  });

  it('każda tabela synchronizowana ma schemat', () => {
    expect(SYNCED_TABLES.filter((t) => !(t in MODEL))).toEqual([]);
  });
});
