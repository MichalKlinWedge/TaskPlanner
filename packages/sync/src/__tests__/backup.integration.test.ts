/**
 * Kopia JSON na lokalnym Supabase (Etap 13): eksport → wyczyszczona lokalna baza → import
 * przechodzi przez `push_changes` bez odrzuceń i daje te same dane; po utracie konta na serwerze
 * kopia wraca na nowe konto (zakres osobisty przeniesiony), a nowe urządzenie pobiera to samo.
 * `npm run test:sync` (wymaga `npm run supabase -- start`).
 */
import { compareBackups, readBackup, type Backup } from '@taskplanner/core';
import { afterEach, describe, expect, it } from 'vitest';

import { applyBackupPlan, exportBackup, planBackupImport } from '../backup.ts';
import { createDevice, createUser, deleteUser, type Device, type TestUser } from './helpers/devices.ts';
import { fillSample } from './helpers/sample-data.ts';

const devices: Device[] = [];
const open = async (user: TestUser, name: string) => {
  const device = await createDevice(user, name);
  devices.push(device);
  return device;
};

afterEach(async () => {
  for (const device of devices.splice(0)) await device.close();
});

const query = (device: Device) => device.engine.db.all.bind(device.engine.db);
const exportFile = async (device: Device, user: TestUser): Promise<Backup> => readBackup(JSON.parse(JSON.stringify(await exportBackup(query(device), user.id)))).backup;

/** Bez kosza — pełna migawka `pull_changes` nie wysyła usuniętych wierszy. */
const live = (b: Backup): Backup => ({ ...b, tables: Object.fromEntries(Object.entries(b.tables).map(([t, rows]) => [t, rows.filter((r) => !r.deleted_at)])) as Backup['tables'] });

async function restore(device: Device, user: TestUser, backup: Backup) {
  const plan = await planBackupImport(query(device), backup, user.id);
  await applyBackupPlan((ops) => device.engine.mutateMany(ops), plan);
  await device.engine.sync();
  return plan;
}

describe('Etap 13: kopia JSON przez push_changes', () => {
  it('eksport → wyczyszczona lokalna baza → import: te same dane, bez odrzuceń, drugi import bez zmian', async () => {
    const user = await createUser('kopia');
    const phone = await open(user, 'phone');
    await fillSample(phone.engine, user.id);
    await phone.engine.sync();
    const backup = await exportFile(phone, user);
    expect(backup.tables.tasks.length).toBeGreaterThan(4);

    // Nowa przeglądarka bez pobrania = wyczyszczona lokalna baza.
    const web = await open(user, 'web');
    const plan = await restore(web, user, backup);
    expect(plan.stats.tasks.added).toBe(backup.tables.tasks.length);
    expect(web.rejected).toEqual([]);
    expect(await web.engine.pendingCount()).toBe(0);
    expect(compareBackups(backup, await exportFile(web, user))).toEqual([]);
    expect((await planBackupImport(query(web), backup, user.id)).ops).toEqual([]);

    // Serwer ma to samo: trzecie urządzenie pobiera od zera.
    const tablet = await open(user, 'tablet');
    await tablet.engine.sync();
    const pulled = await exportFile(tablet, user);
    expect(compareBackups(live(backup), pulled)).toEqual([]);
  });

  it('utrata konta na serwerze: kopia wraca na nowe konto, nowe urządzenie pobiera te same dane', async () => {
    const old = await createUser('stare');
    const phone = await open(old, 'phone');
    await fillSample(phone.engine, old.id);
    await phone.engine.sync();
    const backup = await exportFile(phone, old);
    await deleteUser(old.id);

    const fresh = await createUser('nowe');
    const web = await open(fresh, 'web');
    await web.engine.sync();
    const plan = await restore(web, fresh, backup);
    expect(plan.otherAccount).toBe(true);
    expect(web.rejected).toEqual([]);

    const tablet = await open(fresh, 'tablet');
    await tablet.engine.sync();
    const pulled = await exportFile(tablet, fresh);
    expect(pulled.userId).toBe(fresh.id);
    // Usunięte wiersze też wróciły na serwer — pełna migawka ich nie wysyła, więc porównanie bez kosza;
    // `calendar_sync` profilu nie przechodzi na inne konto.
    expect(compareBackups(live(backup), pulled).filter((d) => d.field !== 'calendar_sync')).toEqual([]);
    const trashed = backup.tables.tasks.find((t) => t.deleted_at)!;
    const { data } = await tablet.client.from('tasks').select('id, deleted_at').eq('id', trashed.id).single();
    expect(data?.deleted_at).not.toBeNull();
  });
});
