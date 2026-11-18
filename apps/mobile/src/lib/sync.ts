/**
 * Lokalna baza telefonu (expo-sqlite) i silnik synchronizacji (PoC-1). Ekrany powstają w MVP-3;
 * tu tylko podłączenie, sprawdzane typami i ręcznie na dev buildzie.
 */
import './polyfills';

import { supabaseRemote, SyncEngine } from '@taskplanner/sync';
import { openExpoDb } from '@taskplanner/sync/expo';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openDatabaseAsync } from 'expo-sqlite';

let supabase: SupabaseClient | null = null;

export function supabaseClient(): SupabaseClient {
  if (!supabase) {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('Brak EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (npm run mobile).');
    supabase = createClient(url, key);
  }
  return supabase;
}

export async function openSyncEngine(userId: string): Promise<SyncEngine> {
  const db = await openExpoDb(await openDatabaseAsync('taskplanner.db'));
  const engine = await SyncEngine.open({ db, remote: supabaseRemote(supabaseClient()), userId });
  engine.start();
  return engine;
}
