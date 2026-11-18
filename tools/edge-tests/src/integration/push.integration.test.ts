/**
 * PoC-6 — Web Push: `push_queue` → `reminders-push` (jsr:@negrel/webpush w Edge Runtime) → usługa push.
 * Fałszywa usługa push sprawdza podpis VAPID (ES256) i odszyfrowuje treść (RFC 8291, aes128gcm) kluczem
 * „przeglądarki” wygenerowanym w teście. Ostatni test: bez ręcznego wywołania — `pg_cron` co minutę.
 */
import { uuidv7 } from '@taskplanner/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeServices, type PushRequest } from './fake-services.ts';
import { adminClient, createUser, createWorkspace, fn, measure, sql, waitFor, type TestUser } from './helpers.ts';

const fake = new FakeServices();
const db = adminClient();
const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
/** Kopia z własnym `ArrayBuffer` (WebCrypto w typach TS 6 nie przyjmuje `ArrayBufferLike`). */
const bytes = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

interface Browser {
  id: string;
  keys: CryptoKeyPair;
  publicRaw: Uint8Array<ArrayBuffer>;
  auth: Uint8Array<ArrayBuffer>;
}

async function browser(): Promise<Browser> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { id: crypto.randomUUID(), keys, publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)), auth: crypto.getRandomValues(new Uint8Array(16)) };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', bytes(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: bytes(info) }, key, length * 8));
}

/** RFC 8291 / 8188: odszyfrowanie jednego rekordu aes128gcm. */
async function decrypt(b: Browser, body: Buffer): Promise<string> {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', bytes(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, b.keys.privateKey, 256));
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...b.publicRaw, ...asPublic]);
  const ikm = await hkdf(b.auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, bytes(ciphertext)));
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2); // ogranicznik ostatniego rekordu
  return new TextDecoder().decode(plain.subarray(0, end));
}

