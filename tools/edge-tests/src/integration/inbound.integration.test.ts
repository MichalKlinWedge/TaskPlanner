/**
 * PoC-6 — mail → zadanie: surowa wiadomość (jak z Cloudflare Email Worker) → `inbound-email` →
 * `create_integration_task` → zadanie w Inbox widoczne w `pull_changes`.
 */
import { tagId } from '@taskplanner/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { forward } from '../../../email-worker/src/index.ts';

import { adminClient, createTag, createUser, createWorkspace, edge, fn, measure, type TestUser } from './helpers.ts';

const db = adminClient();
let user: TestUser;
let token: string;
let dom: Awaited<ReturnType<typeof createWorkspace>>;
let osobiste: Awaited<ReturnType<typeof createWorkspace>>;
let pilne: string;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function mime(opts: { from?: string; subject: string; text?: string; html?: string; messageId?: string; auth?: string }) {
  const id = opts.messageId ?? `<${crypto.randomUUID()}@mail.example.com>`;
  const headers = [
    ...(opts.auth ? [`Authentication-Results: mx.cloudflare.net; ${opts.auth}`] : []),
    `From: Ja <${opts.from ?? 'ja@example.com'}>`,
    `To: zadania+${token}@zadania.example.com`,
    `Subject: =?UTF-8?B?${b64(opts.subject)}?=`,
    `Message-ID: ${id}`,
    'Date: Wed, 18 Nov 2026 12:00:00 +0100',
    'MIME-Version: 1.0',
  ];
  if (opts.html && opts.text) {
    return [...headers, 'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64', '', b64(opts.text), '--b1', 'Content-Type: text/html; charset=utf-8', '', opts.html, '--b1--', ''].join('\r\n');
  }
  if (opts.html) return [...headers, 'Content-Type: text/html; charset=utf-8', '', opts.html, ''].join('\r\n');
  return [...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(opts.text ?? ''), ''].join('\r\n');
}

function deliver(raw: string, opts: { to?: string; secret?: string } = {}) {
  return fn('inbound-email', {
    headers: {
      'content-type': 'message/rfc822',
      'x-inbound-secret': opts.secret ?? edge().inboundSecret,
      'x-envelope-from': 'bounce@example.com',
      'x-envelope-to': opts.to ?? `zadania+${token}@zadania.example.com`,
      'x-received-at': new Date().toISOString(),
    },
    body: raw,
  });
}

const task = async (id: string) => (await db.from('tasks').select('*').eq('id', id).single()).data;

beforeAll(async () => {
  user = await createUser('mail');
  osobiste = await createWorkspace(user, 'Osobiste');
  dom = await createWorkspace(user, 'Dom', [{ name: 'Remont kuchni', kind: 'project' }]);
  pilne = tagId(user.id, 'pilne');
  await createTag(user, pilne, 'pilne');
  const { data, error } = await user.client.rpc('rotate_inbound_token');
  if (error) throw error;
  token = data;
  const { error: e2 } = await user.client.rpc('set_inbound_senders', { p_senders: ['Ja@Example.com', '@firma.pl', ' '] });
  if (e2) throw e2;
});

