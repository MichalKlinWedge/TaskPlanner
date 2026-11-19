import { describe, expect, it } from 'vitest';

import { checkTarget, decodeEntities, extractPreview, fetchPreview, isPublicIp, MAX_HTML_BYTES, PreviewError, type PreviewDeps } from '../../../supabase/functions/_shared/link-preview.ts';

describe('ochrona przed SSRF', () => {
  it('adresy prywatne, lokalne i zarezerwowane odrzucone, publiczne przyjęte', () => {
    const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '64:ff9b::a9fe:a9fe', '2001:db8::1', '2002:7f00:1::', '1.2.3', 'nie-ip'];
    for (const ip of blocked) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicIp(ip), ip).toBe(true);
  });

  it('tylko http(s), porty 80/443, bez danych logowania i nazw lokalnych', () => {
    expect(checkTarget('https://pl.wikipedia.org/wiki/Kot').hostname).toBe('pl.wikipedia.org');
    expect(checkTarget('http://example.com:80/').href).toBe('http://example.com/');
    for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com:8080', 'http://localhost/', 'http://router.local/', 'http://metadata.google.internal/', 'http://intranet/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'nie adres']) {
      expect(() => checkTarget(bad), bad).toThrow(PreviewError);
    }
  });
});

describe('podgląd z HTML', () => {
  it('Open Graph przed `<title>`, adresy względne, encje', () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Zapas &amp; tytuł</title>
      <meta property="og:title" content="Kot domowy &#8211; Wikipedia">
      <meta name="description" content="Gatunek ssaka">
      <meta property="og:image" content="/img/kot.jpg"><meta property="og:site_name" content="Wikipedia">
      <link rel="apple-touch-icon" href="/touch.png"><link rel="shortcut icon" href="//static.wiki.org/fav.ico">
      </head><body><meta property="og:title" content="w treści — pominięte"></body></html>`;
    expect(extractPreview(html, new URL('https://pl.wikipedia.org/wiki/Kot'))).toEqual({
      title: 'Kot domowy – Wikipedia',
      description: 'Gatunek ssaka',
      image: 'https://pl.wikipedia.org/img/kot.jpg',
      siteName: 'Wikipedia',
      icon: 'https://static.wiki.org/fav.ico',
    });
    expect(extractPreview('<title>\n  Tylko tytuł  </title>', new URL('https://www.blog.pl/a'))).toEqual({ title: 'Tylko tytuł', siteName: 'blog.pl', icon: 'https://www.blog.pl/favicon.ico' });
    expect(decodeEntities('&quot;a&quot; &#x142;&oacute;d&#0;')).toBe('"a" łód&#0;'.replace('ó', '&oacute;'));
  });
});

const page = (body: string, init: ResponseInit = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

function deps(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}): PreviewDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (host) => dns[host] ?? ['93.184.216.34'],
    fetch: (async (input: string) => {
      calls.push(input);
      const route = routes[input];
      if (!route) throw new TypeError('fetch failed');
      return route();
    }) as typeof fetch,
  };
}

describe('pobranie strony', () => {
  it('przekierowania sprawdzane po każdym kroku, prywatny cel odrzucony', async () => {
    const ok = deps({
      'https://t.co/x': () => new Response(null, { status: 301, headers: { location: 'https://blog.pl/wpis' } }),
      'https://blog.pl/wpis': () => page('<title>Wpis</title>'),
    });
    expect(await fetchPreview('https://t.co/x', ok)).toMatchObject({ title: 'Wpis', siteName: 'blog.pl' });

    const toMetadata = deps({ 'https://t.co/x': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }) });
    await expect(fetchPreview('https://t.co/x', toMetadata)).rejects.toThrow('Adres prywatny');

    const rebind = deps({}, { 'evil.example.com': ['93.184.216.34', '10.0.0.5'] });
    await expect(fetchPreview('https://evil.example.com/', rebind)).rejects.toThrow('Adres prywatny');
    expect(rebind.calls).toEqual([]);

    const loop = deps({ 'https://a.pl/': () => new Response(null, { status: 302, headers: { location: '/' } }) });
    await expect(fetchPreview('https://a.pl/', loop)).rejects.toThrow('Za dużo przekierowań');
    expect(loop.calls).toHaveLength(4);
  });

  it('inne typy niż HTML → tylko host; kodowanie z `<meta charset>`; limit odczytu', async () => {
    const pdf = deps({ 'https://a.pl/x.pdf': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) });
    expect(await fetchPreview('https://a.pl/x.pdf', pdf)).toEqual({ siteName: 'a.pl' });

    const latin2 = Uint8Array.from([...new TextEncoder().encode('<meta charset="iso-8859-2"><title>'), 0xb3, 0xf3, 0xbf, 0x6b, 0x6f, ...new TextEncoder().encode('</title>')]);
    const legacy = deps({ 'https://a.pl/': () => new Response(latin2, { headers: { 'content-type': 'text/html' } }) });
    expect((await fetchPreview('https://a.pl/', legacy)).title).toBe('łóżko');

    const huge = `<title>Duża</title>${'x'.repeat(MAX_HTML_BYTES * 2)}`;
    expect((await fetchPreview('https://a.pl/', deps({ 'https://a.pl/': () => page(huge) }))).title).toBe('Duża');

    await expect(fetchPreview('https://a.pl/', deps({ 'https://a.pl/': () => page('x', { status: 404 }) }))).rejects.toThrow('404');
  });
});
