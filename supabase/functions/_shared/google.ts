/**
 * Google OAuth 2.0 i Calendar API v3 przez `fetch` (bez SDK). Adresy z konfiguracji, żeby testy mogły
 * podstawić fałszywe Google. Zakres tylko do odczytu (SPECYFIKACJA M18, Etap 5: odczyt).
 */
import { contentEtag, overlapsWindow, type EventRow, type SyncWindow } from './calendar.ts';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly'];
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
}

export const GOOGLE_DEFAULTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  apiBase: 'https://www.googleapis.com/calendar/v3',
};

/** Sekret konta w Vault (JSON). */
export interface GoogleSecret {
  refreshToken: string;
  accessToken?: string;
  /** ms od epoki */
  expiresAt?: number;
}

export class GoogleError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
  /** Token odświeżania odwołany albo wygasły — konto trzeba połączyć ponownie. */
  get revoked() {
    return this.reason === 'invalid_grant';
  }
  /** `syncToken` nieważny — pełna synchronizacja od nowa. */
  get gone() {
    return this.status === 410;
  }
}

async function failure(res: Response, what: string): Promise<GoogleError> {
  let reason = '';
  let message = `${what}: HTTP ${res.status}`;
  try {
    const body = await res.json();
    reason = body.error?.errors?.[0]?.reason ?? (typeof body.error === 'string' ? body.error : body.error?.status) ?? '';
    message += ` ${body.error_description ?? body.error?.message ?? reason}`;
  } catch {
    // treść nie-JSON
  }
  return new GoogleError(res.status, reason, message);
}

export function authorizationUrl(cfg: GoogleConfig, state: string, loginHint?: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Bez `consent` ponowne połączenie nie daje nowego tokenu odświeżania.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) q.set('login_hint', loginHint);
  return `${cfg.authUrl}?${q}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

async function tokenRequest(cfg: GoogleConfig, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
  });
  if (!res.ok) throw await failure(res, 'token');
  return res.json();
}

export const exchangeCode = (cfg: GoogleConfig, code: string) =>
  tokenRequest(cfg, { code, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' });

export const refreshAccessToken = (cfg: GoogleConfig, refreshToken: string) =>
  tokenRequest(cfg, { refresh_token: refreshToken, grant_type: 'refresh_token' });

export async function revokeToken(cfg: GoogleConfig, token: string): Promise<void> {
  await fetch(cfg.revokeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
}

/** Adres e-mail z `id_token` (prosto z Google przez TLS, więc bez weryfikacji podpisu). */
export function idTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).email ?? null;
  } catch {
    return null;
  }
}

/** Ważny token dostępu; odświeża, gdy wygasa w ciągu minuty. Zwraca też, czy sekret się zmienił. */
export async function ensureAccessToken(cfg: GoogleConfig, secret: GoogleSecret, now = Date.now()): Promise<{ token: string; secret: GoogleSecret; changed: boolean }> {
  if (secret.accessToken && secret.expiresAt && secret.expiresAt - 60_000 > now) {
    return { token: secret.accessToken, secret, changed: false };
  }
  const t = await refreshAccessToken(cfg, secret.refreshToken);
  const next: GoogleSecret = {
    refreshToken: t.refresh_token ?? secret.refreshToken,
    accessToken: t.access_token,
    expiresAt: now + t.expires_in * 1000,
  };
  return { token: t.access_token, secret: next, changed: true };
}

async function api<T>(cfg: GoogleConfig, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw await failure(res, path.split('?')[0]!);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  deleted?: boolean;
}

export async function listCalendars(cfg: GoogleConfig, token: string): Promise<GoogleCalendarEntry[]> {
  const out: GoogleCalendarEntry[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await api<{ items?: GoogleCalendarEntry[]; nextPageToken?: string }>(cfg, token, `/users/me/calendarList?${q}`);
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  summary?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
}

export interface EventsPage {
  items: GoogleEvent[];
  nextSyncToken: string | null;
  /** Pełna synchronizacja (bez `syncToken`) — brakujące wydarzenia trzeba usunąć. */
  full: boolean;
}

/**
 * `events.list` wszystkich stron. Z `syncToken` — tylko zmiany (także usunięte, `status: cancelled`);
 * bez niego — pełna lista w oknie. `singleEvents`: serie rozwinięte w wystąpienia (jak ICS).
 */
export async function listEvents(cfg: GoogleConfig, token: string, calendarId: string, syncToken: string | null, window: SyncWindow): Promise<EventsPage> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  do {
    const q = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
    if (syncToken) q.set('syncToken', syncToken);
    else {
      q.set('timeMin', new Date(window.fromMs).toISOString());
      q.set('timeMax', new Date(window.toMs).toISOString());
    }
    if (pageToken) q.set('pageToken', pageToken);
    const page = await api<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
      cfg, token, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);
  return { items, nextSyncToken, full: !syncToken };
}

export interface Channel {
  id: string;
  resourceId: string;
  token: string;
  /** ms od epoki */
  expiration: number;
}

export async function watchEvents(cfg: GoogleConfig, token: string, calendarId: string, address: string, channel: { id: string; token: string; ttlSeconds?: number }): Promise<Channel> {
  const res = await api<{ id: string; resourceId: string; expiration?: string }>(
    cfg, token, `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      method: 'POST',
      body: JSON.stringify({
        id: channel.id,
        type: 'web_hook',
        address,
        token: channel.token,
        params: { ttl: String(channel.ttlSeconds ?? 7 * 86400) },
      }),
    });
  return { id: res.id, resourceId: res.resourceId, token: channel.token, expiration: Number(res.expiration ?? Date.now() + 7 * 86400_000) };
}

export async function stopChannel(cfg: GoogleConfig, token: string, channel: Pick<Channel, 'id' | 'resourceId'>): Promise<void> {
  try {
    await api(cfg, token, '/channels/stop', { method: 'POST', body: JSON.stringify({ id: channel.id, resourceId: channel.resourceId }) });
  } catch (error) {
    // Kanał już wygasł albo nie istnieje — bez znaczenia.
    if (!(error instanceof GoogleError) || error.status !== 404) throw error;
  }
}

/** Wydarzenie Google → wiersz; `null` = usunięte albo poza oknem (do usunięcia, jeśli było). */
export function mapGoogleEvent(ev: GoogleEvent, window: SyncWindow): EventRow | null {
  if (ev.status === 'cancelled' || !ev.start || !ev.end) return null;
  const base = { external_id: ev.id, title: ev.summary ?? '', location: ev.location ?? null };
  let row: Omit<EventRow, 'etag'>;
  if (ev.start.date) {
    row = { ...base, all_day: true, start_at: null, end_at: null, start_date: ev.start.date, end_date: ev.end.date ?? ev.start.date };
  } else {
    row = {
      ...base,
      all_day: false,
      start_at: new Date(ev.start.dateTime!).toISOString(),
      end_at: new Date(ev.end.dateTime ?? ev.start.dateTime!).toISOString(),
      start_date: null,
      end_date: null,
    };
  }
  const out: EventRow = { ...row, etag: ev.etag ?? contentEtag(row) };
  return overlapsWindow(out, window) ? out : null;
}
