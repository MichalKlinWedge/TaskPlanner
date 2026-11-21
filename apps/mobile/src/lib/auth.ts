/**
 * Logowanie (M1): link z maila (magic link) i Google, oba w przepływie PKCE. Powrót przychodzi
 * na deep link `taskplanner://auth-callback?code=…` — z Chrome Custom Tab (Google, wynik
 * `openAuthSessionAsync`) albo z przeglądarki po kliknięciu linku w mailu (ekran `auth-callback`).
 * Ten sam kod może dotrzeć obiema drogami naraz, a wymienić go można tylko raz — stąd `pending`.
 * Android oddaje też stary adres jeszcze raz jako adres początkowy (przeładowanie JS, powrót z
 * „Ostatnich” po ubiciu procesu, gdy aplikację otworzył link) — kod już wymieniony na tym
 * urządzeniu jest więc zapamiętany (`USED_CODES`) i ponowny powrót z nim kończy się bez błędu.
 *
 * Na lokalnym Supabase link z maila wskazuje na adres serwera z `config.toml`; gdy telefon go nie
 * widzi, zostaje sześciocyfrowy kod z tego samego maila (`verifyEmailCode`).
 */
import type { User } from '@supabase/supabase-js';
import { authErrorMessage } from '@taskplanner/core';
import * as Linking from 'expo-linking';
import Storage from 'expo-sqlite/kv-store';
import * as WebBrowser from 'expo-web-browser';

import { saveSessionUser, sessionUser } from './config';
import { scheduleReminders } from './scheduler';
import { notifySessionChange, resetLocal, startOnlineSync, supabaseClient } from './sync';
import { refreshWidgets } from '../widget/refresh';

/** `taskplanner://auth-callback` (schemat z `app.json`; w dev buildzie i w release taki sam). */
export const authRedirectUrl = () => Linking.createURL('auth-callback');

/** Błąd Supabase Auth (albo sieci) jako `Error` z komunikatem po polsku (`AUTH_ERROR` z core). */
export const authError = (error: unknown): Error =>
  new Error(authErrorMessage(typeof error === 'object' && error ? (error as { code?: string; message?: string; name?: string }) : String(error)));

/** Wywołanie Supabase Auth: odrzucenie z sieci i błąd z odpowiedzi kończą się tym samym polskim komunikatem. */
async function auth<T extends { error: unknown }>(call: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await call();
  } catch (error) {
    throw authError(error);
  }
  if (result.error) throw authError(result.error);
  return result;
}

export async function sendMagicLink(email: string): Promise<void> {
  await auth(() => supabaseClient().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: authRedirectUrl() } }));
}

/** Kod z maila zamiast linku (ten sam mail; przydatne, gdy link wskazuje adres niewidoczny z telefonu). */
export async function verifyEmailCode(email: string, code: string): Promise<User> {
  const { data } = await auth(() => supabaseClient().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' }));
  if (!data.user) throw new Error('Serwer nie zwrócił użytkownika.');
  return signedIn(data.user);
}

/** Google przez Chrome Custom Tab; `null`, gdy użytkownik zamknął okno. */
export async function signInWithGoogle(): Promise<User | null> {
  const redirectTo = authRedirectUrl();
  const { data } = await auth(() => supabaseClient().auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } }));
  if (!data.url) throw new Error('Serwer nie zwrócił adresu logowania Google.');
  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return null;
  return completeAuthFromUrl(result.url);
}

export interface AuthCallbackParams {
  code?: string;
  error?: string;
  /** Kod GoTrue (np. `otp_expired`) — dokładniejszy niż `error` (`access_denied`). */
  error_code?: string;
  error_description?: string;
}

/** Parametry z adresu powrotu: zapytanie i (przy błędach starego przepływu) fragment po `#`. */
export function authParams(url: string): AuthCallbackParams {
  const out: Record<string, string> = {};
  const [rest, hash = ''] = url.split('#');
  const query = rest!.includes('?') ? rest!.slice(rest!.indexOf('?') + 1) : '';
  for (const part of [query, hash]) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const [key, value = ''] = pair.split('=');
      out[decodeURIComponent(key!)] = decodeURIComponent(value.replace(/\+/g, ' '));
    }
  }
  return out;
}

export const completeAuthFromUrl = (url: string) => completeAuth(authParams(url));

const pending = new Map<string, Promise<User>>();

const USED_CODES = 'auth.usedCodes';
const usedCodes = (): string[] => {
  try {
    return JSON.parse(Storage.getItemSync(USED_CODES) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const rememberCode = (code: string) => Storage.setItemSync(USED_CODES, JSON.stringify([code, ...usedCodes().filter((c) => c !== code)].slice(0, 20)));

/**
 * Wymiana kodu PKCE na sesję (raz na kod, nawet gdy powrót przyszedł dwiema drogami).
 * `null` — ten kod był już wymieniony na tym urządzeniu (stary adres powrotu), nic do zrobienia.
 */
export function completeAuth(params: AuthCallbackParams): Promise<User | null> {
  if (params.error || params.error_code || params.error_description) {
    return Promise.reject(authError({ code: params.error_code || params.error, message: params.error_description || params.error }));
  }
  const code = params.code;
  if (!code) return Promise.reject(new Error('W adresie powrotu nie ma kodu logowania.'));
  let job = pending.get(code);
  if (!job && usedCodes().includes(code)) return Promise.resolve(null);
  if (!job) {
    job = (async () => {
      const { data } = await auth(() => supabaseClient().auth.exchangeCodeForSession(code));
      if (!data.user) throw new Error('Serwer nie zwrócił użytkownika.');
      rememberCode(code);
      return signedIn(data.user);
    })();
    pending.set(code, job);
  }
  return job;
}

/** Po zalogowaniu: inne konto niż dotąd (albo tryb offline) → czyste dane lokalne, potem synchronizacja. */
async function signedIn(user: User): Promise<User> {
  if (sessionUser().id !== user.id) await resetLocal().catch(() => undefined);
  saveSessionUser({ id: user.id, email: user.email ?? null });
  notifySessionChange();
  await startOnlineSync();
  return user;
}

/**
 * Usunięcie konta ze wszystkimi danymi na serwerze (Edge Function `account-delete`; potwierdzeniem
 * jest adres e-mail konta), potem wylogowanie z czyszczeniem danych telefonu.
 */
export async function deleteAccount(email: string): Promise<void> {
  const { error } = await supabaseClient().functions.invoke('account-delete', { body: { email: email.trim() } });
  if (error) {
    const context = (error as { context?: Response }).context;
    const body = context ? ((await context.json().catch(() => null)) as { error?: string } | null) : null;
    throw new Error(body?.error ?? error.message);
  }
  await signOut();
}

export async function signOut() {
  await supabaseClient()
    .auth.signOut()
    .catch(() => undefined);
  await resetLocal().catch(() => undefined);
  saveSessionUser(null);
  notifySessionChange();
  // `resetLocal` czyści bazę z pominięciem silnika — słuchacze danych o tym nie wiedzą, a przypomnienia
  // i widżet starego konta zostałyby w systemie. Przeliczenie z pustej bazy je usuwa.
  await scheduleReminders().catch(() => null);
  await refreshWidgets().catch(() => undefined);
}
