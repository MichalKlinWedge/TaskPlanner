/**
 * Adres serwera i zalogowany użytkownik w `expo-sqlite/kv-store` (synchronicznie, działa też
 * w zadaniu w tle bez ekranu). Adres domyślnie z `EXPO_PUBLIC_SUPABASE_*` (build lokalny, `.env.local`),
 * a bez nich — produkcyjny projekt w chmurze (`CLOUD_SERVER`), więc APK z GitHub Actions loguje się od
 * razu. Można go zmienić w aplikacji (telefon nie widzi 127.0.0.1 komputera — lokalny Supabase przez
 * `adb reverse` albo IP w LAN).
 */
import Storage from 'expo-sqlite/kv-store';

const KEYS = { url: 'server.url', key: 'server.key', userId: 'session.userId', email: 'session.email' } as const;

/** Użytkownik bez konta (tryb offline PoC): zapisy zostają w outboxie, nic nie jest wysyłane. */
export const OFFLINE_USER_ID = '00000000-0000-4000-8000-000000000001';

export interface ServerConfig {
  url: string;
  key: string;
}

/**
 * Produkcyjny Supabase (projekt `sakjrlpfbclcjlnpjcrt`). Klucz „publishable” jest publiczny z założenia
 * (ten sam jest w bundlu weba) — dostęp do danych chronią RLS i logowanie.
 */
export const CLOUD_SERVER: ServerConfig = {
  url: 'https://sakjrlpfbclcjlnpjcrt.supabase.co',
  key: 'sb_publishable_3srH-dGVsfBkJNCzlLqJZg__9gFYEFL',
};

export interface SessionUser {
  id: string;
  email: string | null;
  online: boolean;
}

export function serverConfig(): ServerConfig | null {
  const env = process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ? { url: process.env.EXPO_PUBLIC_SUPABASE_URL, key: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY } : CLOUD_SERVER;
  const url = Storage.getItemSync(KEYS.url) || env.url;
  const key = Storage.getItemSync(KEYS.key) || env.key;
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

// ── Narzędzia PoC ─────────────────────────────────────────────────────────────────────────────

const DEV_TOOLS_KEY = 'devTools.enabled';
const devToolsListeners = new Set<() => void>();

/**
 * Czy „Narzędzia PoC” są widoczne w „Przeglądaj”. Domyślnie ukryte (zmieniają dane — np. tryb
 * widżetu dodaje przykładowe zadania), w buildzie deweloperskim zawsze widoczne; włącza je
 * siedmiokrotne stuknięcie numeru wersji w Ustawieniach → „Aktualizacje”. Trasy (`/dev`,
 * `taskplanner://widget` itd.) działają niezależnie — używa ich Maestro.
 */
export const devToolsEnabled = (): boolean => __DEV__ || Storage.getItemSync(DEV_TOOLS_KEY) === '1';

export function setDevToolsEnabled(enabled: boolean): void {
  if (enabled) Storage.setItemSync(DEV_TOOLS_KEY, '1');
  else Storage.removeItemSync(DEV_TOOLS_KEY);
  for (const listener of devToolsListeners) listener();
}

export function onDevToolsChange(listener: () => void): () => void {
  devToolsListeners.add(listener);
  return () => devToolsListeners.delete(listener);
}
