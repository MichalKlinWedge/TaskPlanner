/**
 * Podgląd linku (M5, M19 „link → zadanie”): tytuł, opis, obraz, nazwa serwisu i ikona strony.
 * Czysty moduł — `fetch` i rozwiązywanie nazw wstrzykiwane (Deno w funkcji, atrapy w testach Node).
 *
 * Ochrona przed SSRF (SPECYFIKACJA §8): tylko `http(s)` na portach 80 / 443, bez danych logowania
 * w adresie, bez nazw lokalnych; każdy adres IP z DNS (A i AAAA) musi być publiczny — także po
 * każdym przekierowaniu (najwyżej 3, śledzone ręcznie). Limit czasu 5 s i 512 kB odczytu, tylko
 * HTML (inne typy → sam host). Pozostałe ryzyko: zmiana odpowiedzi DNS między sprawdzeniem a
 * połączeniem (DNS rebinding) — `fetch` w Deno nie pozwala przypiąć adresu IP przy TLS.
 */
import { normalizePreview } from '../../../packages/core/src/attachments.ts';
import type { AttachmentPreview } from '../../../packages/core/src/schemas/model.ts';

export const MAX_HTML_BYTES = 512 * 1024;
export const TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 3;

export class PreviewError extends Error {}

// ── Adresy ───────────────────────────────────────────────────────────────────────────────────

function ipv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.map(Number);
}

function isPublicIpv4([a = 0, b = 0, c = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // „ta sieć”, prywatne, pętla, multicast i zarezerwowane
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local (metadane chmury)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // testy wydajności
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Rozwinięcie IPv6 do 8 grup (z zapisem `::` i końcówką IPv4) albo `null`. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const p = ipv4(v4[1]!);
    if (!p) return null;
    text = text.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** Czy adres IP (v4 albo v6) jest publiczny — prywatne, lokalne, zarezerwowane i mapowane odrzucone. */
export function isPublicIp(ip: string): boolean {
  const v4 = ipv4(ip);
  if (v4) return isPublicIpv4(v4);
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0)) return false; // :: i ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPublicIpv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]); // ::ffff:a.b.c.d
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicIpv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]); // NAT64
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unikalne lokalne
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return false; // dokumentacja
  if (first === 0x2002) return false; // 6to4 (ukryte IPv4)
  return (first & 0xe000) === 0x2000; // tylko globalne unicast 2000::/3
}

/** Adres dopuszczony do pobrania (bez sprawdzenia DNS) albo `PreviewError`. */
export function checkTarget(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new PreviewError('Niepoprawny adres');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PreviewError('Tylko adresy http(s)');
  if (url.username || url.password) throw new PreviewError('Adres z danymi logowania');
  if (url.port && url.port !== '80' && url.port !== '443') throw new PreviewError('Niedozwolony port');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host) || (!host.includes('.') && !host.includes(':'))) {
    throw new PreviewError('Adres lokalny');
  }
  if ((ipv4(host) || host.includes(':')) && !isPublicIp(host)) throw new PreviewError('Adres prywatny');
  return url;
}

// ── HTML ─────────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', rdquo: '”', ldquo: '“', rsquo: '’', lsquo: '‘', copy: '©', reg: '®' };

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1]!.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

/** Podgląd z nagłówka HTML (Open Graph > Twitter > `<title>` / `description`); adresy względem `base`. */
export function extractPreview(html: string, base: URL): AttachmentPreview {
  const end = html.search(/<\/head\s*>/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property ?? a.name)?.toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  // Ikona: `rel="icon"` (także „shortcut icon”), inaczej `apple-touch-icon`, inaczej `/favicon.ico`.
  let icon: string | undefined;
  let touchIcon: string | undefined;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const rel = a.rel?.toLowerCase().split(/\s+/) ?? [];
    if (a.href && rel.includes('icon')) icon ??= a.href;
    if (a.href && rel.includes('apple-touch-icon')) touchIcon ??= a.href;
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const absolute = (href: string | undefined) => {
    if (!href) return undefined;
    try {
      const url = new URL(href, base);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  return normalizePreview({
    title: meta.get('og:title') ?? meta.get('twitter:title') ?? (title ? decodeEntities(title) : undefined),
    description: meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
    image: absolute(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image')),
    siteName: meta.get('og:site_name') ?? base.hostname.replace(/^www\./, ''),
    icon: absolute(icon ?? touchIcon ?? '/favicon.ico'),
  });
}

/** Kodowanie z nagłówka albo `<meta charset>` w pierwszych bajtach (domyślnie UTF-8). */
function charsetOf(contentType: string | null, bytes: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader;
  const ascii = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii)?.[1] ?? 'utf-8';
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    // Wystarczy nagłówek dokumentu.
    if (/<\/head\s*>/i.test(new TextDecoder('latin1').decode(value))) break;
  }
  await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.length - offset);
    out.set(part, offset);
    offset += part.length;
    if (offset >= out.length) break;
  }
  return out;
}

export interface PreviewDeps {
  fetch: typeof fetch;
  /** Adresy IP nazwy (A i AAAA). */
  resolve: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

/** Pobranie i podgląd strony z ochroną SSRF; `PreviewError` = adres niedozwolony / strona niedostępna. */
export async function fetchPreview(raw: string, deps: PreviewDeps): Promise<AttachmentPreview> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS);
  let url = checkTarget(raw);
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ips = ipv4(host) || host.includes(':') ? [host] : await deps.resolve(host).catch(() => []);
    if (!ips.length) throw new PreviewError('Nieznany host');
    if (ips.some((ip) => !isPublicIp(ip))) throw new PreviewError('Adres prywatny');

    const res = await deps.fetch(url.href, {
      redirect: 'manual',
      signal,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'pl,en;q=0.8', 'user-agent': 'TaskPlannerLinkPreview/1.0' },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location || hop >= MAX_REDIRECTS) throw new PreviewError('Za dużo przekierowań');
      url = checkTarget(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new PreviewError(`Strona odpowiedziała ${res.status}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      return normalizePreview({ siteName: url.hostname.replace(/^www\./, '') });
    }
    const bytes = await readLimited(res, MAX_HTML_BYTES);
    let html: string;
    try {
      html = new TextDecoder(charsetOf(type, bytes)).decode(bytes);
    } catch {
      html = new TextDecoder().decode(bytes);
    }
    return extractPreview(html, url);
  }
}
