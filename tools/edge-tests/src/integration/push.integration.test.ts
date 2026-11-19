/**
 * MVP-4 — Web Push z przypomnień: `devices.push_subscription` + `reminders` → `reminders-push` (liczy
 * `core/reminders.ts`, dziennik `reminder_deliveries`) → usługa push (jsr:@negrel/webpush w Edge Runtime).
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
let inbox: string;
let b1: Browser;
let b2: Browser;
let tick = 0;
const hlc = () => `${String(Date.now()).padStart(15, '0')}:${String(++tick % 100000).padStart(5, '0')}:test`;

async function push(table: string, id: string, set: Record<string, unknown>) {
  const { data, error } = await user.client.rpc('push_changes', { p_ops: [{ op: uuidv7(), table, id, set, hlc: hlc() }] });
  if (error) throw error;
  expect(data.rejected, JSON.stringify(data.rejected)).toEqual([]);
}

/** Przeglądarka jako urządzenie użytkownika: wiersz `devices` przez `push_changes`, jak web. */
async function device(b: Browser, patch: Record<string, unknown> = {}) {
  await push('devices', b.id, {
    name: `Chrome ${b.id.slice(0, 4)}`,
    platform: 'web',
    reminder_channel: 'enabled',
    push_subscription: { endpoint: fake.pushEndpoint(b.id), keys: { p256dh: b64u(b.publicRaw), auth: b64u(b.auth) } },
    ...patch,
  });
}

/** Zadanie z terminem w bieżącej minucie (UTC) i przypomnieniem „w chwili terminu” — należne teraz. */
async function dueNow(title: string, { minutesAhead = 0, status = 'todo' } = {}) {
  const at = new Date(Date.now() + minutesAhead * 60_000).toISOString();
  const taskId = uuidv7();
  const reminderId = uuidv7();
  await push('tasks', taskId, { list_id: inbox, title, status, due_date: at.slice(0, 10), due_time: at.slice(11, 16) });
  await push('reminders', reminderId, { task_id: taskId, kind: 'relative', offset_min: 0 });
  return { taskId, reminderId, topic: `${reminderId.replaceAll('-', '').slice(0, 24)}${at.slice(0, 10).replaceAll('-', '')}` };
}

const received = (b: Browser, topic: string, after = 0) => fake.push.filter((r) => r.id === b.id && r.at >= after && r.headers.topic === topic);
const deliveries = async (taskId: string) => (await db.from('reminder_deliveries').select('*').eq('task_id', taskId)).data ?? [];

beforeAll(async () => {
  await fake.start();
  user = await createUser('push');
  ({ inbox } = await createWorkspace(user, 'Push'));
  // Strefa profilu = UTC, żeby „bieżąca minuta” zadania była jednoznaczna.
  await push('profiles', user.id, { settings: { onboarded: true, timeZone: 'UTC' } });
  b1 = await browser();
  b2 = await browser();
  await device(b1);
  await device(b2);
});

afterAll(() => fake.stop());

