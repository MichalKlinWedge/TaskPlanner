/**
 * Plugin Webhook (SPECYFIKACJA M21): podpisany JSON metodą POST pod adres `https` użytkownika.
 *
 * Nagłówki: `Idempotency-Key` (id wysyłki — powtórka po błędzie ma ten sam klucz), `X-TaskPlanner-Event`,
 * `X-TaskPlanner-Delivery`, `X-TaskPlanner-Timestamp` (sekundy) i `X-TaskPlanner-Signature: sha256=<hex>`
 * = HMAC-SHA256(sekret, `<timestamp>.<treść>`). Ochrona SSRF jak w `link-preview.ts`: każdy adres IP z DNS
 * publiczny, porty 80 / 443, bez danych logowania — także po przekierowaniu (tylko 307 / 308, które
 * zachowują metodę i treść; najwyżej 3). Odpowiedź: 2xx = wysłane; 429 / 5xx / przekroczenie czasu (10 s) /
 * błąd sieci = ponowienie; 401 / 403 / 410 = połączenie wyłączone; inne 4xx = błąd bez ponowień.
 */
import { SAMPLE_TASK, pluginPayload, type PluginPayload } from '../../../../packages/core/src/plugins/payload.ts';
import { checkTarget, isPublicIp, PreviewError } from '../link-preview.ts';
import type { DeliveryResult, NetDeps, PluginRuntime, RuntimeContext } from './types.ts';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
/** Największa treść wysyłki (bajty). */
export const MAX_BODY_BYTES = 256 * 1024;
/** Ile znaków odpowiedzi odbiorcy trafia do błędu w historii. */
const ERROR_BODY_CHARS = 300;

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 (hex) — WebCrypto, działa w Deno i Node. */
export async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** Podpis jak sprawdza go odbiorca: `sha256=HMAC(sekret, timestamp + "." + treść)`. */
export const webhookSignature = async (secret: string, timestamp: string, body: string) => `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;

const isAllowed = (url: URL, allow: ReadonlySet<string>) => allow.has(url.host.toLowerCase());

/** Adres webhooka dopuszczony do wysyłki (bez DNS) albo `PreviewError`: tylko `https` (poza hostami testów). */
export function checkWebhookUrl(raw: string, allowHosts: readonly string[] = [], base?: URL): URL {
  const allow = new Set(allowHosts.map((h) => h.toLowerCase()));
  const url = checkTarget(raw, base, allow);
  if (url.protocol !== 'https:' && !isAllowed(url, allow)) throw new PreviewError('Tylko adresy https');
  return url;
}

const ipv4Like = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** Każdy adres IP hosta publiczny (poza hostami testów) albo `PreviewError`. */
export async function checkResolved(url: URL, net: NetDeps, allow: ReadonlySet<string>) {
  if (isAllowed(url, allow)) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = ipv4Like(host) || host.includes(':') ? [host] : await net.resolve(host).catch(() => []);
  if (!ips.length) throw new PreviewError('Nieznany host');
  if (ips.some((ip) => !isPublicIp(ip))) throw new PreviewError('Adres prywatny');
}

/** Sekundy z `Retry-After` (liczba albo data HTTP). */
export function retryAfterSec(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** Początek odpowiedzi odbiorcy do błędu w historii. */
export async function responseText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}

/** Wysyłka podpisanego JSON z ochroną SSRF; wynik według kodu odpowiedzi (ponowienie / wyłączenie / błąd). */
export async function postWebhook(
  net: NetDeps,
  raw: string,
  input: { id: string; event: string; body: string; secret: string; now: Date },
): Promise<DeliveryResult> {
  if (new TextEncoder().encode(input.body).length > MAX_BODY_BYTES) return { ok: false, retryable: false, error: 'Ładunek za duży' };
  const allow = new Set((net.allowHosts ?? []).map((h) => h.toLowerCase()));
  const timestamp = String(Math.floor(input.now.getTime() / 1000));
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'TaskPlannerWebhook/1.0',
    'idempotency-key': input.id,
    'x-taskplanner-delivery': input.id,
    'x-taskplanner-event': input.event,
    'x-taskplanner-timestamp': timestamp,
    'x-taskplanner-signature': await webhookSignature(input.secret, timestamp, input.body),
  };
  const signal = AbortSignal.timeout(net.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  let url: URL;
  try {
    url = checkWebhookUrl(raw, net.allowHosts);
    for (let hop = 0; ; hop++) {
      await checkResolved(url, net, allow);
      const res = await net.fetch(url.href, { method: 'POST', headers, body: input.body, redirect: 'manual', signal });
      const status = res.status;
      if (status === 307 || status === 308) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location || hop >= MAX_REDIRECTS) return { ok: false, retryable: false, error: 'Za dużo przekierowań', httpStatus: status };
        url = checkWebhookUrl(location, net.allowHosts, url);
        continue;
      }
      if (status >= 200 && status < 300) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: true, httpStatus: status };
      }
      const detail = await responseText(res);
      const error = `Odbiorca odpowiedział ${status}${detail ? `: ${detail}` : ''}`;
      if (status >= 300 && status < 400) return { ok: false, retryable: false, error: `${error} (przekierowanie, które zmienia metodę — podaj adres docelowy)`, httpStatus: status };
      if (status === 401 || status === 403 || status === 410) return { ok: false, retryable: false, disable: true, error, httpStatus: status };
      if (status === 429 || status >= 500) {
        return { ok: false, retryable: true, retryAfterSec: retryAfterSec(res.headers.get('retry-after'), input.now), error, httpStatus: status };
      }
      return { ok: false, retryable: false, error, httpStatus: status };
    }
  } catch (error) {
    if (error instanceof PreviewError) return { ok: false, retryable: false, error: `Adres niedozwolony: ${error.message}` };
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, retryable: true, error: 'Odbiorca nie odpowiedział w 10 s' };
    return { ok: false, retryable: true, error: `Błąd sieci: ${(error as Error).message}` };
  }
}

const configUrl = (ctx: RuntimeContext) => String(ctx.config.url ?? '');

export const webhook: PluginRuntime = {
  validateConfig(config, net) {
    try {
      checkWebhookUrl(String(config.url ?? ''), net.allowHosts);
      return null;
    } catch (error) {
      return error instanceof PreviewError ? `Adres niedozwolony: ${error.message}` : 'Niepoprawny adres';
    }
  },

  async test(ctx) {
    const now = ctx.now();
    const id = crypto.randomUUID();
    const payload = { ...pluginPayload({ id, events: ['task.sent'], sentAt: now.toISOString(), rule: null, task: SAMPLE_TASK, appUrl: 'https://example.invalid', message: 'Wysyłka próbna z Task Plannera' }), test: true };
    return postWebhook(ctx.net, configUrl(ctx), { id, event: 'test', body: JSON.stringify(payload), secret: ctx.secrets.signingSecret ?? '', now });
  },

  async deliver(ctx, delivery) {
    return postWebhook(ctx.net, configUrl(ctx), {
      id: delivery.id,
      event: delivery.payload.event,
      body: JSON.stringify(delivery.payload),
      secret: ctx.secrets.signingSecret ?? '',
      now: ctx.now(),
    });
  },
};