/** `Authorization: vapid t=<JWT>, k=<klucz>` — podpis ES256, `aud` = origin usługi push, `exp` ≤ 24 h. */
async function verifyVapid(req: PushRequest, endpoint: string) {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(String(req.headers.authorization));
  expect(m, String(req.headers.authorization)).not.toBeNull();
  const [h, p, s] = m![1]!.split('.') as [string, string, string];
  const key = await crypto.subtle.importKey('raw', bytes(fromB64u(m![2]!)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(fromB64u(s)), bytes(enc.encode(`${h}.${p}`)));
  expect(ok).toBe(true);
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  expect(claims.aud).toBe(new URL(endpoint).origin);
  expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
  expect(claims.sub).toMatch(/^(mailto:|https:)/);
  return m![2]!;
}

let user: TestUser;
let b1: Browser;
let b2: Browser;

async function subscribe(u: TestUser, b: Browser) {
  const { error } = await u.client.rpc('save_push_subscription', {
    p_subscription: { endpoint: fake.pushEndpoint(b.id), keys: { p256dh: b64u(b.publicRaw), auth: b64u(b.auth) } },
    p_user_agent: 'vitest',
  });
  if (error) throw error;
}

async function enqueue(row: Record<string, unknown>) {
  const { data, error } = await db.from('push_queue').insert({ user_id: user.id, title: 'Przypomnienie', ...row }).select().single();
  if (error) throw error;
  return data;
}

const received = (b: Browser, after = 0) => fake.push.filter((r) => r.id === b.id && r.at >= after);

beforeAll(async () => {
  await fake.start();
  user = await createUser('push');
  b1 = await browser();
  b2 = await browser();
  await subscribe(user, b1);
  await subscribe(user, b2);
});

afterAll(() => fake.stop());

describe('Web Push', () => {
  it('wysyłka na wszystkie subskrypcje: VAPID poprawny, treść odszyfrowana, nagłówki aes128gcm', async () => {
    const item = await enqueue({ title: 'Zapłacić rachunek', body: 'Dziś 10:00', url: '/zadania/1' });
    const t0 = performance.now();
    const res = await fn('reminders-push', { cron: true });
    const summary = await res.json();
    expect(res.status, JSON.stringify(summary)).toBe(200);
    measure('push: reminders-push (claim + 2 subskrypcje)', performance.now() - t0);

    for (const b of [b1, b2]) {
      const reqs = received(b).filter((r) => r.headers.topic === item.id.replaceAll('-', '').slice(0, 32));
      expect(reqs).toHaveLength(1);
      const r = reqs[0]!;
      expect(r.headers['content-encoding']).toBe('aes128gcm');
      expect(r.headers.urgency).toBe('high');
      expect(r.headers.ttl).toBe('600');
      const k = await verifyVapid(r, fake.pushEndpoint(b.id));
      expect(k.length).toBeGreaterThan(80);
      expect(JSON.parse(await decrypt(b, r.body))).toMatchObject({ id: item.id, title: 'Zapłacić rachunek', body: 'Dziś 10:00', url: '/zadania/1' });
    }
    const { data: row } = await db.from('push_queue').select('*').eq('id', item.id).single();
    expect(row).toMatchObject({ delivered: 2, error: null, attempts: 1 });
    expect(row.sent_at).not.toBeNull();
  });

  it('dwa równoległe uruchomienia → każde powiadomienie raz (skip locked)', async () => {
    const items = await Promise.all(Array.from({ length: 5 }, (_, i) => enqueue({ title: `Równolegle ${i}` })));
    const since = Date.now();
    await Promise.all([fn('reminders-push', { cron: true }), fn('reminders-push', { cron: true }), fn('reminders-push', { cron: true })]);
    for (const it of items) {
      const topic = it.id.replaceAll('-', '').slice(0, 32);
      expect(received(b1, since).filter((r) => r.headers.topic === topic)).toHaveLength(1);
    }
  });

  it('ukończone zadanie → bez powiadomienia; przyszłe → jeszcze nie', async () => {
    const ws = await createWorkspace(user, 'Push');
    const taskId = uuidv7();
    const hlc = `${String(Date.now()).padStart(15, '0')}:00000:test`;
    const { data: pushed } = await user.client.rpc('push_changes', {
      p_ops: [{ op: uuidv7(), table: 'tasks', id: taskId, set: { list_id: ws.inbox, title: 'Zrobione', status: 'done' }, hlc }],
    });
    expect(pushed.rejected).toEqual([]);
    const done = await enqueue({ task_id: taskId, title: 'Zrobione' });
    const later = await enqueue({ title: 'Jutro', send_at: new Date(Date.now() + 86_400_000).toISOString() });
    await fn('reminders-push', { cron: true });
    const { data: rows } = await db.from('push_queue').select('id, sent_at, delivered, error').in('id', [done.id, later.id]);
    expect(rows!.find((r) => r.id === done.id)).toMatchObject({ delivered: 0, error: 'zadanie zamknięte' });
    expect(rows!.find((r) => r.id === later.id)!.sent_at).toBeNull();
    await db.from('push_queue').delete().eq('id', later.id);
  });

  it('410 Gone → subskrypcja usunięta; 500 → ponowienie przy następnym uruchomieniu', async () => {
    fake.pushStatus.set(b2.id, 410);
    await enqueue({ title: 'Gone' });
    await fn('reminders-push', { cron: true });
    const { data: subs } = await db.from('push_subscriptions').select('endpoint').eq('user_id', user.id);
    expect(subs!.map((s) => s.endpoint)).toEqual([fake.pushEndpoint(b1.id)]);

    fake.pushStatus.set(b1.id, 500);
    const flaky = await enqueue({ title: 'Niestabilna usługa' });
    await fn('reminders-push', { cron: true });
    let { data: row } = await db.from('push_queue').select('*').eq('id', flaky.id).single();
    expect(row).toMatchObject({ sent_at: null, attempts: 1, claimed_at: null });
    fake.pushStatus.delete(b1.id);
    await fn('reminders-push', { cron: true });
    ({ data: row } = await db.from('push_queue').select('*').eq('id', flaky.id).single());
    expect(row).toMatchObject({ delivered: 1, attempts: 2 });
  });

  it('klient: widzi swoje subskrypcje bez kluczy, nie widzi kolejki, nie pisze', async () => {
    expect((await user.client.from('push_subscriptions').select('endpoint')).data).toHaveLength(1);
    expect((await user.client.from('push_subscriptions').select('auth')).error?.message).toMatch(/permission denied/);
    expect((await user.client.from('push_queue').select('id')).error?.message).toMatch(/permission denied/);
    expect((await user.client.rpc('claim_push_queue', { p_limit: 1 })).error).not.toBeNull();
    expect((await fn('reminders-push')).status).toBe(401);
  });

  it('pg_cron co minutę → pg_net → reminders-push → usługa push (bez ręcznego wywołania)', async () => {
    expect(sql(`select schedule || ' ' || active from cron.job where jobname = 'taskplanner-reminders-push'`)).toBe('* * * * * true');
    const item = await enqueue({ title: 'Z crona' });
    const topic = item.id.replaceAll('-', '').slice(0, 32);
    const t0 = Date.now();
    const req = await waitFor(async () => received(b1, t0).find((r) => r.headers.topic === topic), 90_000, 'push z crona', 200);
    measure('push: wpis w kolejce → dostarczenie przez pg_cron (≤ 60 s + wysyłka)', req.at - t0);
    expect(JSON.parse(await decrypt(b1, req.body)).title).toBe('Z crona');
    const runs = sql(`select count(*) from cron.job_run_details d join cron.job j using (jobid)
      where j.jobname = 'taskplanner-reminders-push' and d.status = 'succeeded' and d.start_time > now() - interval '2 minutes'`);
    expect(Number(runs)).toBeGreaterThan(0);
  }, 120_000);
});
