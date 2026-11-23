/**
 * Pluginy (M21): Webhook (`_shared/plugins/webhook.ts`) — podpis HMAC, nagłówki, ochrona SSRF (także po
 * przekierowaniu), wynik według kodu odpowiedzi; GitLab (`gitlab.ts`, I3) — issue, zmiany powiązanego issue,
 * ponowienie bez duplikatu, kody odpowiedzi. Sieć — atrapy.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { GITLAB_DESCRIPTION, pluginPayload, PLUGINS, renderActionFields, SAMPLE_TASK, type PluginEvent } from '@taskplanner/core';

import { checkWebhookUrl, postWebhook, retryAfterSec, webhook, webhookSignature } from '../../../supabase/functions/_shared/plugins/webhook.ts';
import { gitlab } from '../../../supabase/functions/_shared/plugins/gitlab.ts';
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
    expect((await webhook.deliver(ctx, { id: 'd-1', payload, fields: { message: 'Hej' }, link: null, retry: false })).ok).toBe(true);
    expect(JSON.parse(String(net.calls[1]!.init.body))).toEqual(payload);
    expect((net.calls[1]!.init.headers as Record<string, string>)['idempotency-key']).toBe('d-1');
  });
});

describe('GitLab (I3)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const issue = (iid: number, extra: Record<string, unknown> = {}) => ({ id: 900 + iid, iid, project_id: 7, web_url: `https://gitlab.example.com/g/p/-/issues/${iid}`, ...extra });
  const ctxFor = (net: NetDeps) => ({ config: { baseUrl: 'https://gitlab.example.com', project: 'g/p' }, secrets: { token: 'glpat-xxxxxxxx' }, net, now: () => NOW });
  const delivery = (
    events: PluginEvent[],
    extra: { link?: { externalId: string; externalUrl: string | null } | null; retry?: boolean; comment?: { id: string; body: string }; status?: 'todo' | 'done' } = {},
  ) => {
    const task = { ...SAMPLE_TASK, status: extra.status ?? 'todo' };
    const payload = pluginPayload({ id: 'd-1', events, sentAt: NOW.toISOString(), rule: { id: 'r', name: 'GitLab' }, task, appUrl: 'https://app', comment: extra.comment });
    const fields = renderActionFields(PLUGINS.gitlab, { labels: 'task-planner, {{tags}}' }, task, { event: events[0]!, url: payload.task.url });
    return { id: 'd-1', payload, fields, link: extra.link ?? null, retry: extra.retry ?? false };
  };
  const body = (net: { calls: Call[] }, i: number) => JSON.parse(String(net.calls[i]!.init.body));

  it('nowe issue: tytuł, opis z linkiem i znacznikiem wysyłki, etykiety, termin; token w nagłówku', async () => {
    const net = fakeNet([json(issue(12), 201)]);
    const r = await gitlab.deliver(ctxFor(net), delivery(['task.created', 'task.tagged']));
    expect(r).toEqual({ ok: true, externalId: '7:12', externalUrl: 'https://gitlab.example.com/g/p/-/issues/12', httpStatus: 201 });
    expect(net.calls[0]!.url).toBe('https://gitlab.example.com/api/v4/projects/g%2Fp/issues');
    expect(net.calls[0]!.init.method).toBe('POST');
    expect((net.calls[0]!.init.headers as Record<string, string>)['private-token']).toBe('glpat-xxxxxxxx');
    expect(body(net, 0)).toEqual({
      title: SAMPLE_TASK.title,
      description: `${SAMPLE_TASK.description}\n\n---\n[Zadanie w Task Plannerze](https://app/?task=${SAMPLE_TASK.id})\n\n<!-- taskplanner:d-1 -->`,
      labels: 'task-planner,zgłoś',
      due_date: SAMPLE_TASK.dueDate,
    });
    expect(GITLAB_DESCRIPTION).toContain('{{url}}');
  });

  it('ukończone zadanie bez issue: utworzenie i zamknięcie; komentarz → notatka', async () => {
    const net = fakeNet([json(issue(3), 201), json(issue(3, { state: 'closed' })), json({ id: 1 }, 201)]);
    const r = await gitlab.deliver(ctxFor(net), delivery(['task.completed', 'task.commented'], { status: 'done', comment: { id: 'k', body: 'Naprawione' } }));
    expect(r.ok).toBe(true);
    expect(net.calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/v4/projects/g%2Fp/issues',
      'PUT /api/v4/projects/7/issues/3',
      'POST /api/v4/projects/7/issues/3/notes',
    ]);
    expect(body(net, 1)).toEqual({ state_event: 'close' });
    expect(body(net, 2).body).toMatch(/^Naprawione\n\n— komentarz w \[Task Plannerze\]/);
  });

  it('powiązane issue: ukończenie zamyka, przywrócenie otwiera, termin i tagi zmieniają tylko swoje pola', async () => {
    const link = { externalId: '7:12', externalUrl: 'https://gitlab.example.com/g/p/-/issues/12' };
    const net = fakeNet([json(issue(12)), json(issue(12)), json(issue(12))]);
    expect(await gitlab.deliver(ctxFor(net), delivery(['task.completed'], { link, status: 'done' }))).toMatchObject({ ok: true, externalId: '7:12' });
    await gitlab.deliver(ctxFor(net), delivery(['task.reopened'], { link }));
    await gitlab.deliver(ctxFor(net), delivery(['task.due_changed', 'task.tagged'], { link }));
    expect(net.calls.every((c) => c.init.method === 'PUT' && c.url.endsWith('/projects/7/issues/12'))).toBe(true);
    expect([body(net, 0), body(net, 1), body(net, 2)]).toEqual([{ state_event: 'close' }, { state_event: 'reopen' }, { due_date: SAMPLE_TASK.dueDate, labels: 'task-planner,zgłoś' }]);
  });

  it('powiązane issue usunięte w GitLabie (404) → nowe issue', async () => {
    const net = fakeNet([json({ message: '404 Not found' }, 404), json(issue(13), 201)]);
    const r = await gitlab.deliver(ctxFor(net), delivery(['task.sent'], { link: { externalId: '7:12', externalUrl: null } }));
    expect(r).toMatchObject({ ok: true, externalId: '7:13' });
  });

  it('same zdarzenia zmiany bez issue → pominięte, bez wywołań', async () => {
    const net = fakeNet([]);
    expect(await gitlab.deliver(ctxFor(net), delivery(['task.deleted']))).toEqual({ ok: true, skipped: 'Zadanie nie ma jeszcze issue — nic do zmiany' });
    expect(net.calls).toHaveLength(0);
  });

  it('ponowienie: issue z poprzedniej próby znalezione po znaczniku — bez drugiego', async () => {
    const net = fakeNet([json([issue(20, { description: 'opis <!-- taskplanner:d-1 -->' })])]);
    expect(await gitlab.deliver(ctxFor(net), delivery(['task.sent'], { retry: true }))).toMatchObject({ ok: true, externalId: '7:20' });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toContain('search=d-1');
  });

  it('kody odpowiedzi: 401 / 403 wyłączają, 429 / 5xx / sieć ponawiają, 400 — błąd z komunikatem GitLaba', async () => {
    const run = async (reply: Response | Error) => gitlab.deliver(ctxFor(fakeNet([reply])), delivery(['task.sent']));
    expect(await run(json({ message: '401 Unauthorized' }, 401))).toMatchObject({ ok: false, disable: true });
    expect(await run(json({ message: '403 Forbidden' }, 403))).toMatchObject({ ok: false, disable: true });
    expect(await run(new Response('', { status: 429, headers: { 'retry-after': '120' } }))).toMatchObject({ ok: false, retryable: true, retryAfterSec: 120 });
    expect(await run(json({}, 502))).toMatchObject({ ok: false, retryable: true });
    expect(await run(new TypeError('fetch failed'))).toMatchObject({ ok: false, retryable: true });
    expect(await run(json({ message: { title: ['is too long'] } }, 400))).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('is too long') });
  });

  it('adres GitLaba: tylko https, bez adresów prywatnych; „Wyślij próbne” sprawdza projekt', async () => {
    expect(gitlab.validateConfig({ baseUrl: 'http://gitlab.example.com', project: 'g/p' }, {})).toMatch(/niedozwolony/);
    expect(gitlab.validateConfig({ baseUrl: 'https://gitlab.example.com', project: 'g/p' }, {})).toBeNull();
    const priv = fakeNet([], { 'gitlab.example.com': ['10.0.0.5'] });
    expect(await gitlab.test(ctxFor(priv))).toMatchObject({ ok: false, retryable: false });
    expect(priv.calls).toHaveLength(0);
    expect(await gitlab.test(ctxFor(fakeNet([json({ id: 7, web_url: 'https://gitlab.example.com/g/p' })])))).toEqual({ ok: true, httpStatus: 200, externalUrl: 'https://gitlab.example.com/g/p' });
    expect(await gitlab.test(ctxFor(fakeNet([json({ message: '404 Project Not Found' }, 404)])))).toMatchObject({ ok: false, error: 'Nie ma takiego projektu albo token go nie widzi' });
  });
});

describe('GitLab — przypisani (I3)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ctxFor = (net: NetDeps) => ({ config: { baseUrl: 'https://gitlab.example.com', project: 'g/p' }, secrets: { token: 'glpat-xxxxxxxx' }, net, now: () => NOW });
  const delivery = (events: PluginEvent[], assignees: string, link: { externalId: string; externalUrl: string | null } | null = null) => {
    const payload = pluginPayload({ id: 'd-2', events, sentAt: NOW.toISOString(), rule: { id: 'r', name: 'GitLab' }, task: SAMPLE_TASK, appUrl: 'https://app' });
    const fields = renderActionFields(PLUGINS.gitlab, { assignees }, SAMPLE_TASK, { event: events[0]!, url: payload.task.url });
    return { id: 'd-2', payload, fields, link, retry: false };
  };

  it('nazwy → assignee_ids przy tworzeniu (GET /users?username=)', async () => {
    const net = fakeNet([json([{ id: 41, username: 'jan.kowalski' }]), json([{ id: 42, username: 'ola' }]), json({ iid: 5, project_id: 7, web_url: 'https://gitlab.example.com/g/p/-/issues/5' }, 201)]);
    expect(await gitlab.deliver(ctxFor(net), delivery(['task.created'], '@jan.kowalski, ola'))).toMatchObject({ ok: true, externalId: '7:5' });
    expect(net.calls.slice(0, 2).map((c) => new URL(c.url).search)).toEqual(['?username=jan.kowalski', '?username=ola']);
    expect(JSON.parse(String(net.calls[2]!.init.body))).toMatchObject({ assignee_ids: [41, 42] });
    expect(JSON.parse(String(net.calls[2]!.init.body))).not.toHaveProperty('assignees');
  });

  it('zmiana odpowiedzialnego zmienia przypisanych; ukończenie nie pyta o użytkowników', async () => {
    const link = { externalId: '7:5', externalUrl: null };
    const net = fakeNet([json([{ id: 41, username: 'jan.kowalski' }]), json({ iid: 5, project_id: 7 }), json({ iid: 5, project_id: 7 })]);
    await gitlab.deliver(ctxFor(net), delivery(['task.assigned'], 'jan.kowalski', link));
    expect(JSON.parse(String(net.calls[1]!.init.body))).toEqual({ assignee_ids: [41] });
    await gitlab.deliver(ctxFor(net), delivery(['task.completed'], 'jan.kowalski', link));
    expect(net.calls).toHaveLength(3);
    expect(JSON.parse(String(net.calls[2]!.init.body))).toEqual({ state_event: 'close' });
  });

  it('nieznana nazwa → błąd bez ponowień, issue nie powstaje', async () => {
    const net = fakeNet([json([])]);
    expect(await gitlab.deliver(ctxFor(net), delivery(['task.created'], 'nikt'))).toEqual({ ok: false, retryable: false, error: 'Nie ma użytkownika GitLaba „nikt” — popraw pole „Przypisz do” w regule' });
    expect(net.calls).toHaveLength(1);
  });
});