describe('Web Push z przypomnień', () => {
  it('przypomnienie → każde wybrane urządzenie raz: VAPID poprawny, treść odszyfrowana, dziennik', async () => {
    const r = await dueNow('Zapłacić rachunek');
    const t0 = performance.now();
    const res = await fn('reminders-push', { cron: true });
    const summary = await res.json();
    expect(res.status, JSON.stringify(summary)).toBe(200);
    measure('push: reminders-push (plan + claim + 2 urządzenia)', performance.now() - t0);

    for (const b of [b1, b2]) {
      const reqs = received(b, r.topic);
      expect(reqs, JSON.stringify(summary)).toHaveLength(1);
      const req = reqs[0]!;
      expect(req.headers['content-encoding']).toBe('aes128gcm');
      expect(req.headers.urgency).toBe('high');
      expect(req.headers.ttl).toBe('600');
      expect((await verifyVapid(req, fake.pushEndpoint(b.id))).length).toBeGreaterThan(80);
      expect(JSON.parse(await decrypt(b, req.body))).toMatchObject({ title: 'Zapłacić rachunek', url: `/?task=${r.taskId}`, taskId: r.taskId });
    }
    const rows = await deliveries(r.taskId);
    expect(rows.map((d) => d.status)).toEqual(['sent', 'sent']);
    expect(new Set(rows.map((d) => d.device_id))).toEqual(new Set([b1.id, b2.id]));
  });

  it('kolejne i równoległe uruchomienia → bez duplikatów', async () => {
    const r = await dueNow('Równolegle');
    const since = Date.now();
    await Promise.all([fn('reminders-push', { cron: true }), fn('reminders-push', { cron: true }), fn('reminders-push', { cron: true })]);
    await fn('reminders-push', { cron: true });
    expect(received(b1, r.topic, since)).toHaveLength(1);
    expect(received(b2, r.topic, since)).toHaveLength(1);
  });

  it('tylko wybrane urządzenia; zamknięte zadanie i przyszły termin — bez wysyłki', async () => {
    await device(b2, { reminder_channel: 'disabled' });
    const r = await dueNow('Tylko pierwsza');
    const done = await dueNow('Zrobione', { status: 'done' });
    const later = await dueNow('Za godzinę', { minutesAhead: 60 });
    await fn('reminders-push', { cron: true });
    expect(received(b1, r.topic)).toHaveLength(1);
    expect(received(b2, r.topic)).toHaveLength(0);
    expect(await deliveries(done.taskId)).toEqual([]);
    expect(await deliveries(later.taskId)).toEqual([]);
    await device(b2, { reminder_channel: 'enabled' });
  });

  it('410 Gone → subskrypcja urządzenia wyczyszczona; 500 → ponowienie przy następnym uruchomieniu', async () => {
    fake.pushStatus.set(b2.id, 410);
    fake.pushStatus.set(b1.id, 500);
    const r = await dueNow('Niestabilna usługa');
    await fn('reminders-push', { cron: true });
    const { data: dev } = await db.from('devices').select('push_subscription, field_clock').eq('id', b2.id).single();
    expect(dev!.push_subscription).toBeNull();
    expect(String((dev!.field_clock as Record<string, string>).push_subscription)).toMatch(/:server$/);
    let rows = await deliveries(r.taskId);
    expect(rows.find((d) => d.device_id === b1.id)).toMatchObject({ status: 'failed', attempts: 1 });
    fake.pushStatus.delete(b1.id);
    fake.pushStatus.delete(b2.id);
    await fn('reminders-push', { cron: true });
    rows = await deliveries(r.taskId);
    expect(rows.find((d) => d.device_id === b1.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(received(b1, r.topic)).toHaveLength(2); // 500 + udane ponowienie
    await device(b2);
  });

  it('klient: widzi swój dziennik, nie pisze go, nie zajmuje wysyłek; funkcja wymaga sekretu crona', async () => {
    expect(((await user.client.from('reminder_deliveries').select('id')).data ?? []).length).toBeGreaterThan(0);
    const { error } = await user.client.from('reminder_deliveries').insert({ user_id: user.id, device_id: b1.id, fire_key: 'x', task_id: uuidv7(), fire_at: new Date().toISOString() });
    expect(error?.message).toMatch(/permission denied/);
    expect((await user.client.rpc('claim_reminder_deliveries', { p_items: [] })).error).not.toBeNull();
    expect((await fn('reminders-push')).status).toBe(401);
  });

  it('pg_cron co minutę → pg_net → reminders-push → usługa push (bez ręcznego wywołania)', async () => {
    expect(sql(`select schedule || ' ' || active from cron.job where jobname = 'taskplanner-reminders-push'`)).toBe('* * * * * true');
    // Termin w następnej minucie — wyśle dopiero cron, gdy przypomnienie stanie się należne.
    const r = await dueNow('Z crona', { minutesAhead: 1 });
    const t0 = Date.now();
    const req = await waitFor(async () => received(b1, r.topic, t0)[0], 150_000, 'push z crona', 200);
    measure('push: przypomnienie należne → dostarczenie przez pg_cron (≤ 60 s + wysyłka)', req.at - t0);
    expect(JSON.parse(await decrypt(b1, req.body)).title).toBe('Z crona');
    const runs = sql(`select count(*) from cron.job_run_details d join cron.job j using (jobid)
      where j.jobname = 'taskplanner-reminders-push' and d.status = 'succeeded' and d.start_time > now() - interval '3 minutes'`);
    expect(Number(runs)).toBeGreaterThan(0);
  }, 180_000);
});