describe('mail → zadanie', () => {
  it('adres i nadawcy ustawia sam użytkownik; widzi je, nie widzi cudzych', async () => {
    expect(token).toMatch(/^[a-z0-9]{24}$/);
    const { data } = await user.client.from('inbound_addresses').select('token, senders');
    expect(data).toEqual([{ token, senders: expect.arrayContaining(['ja@example.com', '@firma.pl']) }]);
    expect(data![0]!.senders).toHaveLength(2);
    const other = await createUser('mail-obcy');
    expect((await other.client.from('inbound_addresses').select('token')).data).toEqual([]);
  });

  it('przykład ze specyfikacji: „Fwd: Faktura za prąd jutro #dom !2” → Inbox „Dom”, termin, priorytet, opis bez stopki', async () => {
    const t0 = performance.now();
    const res = await deliver(mime({ subject: 'Fwd: Faktura za prąd jutro #dom !2 @pilne', text: 'Kwota 123,45 zł.\n\n-- \nJan', html: '<p>Kwota</p>' }));
    const body = await res.json();
    measure('mail: inbound-email (parsowanie MIME + zadanie)', performance.now() - t0);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe('created');
    const t = await task(body.taskId);
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date(Date.now() + 86_400_000));
    expect(t).toMatchObject({ list_id: dom.inbox, scope_id: dom.id, title: 'Faktura za prąd', due_date: tomorrow, priority: 2, description_md: 'Kwota 123,45 zł.', created_by: user.id });
    expect(t.source).toMatchObject({ kind: 'email', from: 'ja@example.com' });
    expect(Object.keys(t.field_clock).sort()).toEqual(['description_md', 'due_date', 'list_id', 'priority', 'source', 'title']);
    const { data: tags } = await db.from('task_tags').select('tag_id').eq('task_id', body.taskId);
    expect(tags).toEqual([{ tag_id: pilne }]);

    // Klient dostaje zadanie zwykłym pobraniem przyrostowym.
    const { data: pulled } = await user.client.rpc('pull_changes', { p_since: {} });
    expect(pulled.tables.tasks.map((x: { id: string }) => x.id)).toContain(body.taskId);
    const { data: log } = await user.client.from('inbound_messages').select('status, task_id, subject').eq('task_id', body.taskId);
    expect(log).toEqual([{ status: 'created', task_id: body.taskId, subject: 'Fwd: Faktura za prąd jutro #dom !2 @pilne' }]);
  });

  it('bez wskazania listy → Inbox pierwszej przestrzeni; sam HTML; nadawca z domeny z listy', async () => {
    const res = await (await deliver(mime({ from: 'szef@firma.pl', subject: 'Re: Oferta dla klienta', html: '<div>Proszę o ofertę<br>do piątku</div><blockquote>stare</blockquote>' }))).json();
    expect(res.status).toBe('created');
    expect(await task(res.taskId)).toMatchObject({ list_id: osobiste.inbox, title: 'Oferta dla klienta', description_md: 'Proszę o ofertę\ndo piątku' });
  });

  it('ten sam Message-ID drugi raz i równolegle → jedno zadanie', async () => {
    const raw = mime({ subject: 'Kupić mleko', messageId: '<dup-1@mail.example.com>' });
    const results = await Promise.all([deliver(raw), deliver(raw), deliver(raw)].map(async (r) => (await r).json()));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(2);
    const again = await (await deliver(raw)).json();
    expect(again).toMatchObject({ status: 'duplicate', taskId: results.find((r) => r.status === 'created').taskId });
    const { count } = await db.from('tasks').select('id', { count: 'exact', head: true }).eq('created_by', user.id).eq('title', 'Kupić mleko');
    expect(count).toBe(1);
  });

  it('odrzucenia: obcy nadawca, DMARC fail, zły i brak tokenu, zły sekret — bez zadania, z dziennikiem', async () => {
    expect(await (await deliver(mime({ from: 'spam@obcy.pl', subject: 'Wygrałeś' }))).json()).toMatchObject({ status: 'rejected', reason: 'sender_not_allowed' });
    expect(await (await deliver(mime({ subject: 'Podszyty', auth: 'spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com' }))).json())
      .toMatchObject({ status: 'rejected', reason: 'dmarc_fail' });
    expect(await (await deliver(mime({ subject: 'x' }), { to: 'zadania+zzzzzzzzzzzzzzzzzzzzzzzz@zadania.example.com' })).json()).toMatchObject({ reason: 'unknown_token' });
    expect(await (await deliver(mime({ subject: 'x' }), { to: 'zadania@zadania.example.com' })).json()).toMatchObject({ reason: 'no_token' });
    expect((await deliver(mime({ subject: 'x' }), { secret: 'zly' })).status).toBe(401);
    const { data: log } = await user.client.from('inbound_messages').select('status, reason, from_addr').eq('status', 'rejected').order('received_at');
    expect(log!.map((l) => l.reason)).toEqual(['sender_not_allowed', 'dmarc_fail']);
    const { count } = await db.from('tasks').select('id', { count: 'exact', head: true }).eq('created_by', user.id).in('title', ['Wygrałeś', 'Podszyty']);
    expect(count).toBe(0);
  });

  it('nowy token unieważnia stary adres', async () => {
    const old = token;
    const { data } = await user.client.rpc('rotate_inbound_token');
    expect(data).not.toBe(old);
    expect(await (await deliver(mime({ subject: 'x' }), { to: `zadania+${old}@zadania.example.com` })).json()).toMatchObject({ reason: 'unknown_token' });
    token = data;
  });

  it('cała droga przez kod Email Workera (`forward`) → zadanie', async () => {
    const raw = mime({ subject: 'Zadzwonić do hydraulika w piątek o 9 #remont', text: 'Tel. 600 100 200' });
    let rejected: string | null = null;
    const t0 = performance.now();
    const r = await forward(
      { from: 'ja@example.com', to: `zadania+${token}@zadania.example.com`, raw: new Response(raw).body!, rawSize: raw.length, setReject: (x) => (rejected = x) },
      { INBOUND_URL: `${edge().functionsUrl}/inbound-email`, INBOUND_SECRET: edge().inboundSecret },
    );
    measure('mail: Worker.forward → inbound-email → zadanie', performance.now() - t0);
    expect(rejected).toBeNull();
    expect(r.body).toMatchObject({ status: 'created', title: 'Zadzwonić do hydraulika' });
    expect(await task((r.body as { taskId: string }).taskId)).toMatchObject({ list_id: dom.lists['Remont kuchni'], due_time: '09:00' });
  });
});
