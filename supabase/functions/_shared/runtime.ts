/**
 * Wspólne dla Edge Functions: zmienne środowiska, klient `service_role`, uwierzytelnienie wywołań
 * (użytkownik — JWT, cron — `x-cron-secret`), odpowiedzi. Tylko Deno.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { GOOGLE_DEFAULTS, type GoogleConfig } from './google.ts';

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, `Brak zmiennej środowiska ${name}`);
  return value;
}

export const optionalEnv = (name: string): string | undefined => Deno.env.get(name) || undefined;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let adminClient: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  adminClient ??= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

/** Publiczny adres funkcji (lokalnie `SUPABASE_URL` to adres wewnątrz Dockera). */
export const functionsUrl = () => (optionalEnv('FUNCTIONS_PUBLIC_URL') ?? `${env('SUPABASE_URL')}/functions/v1`).replace(/\/$/, '');

export function googleConfig(): GoogleConfig {
  return {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    redirectUri: `${functionsUrl()}/calendar-sync/google/callback`,
    authUrl: optionalEnv('GOOGLE_AUTH_URL') ?? GOOGLE_DEFAULTS.authUrl,
    tokenUrl: optionalEnv('GOOGLE_TOKEN_URL') ?? GOOGLE_DEFAULTS.tokenUrl,
    revokeUrl: optionalEnv('GOOGLE_REVOKE_URL') ?? GOOGLE_DEFAULTS.revokeUrl,
    apiBase: optionalEnv('GOOGLE_API_BASE') ?? GOOGLE_DEFAULTS.apiBase,
  };
}

/** Porównanie sekretów w stałym czasie. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function requireCron(req: Request): void {
  if (!safeEqual(req.headers.get('x-cron-secret'), env('CRON_SECRET'))) throw new HttpError(401, 'Zły sekret crona');
}

/** Użytkownik z nagłówka `Authorization: Bearer <JWT>`. */
export async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Wymagane logowanie');
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Nieważna sesja');
  return { id: data.user.id, email: data.user.email };
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export function html(title: string, message: string, status = 200): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return new Response(
    `<!doctype html><html lang="pl"><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
};

/**
 * Obsługa błędów jednym miejscem: `HttpError` → jego status, reszta → 500 z komunikatem w logu.
 * CORS dla wywołań z przeglądarki (Bearer, bez ciasteczek).
 */
export function serve(handler: (req: Request, url: URL) => Promise<Response>): void {
  Deno.serve(async (req) => {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    let res: Response;
    try {
      res = await handler(req, url);
    } catch (error) {
      if (error instanceof HttpError) res = json({ error: error.message }, error.status);
      else {
        console.error(url.pathname, error);
        res = json({ error: (error as Error).message ?? 'Błąd serwera' }, 500);
      }
    }
    if (res.status >= 300 && res.status < 400) return res; // Response.redirect ma niezmienne nagłówki
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  });
}

/** Ścieżka po nazwie funkcji: `/functions/v1/calendar-sync/google/start` → `google/start`. */
export function route(url: URL, fn: string): string {
  const i = url.pathname.indexOf(`/${fn}`);
  return i < 0 ? '' : url.pathname.slice(i + fn.length + 1).replace(/^\/|\/$/g, '');
}
