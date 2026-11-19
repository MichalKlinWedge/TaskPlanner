/**
 * Adres serwera i zalogowany użytkownik w `expo-sqlite/kv-store` (synchronicznie, działa też
 * w zadaniu w tle bez ekranu). Adres domyślnie z `EXPO_PUBLIC_SUPABASE_*`; na PoC można go
 * zmienić w aplikacji (telefon nie widzi 127.0.0.1 komputera — lokalny Supabase przez IP w LAN).
 */
import Storage from 'expo-sqlite/kv-store';

const KEYS = { url: 'server.url', key: 'server.key', userId: 'session.userId', email: 'session.email' } as const;

/** Użytkownik bez konta (tryb offline PoC): zapisy zostają w outboxie, nic nie jest wysyłane. */
export const OFFLINE_USER_ID = '00000000-0000-4000-8000-000000000001';

export interface ServerConfig {
  url: string;
  key: string;
}

export interface SessionUser {
  id: string;
  email: string | null;
  online: boolean;
}

export function serverConfig(): ServerConfig | null {
  const url = Storage.getItemSync(KEYS.url) || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = Storage.getItemSync(KEYS.key) || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null;
}

export function saveServerConfig({ url, key }: ServerConfig) {
  Storage.setItemSync(KEYS.url, url.trim());
  Storage.setItemSync(KEYS.key, key.trim());
}

export function sessionUser(): SessionUser {
  const id = Storage.getItemSync(KEYS.userId);
  return id ? { id, email: Storage.getItemSync(KEYS.email), online: true } : { id: OFFLINE_USER_ID, email: null, online: false };
}

export function saveSessionUser(user: { id: string; email: string | null } | null) {
  if (!user) {
    Storage.removeItemSync(KEYS.userId);
    Storage.removeItemSync(KEYS.email);
    return;
  }
  Storage.setItemSync(KEYS.userId, user.id);
  if (user.email) Storage.setItemSync(KEYS.email, user.email);
}

/** Wartość JSON w kv-store (wyniki pomiarów PoC). */
export function readJson<T>(key: string, fallback: T): T {
  const raw = Storage.getItemSync(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  Storage.setItemSync(key, JSON.stringify(value));
}
