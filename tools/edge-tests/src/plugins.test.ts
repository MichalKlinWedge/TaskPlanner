/**
 * Plugin Webhook (M21, `_shared/plugins/webhook.ts`): podpis HMAC, nagłówki, ochrona SSRF (także po
 * przekierowaniu), wynik według kodu odpowiedzi. Sieć — atrapy.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { pluginPayload, SAMPLE_TASK } from '@taskplanner/core';

import { checkWebhookUrl, postWebhook, retryAfterSec, webhook, webhookSignature } from '../../../supabase/functions/_shared/plugins/webhook.ts';
import type { NetDeps } from '../../../supabase/functions/_shared/plugins/types.ts';
import { PreviewError } from '../../../supabase/functions/_shared/link-preview.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeNet(replies: (Response | Error)[], ips: Record<string, string[]> = {}): NetDeps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    resolve: async (host) => ips[host] ?? ['93.184.216.34'],
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = replies.shift() ?? new Response('ok', { status: 200 });
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
  };
}

const NOW = new Date('2026-11-23T10:00:00Z');
const input = { id: 'a1b2c3', event: 'task.sent', body: '{"x":1}', secret: 'sekret-podpisu-1234', now: NOW };

describe('Webhook — podpis i nagłówki', () => {
  it('HMAC-SHA256 z „timestamp.treść” zgodny z Node', async () => {
    const expected = createHmac('sha256', 'sekret').update('1700000000.{"a":1}').digest('hex');
    expect(await webhookSignature('sekret', '1700000000', '{"a":1}')).toBe(`sha256=${expected}`);
  });

  it('POST z Idempotency-Key, zdarzeniem, czasem i podpisem odbiorcy do sprawdzenia', async () => {
    const net = fakeNet([new Response(null, { status: 204 })]);
    expect(await postWebhook(net, 'https://hooks.example.com/x', input)).toEqual({ ok: true, httpStatus: 204 });
    const { url, init } = net.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://hooks.example.com/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"x":1}');
    expect(init.redirect).toBe('manual');
    expect(headers['idempotency-key']).toBe('a1b2c3');
    expect(headers['x-taskplanner-event']).toBe('task.sent');
    expect(headers['x-taskplanner-timestamp']).toBe(String(NOW.getTime() / 1000));
    const mac = createHmac('sha256', input.secret).update(`${headers['x-taskplanner-timestamp']}.${input.body}`).digest('hex');
    expect(headers['x-taskplanner-signature']).toBe(`sha256=${mac}`);
  });
});

describe('Webhook — adresy (SSRF)', () => {
  it('tylko https, bez adresów prywatnych i lokalnych; host testów zwolniony', () => {
    expect(checkWebhookUrl('https://n8n.example.com/webhook/1').hostname).toBe('n8n.example.com');
    for (const bad of ['http://n8n.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://example.com:8443/x', 'https://u:p@example.com/', 'ftp://example.com']) {
      expect(() => checkWebhookUrl(bad), bad).toThrow(PreviewError);
    }
    expect(checkWebhookUrl('http://host.docker.internal:54590/hooks/a', ['host.docker.internal:54590']).port).toBe('54590');
    expect(webhook.validateConfig({ url: 'http://example.com' }, {})).toBe('Adres niedozwolony: Tylko adresy https');
    expect(webhook.validateConfig({ url: 'https://example.com/h' }, {})).toBeNull();
  });

  it('nazwa wskazująca adres prywatny — bez wysyłki, bez ponowień', async () => {
    const net = fakeNet([], { 'wewnetrzny.example.com': ['10.0.0.7'] });
    expect(await postWebhook(net, 'https://wewnetrzny.example.com/h', input)).toEqual({ ok: false, retryable: false, error: 'Adres niedozwolony: Adres prywatny' });
    expect(net.calls).toHaveLength(0);
  });

  it('przekierowanie 307/308 sprawdzane jak pierwszy adres; 302 (zmienia metodę) = błąd', async () => {
    const ok = fakeNet([new Response(null, { status: 308, headers: { location: '/nowy' } }), new Response('', { status: 200 })]);
    expect((await postWebhook(ok, 'https://a.example.com/stary', input)).ok).toBe(true);
    expect(ok.calls.map((c) => c.url)).toEqual(['https://a.example.com/stary', 'https://a.example.com/nowy']);
    expect(ok.calls[1]!.init.body).toBe(input.body);

    const toPrivate = fakeNet([new Response(null, { status: 307, headers: { location: 'https://169.254.169.254/latest' } })]);
    expect(await postWebhook(toPrivate, 'https://a.example.com/x', input)).toMatchObject({ ok: false, retryable: false, error: 'Adres niedozwolony: Adres prywatny' });
    expect(toPrivate.calls).toHaveLength(1);

    const moved = fakeNet([new Response(null, { status: 302, headers: { location: 'https://b.example.com' } })]);
    expect(await postWebhook(moved, 'https://a.example.com/x', input)).toMatchObject({ ok: false, retryable: false, httpStatus: 302 });

    const loop = fakeNet(Array.from({ length: 5 }, () => new Response(null, { status: 307, headers: { location: '/x' } })));
    expect(await postWebhook(loop, 'https://a.example.com/x', input)).toMatchObject({ ok: false, error: 'Za dużo przekierowań' });
    expect(loop.calls).toHaveLength(4);
  });
});

describe('Webhook — odpowiedzi odbiorcy', () => {
  const result = (reply: Response | Error) => postWebhook(fakeNet([reply]), 'https://hooks.example.com/x', input);

  it('429 / 5xx / sieć / limit czasu = ponowienie (z Retry-After)', async () => {
    expect(await result(new Response('wolniej', { status: 429, headers: { 'retry-after': '120' } }))).toEqual({ ok: false, retryable: true, retryAfterSec: 120, error: 'Odbiorca odpowiedział 429: wolniej', httpStatus: 429 });
    expect(await result(new Response('', { status: 503 }))).toMatchObject({ ok: false, retryable: true, httpStatus: 503 });
    expect(await result(new TypeError('connection refused'))).toMatchObject({ ok: false, retryable: true, error: 'Błąd sieci: connection refused' });
    expect(await result(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toMatchObject({ ok: false, retryable: true, error: 'Odbiorca nie odpowiedział w 10 s' });
  });

  it('401 / 403 / 410 wyłączają połączenie; inne 4xx — błąd bez ponowień', async () => {
    for (const status of [401, 403, 410]) expect(await result(new Response('', { status }))).toMatchObject({ ok: false, retryable: false, disable: true, httpStatus: status });
    expect(await result(new Response('{"error":"zły format"}', { status: 422 }))).toEqual({ ok: false, retryable: false, error: 'Odbiorca odpowiedział 422: {"error":"zły format"}', httpStatus: 422 });
  });

  it('za duży ładunek nie wychodzi', async () => {
    const net = fakeNet([]);
    expect(await postWebhook(net, 'https://hooks.example.com/x', { ...input, body: 'x'.repeat(300 * 1024) })).toMatchObject({ ok: false, retryable: false, error: 'Ładunek za duży' });
    expect(net.calls).toHaveLength(0);
  });

  it('Retry-After jako data HTTP', () => {
    expect(retryAfterSec('Mon, 23 Nov 2026 10:05:00 GMT', NOW)).toBe(300);
    expect(retryAfterSec('jutro', NOW)).toBeUndefined();
    expect(retryAfterSec(null, NOW)).toBeUndefined();
  });

  it('„Wyślij próbne” i wysyłka: ładunek JSON z zadaniem, linkiem i treścią', async () => {
    const net = fakeNet([new Response('', { status: 200 }), new Response('', { status: 200 })]);
    const ctx = { config: { url: 'https://hooks.example.com/x' }, secrets: { signingSecret: 'sekret-podpisu-1234' }, net, now: () => NOW };
    expect((await webhook.test(ctx)).ok).toBe(true);
    const sample = JSON.parse(String(net.calls[0]!.init.body));
    expect(sample).toMatchObject({ test: true, event: 'task.sent', task: { title: SAMPLE_TASK.title } });
    expect((net.calls[0]!.init.headers as Record<string, string>)['x-taskplanner-event']).toBe('test');

    const payload = pluginPayload({ id: 'd-1', events: ['task.sent'], sentAt: NOW.toISOString(), rule: { id: 'r', name: 'Do n8n' }, task: SAMPLE_TASK, appUrl: 'https://app', message: 'Hej' });
    expect((await webhook.deliver(ctx, { id: 'd-1', payload })).ok).toBe(true);
    expect(JSON.parse(String(net.calls[1]!.init.body))).toEqual(payload);
    expect((net.calls[1]!.init.headers as Record<string, string>)['idempotency-key']).toBe('d-1');
  });
});
