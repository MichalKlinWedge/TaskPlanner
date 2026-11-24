/**
 * Ten telefon na liście urządzeń z przypomnieniami (M8, wiersz `devices`, `platform = 'android'`), tak jak
 * przeglądarki na webie: kanał można wyłączyć tu albo w Ustawieniach na komputerze, a wtedy telefon nie
 * planuje przypomnień (bez dubli z Web Push). Wiersz powstaje po udanej synchronizacji — wcześniej nie
 * wiadomo, czy serwer już go nie ma (ponowne logowanie) z wyłączonym kanałem. Usunięty z listy na webie =
 * przypomnienia wyłączone, dopóki nie włączy się ich na telefonie.
 */
import { uuidv7 } from '@taskplanner/core';
import type { SyncEngine } from '@taskplanner/sync';
import * as Notifications from 'expo-notifications';
import Storage from 'expo-sqlite/kv-store';
import { Platform } from 'react-native';

import { sessionUser } from './config';
import { localEngine, mutate, onSessionChange, onSynced } from './sync';

/** Id tego telefonu dla konta (jeden wiersz `devices`); przeżywa wylogowanie. */
function deviceId(userId: string): string {
  const key = `device.id.${userId}`;
  const existing = Storage.getItemSync(key);
  if (existing) return existing;
  const id = uuidv7();
  Storage.setItemSync(key, id);
  return id;
}

function deviceName(): string {
  const { Brand, Model } = Platform.constants as { Brand?: string; Model?: string };
  const brand = Brand ? Brand.charAt(0).toUpperCase() + Brand.slice(1) : '';
  const model = Model ?? '';
  return (model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`).trim().slice(0, 100) || 'Telefon';
}

/** Czy przypomnienia mają przychodzić na ten telefon; bez wiersza (tryb offline, przed synchronizacją) — tak. */
export async function phoneRemindersOn(engine: SyncEngine): Promise<boolean> {
  const row = await engine.get('devices', deviceId(engine.userId));
  return !row || (!row.deleted_at && row.reminder_channel === 'enabled');
}

export async function setPhoneReminders(enabled: boolean): Promise<void> {
  await mutate('devices', deviceId(sessionUser().id), {
    name: deviceName(),
    platform: 'android',
    reminder_channel: enabled ? 'enabled' : 'disabled',
    push_subscription: null,
    ...(enabled && { deleted_at: null }),
  });
}

async function registerDevice() {
  const user = sessionUser();
  if (Platform.OS !== 'android' || !user.online) return;
  const engine = await localEngine();
  if (engine.userId !== user.id || (await engine.get('devices', deviceId(user.id)))) return;
  // Bez zgody systemu telefon nie przypomina — nie udaje na liście, że tak.
  if (!(await Notifications.getPermissionsAsync()).granted) return;
  await setPhoneReminders(true);
}

/** Rejestracja po synchronizacji i `onChange` po każdej zmianie urządzeń (przełącznik na webie). */
export function startDevice(onChange: () => void): () => void {
  let alive = true;
  let unwatch: (() => void) | undefined;
  const attach = () => {
    localEngine()
      .then((engine) => {
        if (!alive) return;
        unwatch?.();
        unwatch = engine.watch(['devices'], onChange);
      })
      .catch((error) => console.warn('urządzenie', error));
  };
  attach();
  const offSession = onSessionChange(attach);
  const offSynced = onSynced(() => void registerDevice().catch((error) => console.warn('urządzenie', error)));
  return () => {
    alive = false;
    unwatch?.();
    offSession();
    offSynced();
  };
}
