/**
 * `calendar-sync` — kalendarze zewnętrzne (SPECYFIKACJA M18, PoC-6).
 *
 *   POST google/start        (użytkownik)  → {url} zgody Google (zakres calendar.readonly, offline)
 *   GET  google/callback     (Google)      → wymiana kodu, token odświeżania do Vault, kalendarze, pierwsza synchronizacja, `watch`
 *   POST google/webhook      (Google)      → powiadomienie kanału `watch` → synchronizacja przyrostowa (`syncToken`)
 *   POST ics/add             (użytkownik)  → {url, label?} adres ICS do Vault, pierwsza synchronizacja
 *   POST accounts/sync       (użytkownik)  → {accountId} odśwież teraz
 *   POST accounts/delete     (użytkownik)  → {accountId} zatrzymaj kanały, odwołaj token, usuń konto (kaskada + Vault)
 *   POST cron/poll           (pg_cron, co 15 min) → ICS i kalendarze Google bez świeżej synchronizacji
 *   POST cron/renew          (pg_cron, codziennie) → odnowienie kanałów `watch` przed wygaśnięciem, sprzątanie okna
 */
import { syncWindow } from '../_shared/calendar.ts';
import {
  googleToken,
  normalizeIcsUrl,
  fetchIcs,
  sha256Hex,
  syncAccount,
  syncGoogleCalendar,
  unwatchCalendar,
  watchCalendar,
  writeSecret,
  readSecret,
  type AccountRow,
  type CalendarRow,
} from '../_shared/calendar-sync.ts';
import { authorizationUrl, CALENDAR_SCOPE, exchangeCode, idTokenEmail, revokeToken, type GoogleSecret } from '../_shared/google.ts';
import { parseIcs } from '../_shared/ics.ts';
import { admin, functionsUrl, googleConfig, html, HttpError, json, optionalEnv, requireCron, requireUser, route, safeEqual, serve } from '../_shared/runtime.ts';

const FN = 'calendar-sync';

/** Webhook `watch` wymaga publicznego HTTPS; lokalnie (http) — bez kanałów, chyba że testy na to pozwalają. */
function webhookUrl(): string | null {
  const url = optionalEnv('GOOGLE_WEBHOOK_URL') ?? `${functionsUrl()}/${FN}/google/webhook`;
  return url.startsWith('https://') || optionalEnv('GOOGLE_ALLOW_HTTP_WEBHOOK') === '1' ? url : null;
}

async function ownAccount(userId: string, accountId: unknown): Promise<AccountRow> {
  if (typeof accountId !== 'string') throw new HttpError(400, 'Brak accountId');
  const { data } = await admin().from('calendar_accounts').select('*').eq('id', accountId).eq('user_id', userId).maybeSingle();
  if (!data) throw new HttpError(404, 'Nie ma takiego konta');
  return data as AccountRow;
}

/** Zadania w tle tak, żeby odpowiedź szła od razu (Google liczy czas odpowiedzi webhooka). */
function background(work: Promise<unknown>) {
  const done = work.catch((e) => console.error('w tle', e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(done);
}

async function googleStart(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const state = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const { error } = await admin().from('oauth_states').insert({ state, user_id: user.id, provider: 'google', redirect_to: body.redirectTo ?? null });
  if (error) throw error;
  return json({ url: authorizationUrl(googleConfig(), state, body.loginHint) });
}

async function googleCallback(url: URL): Promise<Response> {
  const db = admin();
  const cfg = googleConfig();
  const state = url.searchParams.get('state') ?? '';
  const { data: st } = await db.from('oauth_states').delete().eq('state', state).select().maybeSingle();
  if (!st || Date.now() - Date.parse(st.created_at) > 15 * 60_000) return html('Link wygasł', 'Zacznij łączenie kalendarza od nowa.', 400);
  if (url.searchParams.get('error')) return html('Nie połączono', `Google: ${url.searchParams.get('error')}`, 400);

  const tokens = await exchangeCode(cfg, url.searchParams.get('code') ?? '');
  if (!tokens.scope?.split(' ').includes(CALENDAR_SCOPE)) {
    return html('Brak dostępu do kalendarza', 'Na ekranie zgody Google zaznacz dostęp do kalendarza i spróbuj ponownie.', 400);
  }
  if (!tokens.refresh_token) return html('Nie połączono', 'Google nie zwrócił tokenu odświeżania — spróbuj ponownie.', 400);
  const email = idTokenEmail(tokens.id_token) ?? 'Google';

  const { data: account, error } = await db
    .from('calendar_accounts')
    .upsert({ user_id: st.user_id, provider: 'google', external_id: email, label: email, status: 'active', last_error: null }, { onConflict: 'user_id,provider,external_id' })
    .select()
    .single();
  if (error) throw error;
  const secret: GoogleSecret = { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  await writeSecret(db, account.id, secret);
  const results = await syncAccount(db, account as AccountRow, { cfg, calendars: true, webhookUrl: webhookUrl() });

  if (st.redirect_to) return Response.redirect(`${st.redirect_to}${st.redirect_to.includes('?') ? '&' : '?'}account=${account.id}`, 302);
  return html('Połączono kalendarz Google', `${email}: ${results.length} kalendarzy, ${results.reduce((n, r) => n + r.upserted, 0)} wydarzeń.`);
}

async function googleWebhook(req: Request): Promise<Response> {
  const channelId = req.headers.get('x-goog-channel-id');
  const state = req.headers.get('x-goog-resource-state');
  if (!channelId) return new Response(null, { status: 400 });
  const db = admin();
  const { data: cal } = await db.from('calendars').select('*').eq('sync_state->channel->>id', channelId).maybeSingle();
  // Nieznany kanał (np. po odłączeniu konta) — 200, żeby Google nie ponawiał; wygaśnie sam.
  if (!cal) return new Response(null, { status: 200 });
  const calendar = cal as CalendarRow;
  if (!safeEqual(req.headers.get('x-goog-channel-token'), calendar.sync_state.channel?.token)) return new Response(null, { status: 401 });
  if (state === 'sync') return new Response(null, { status: 200 });
  const cfg = googleConfig();
  const work = (async () => {
    const token = await googleToken(db, cfg, calendar.account_id);
    const r = await syncGoogleCalendar(db, cfg, calendar, token);
    console.log(`webhook ${calendar.id}: +${r.upserted} −${r.deleted}${r.full ? ' (pełna)' : ''}`);
  })();
  // Domyślnie czekamy na wynik (prościej mierzyć, Google daje kilka sekund); `GOOGLE_WEBHOOK_ASYNC=1` — w tle.
  if (optionalEnv('GOOGLE_WEBHOOK_ASYNC') === '1') background(work);
  else await work;
  return new Response(null, { status: 200 });
}

async function icsAdd(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  let url: string;
  try {
    url = normalizeIcsUrl(String(body.url ?? ''));
  } catch {
    throw new HttpError(400, 'Niepoprawny adres ICS');
  }
  const got = await fetchIcs(url).catch((e) => {
    throw new HttpError(400, (e as Error).message);
  });
  const name = got.notModified ? null : parseIcs(got.text).name;
  const label = String(body.label ?? name ?? new URL(url).hostname).slice(0, 200);
  const db = admin();
  const { data: account, error } = await db
    .from('calendar_accounts')
    .upsert({ user_id: user.id, provider: 'ics', external_id: (await sha256Hex(url)).slice(0, 32), label, status: 'active' }, { onConflict: 'user_id,provider,external_id' })
    .select()
    .single();
  if (error) throw error;
  await writeSecret(db, account.id, url);
  const { error: calError } = await db.from('calendars').upsert({ account_id: account.id, external_id: 'ics', name: label }, { onConflict: 'account_id,external_id' });
  if (calError) throw calError;
  const results = await syncAccount(db, account as AccountRow);
  return json({ accountId: account.id, results });
}

async function accountSync(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const account = await ownAccount(user.id, (await req.json().catch(() => ({}))).accountId);
  const results = await syncAccount(admin(), account, { cfg: account.provider === 'google' ? googleConfig() : undefined, calendars: true, webhookUrl: webhookUrl() });
  return json({ results });
}

async function accountDelete(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const account = await ownAccount(user.id, (await req.json().catch(() => ({}))).accountId);
  const db = admin();
  if (account.provider === 'google') {
    const cfg = googleConfig();
    try {
      const token = await googleToken(db, cfg, account.id);
      const { data: cals } = await db.from('calendars').select('*').eq('account_id', account.id);
      for (const cal of (cals ?? []) as CalendarRow[]) await unwatchCalendar(cfg, cal, token).catch(() => {});
      await revokeToken(cfg, (await readSecret<GoogleSecret>(db, account.id)).refreshToken);
    } catch (error) {
      console.warn('odłączanie Google', error);
    }
  }
  const { error } = await db.from('calendar_accounts').delete().eq('id', account.id);
  if (error) throw error;
  return json({ deleted: account.id });
}

/** Ograniczona równoległość, żeby jedno wolne konto nie blokowało reszty i nie przekroczyć 150 s. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
  }));
}

async function cronPoll(req: Request): Promise<Response> {
  requireCron(req);
  const db = admin();
  const started = Date.now();
  const { data: accounts, error } = await db.from('calendar_accounts').select('*').in('status', ['active', 'error']);
  if (error) throw error;
  const cfg = (accounts ?? []).some((a) => a.provider === 'google') ? googleConfig() : undefined;
  const summary = { accounts: 0, upserted: 0, deleted: 0, failed: 0 };
  await eachLimited((accounts ?? []) as AccountRow[], 4, async (account) => {
    if (Date.now() - started > 120_000) return;
    try {
      // Google ma `watch`; cron tylko dla kalendarzy bez świeżej synchronizacji (zgubione powiadomienie, brak kanału).
      const results = await syncAccount(db, account, { cfg, webhookUrl: webhookUrl(), staleMs: account.provider === 'google' ? 14 * 60_000 : undefined });
      summary.accounts++;
      for (const r of results) {
        summary.upserted += r.upserted;
        summary.deleted += r.deleted;
      }
    } catch (e) {
      summary.failed++;
      console.error('poll', account.id, e);
    }
  });
  return json({ ...summary, ms: Date.now() - started });
}

async function cronRenew(req: Request): Promise<Response> {
  requireCron(req);
  const db = admin();
  const url = webhookUrl();
  const summary = { renewed: 0, failed: 0, pruned: 0 };
  if (url) {
    const horizon = Date.now() + 2 * 86_400_000;
    const { data: cals } = await db.from('calendars').select('*, calendar_accounts!inner(provider, status)').eq('visible', true)
      .eq('calendar_accounts.provider', 'google').eq('calendar_accounts.status', 'active');
    const cfg = googleConfig();
    for (const cal of (cals ?? []) as CalendarRow[]) {
      const exp = cal.sync_state.channel?.expiration ?? 0;
      if (exp > horizon) continue;
      try {
        await watchCalendar(db, cfg, cal, await googleToken(db, cfg, cal.account_id), url);
        summary.renewed++;
      } catch (e) {
        summary.failed++;
        console.error('renew', cal.id, e);
      }
    }
  }
  // Okno −30 dni: starsze wydarzenia nie są już potrzebne klientom.
  const from = new Date(syncWindow(Date.now()).fromMs).toISOString();
  const { count } = await db.from('calendar_events').delete({ count: 'exact' })
    .or(`end_at.lt.${from},end_date.lt.${from.slice(0, 10)},deleted_at.lt.${from}`);
  summary.pruned = count ?? 0;
  return json(summary);
}

serve(async (req, url) => {
  const path = route(url, FN);
  const m = req.method;
  if (m === 'GET' && path === 'google/callback') return googleCallback(url);
  if (m === 'POST' && path === 'google/webhook') return googleWebhook(req);
  if (m === 'POST' && path === 'google/start') return googleStart(req);
  if (m === 'POST' && path === 'ics/add') return icsAdd(req);
  if (m === 'POST' && path === 'accounts/sync') return accountSync(req);
  if (m === 'POST' && path === 'accounts/delete') return accountDelete(req);
  if (m === 'POST' && path === 'cron/poll') return cronPoll(req);
  if (m === 'POST' && path === 'cron/renew') return cronRenew(req);
  throw new HttpError(404, `Nieznana ścieżka ${m} ${path}`);
});
