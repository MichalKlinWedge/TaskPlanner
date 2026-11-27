/**
 * v1.x — `inbound-api` przez Edge Runtime (kontrakt `docs/INTEGRACJA_TP.md` w EP): token z Ustawień (`tokens/create`,
 * jawny raz), `PUT tasks/<klucz>` (utworzenie 201, powtórka bez zmian, scalanie z zachowaniem zmian użytkownika, tagi
 * po nazwie, pola nieobecne), `GET`, odpowiedź `{id, key, created, status, deleted, url, applied, kept}`, błędy
 * (401, 400 z `details`, `source` niezgodne z kluczem, 413, 404), izolacja kont, `source` w ładunku pluginu, kosz,
 * odwołanie i limit zapytań.
 */
import { uuidv7 } from '@taskplanner/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { adminClient, createUser, createWorkspace, fn, type TestUser } from './helpers.ts';

const db = adminClient();
let user: TestUser;
let other: TestUser;
let listId: string;
let token: string;
let tokenId: string;
const trip = uuidv7();
const KEY = `ep:${trip}:pkt-1`;
const SOURCE = { kind: 'expeditionplan', tripId: trip, ref: 'pkt-1', url: `https://ep.example/trips/${trip}/tasks` };
const sourceOf = (key: string) => {
  const [, tripId, ref] = key.split(':');
  return { kind: 'expeditionplan', tripId, ref, url: `https://ep.example/trips/${tripId}/tasks` };
};

/** `PUT` jak klient EP (`source` z klucza, chyba że treść ma własne). */
const put = (key: string, body: Record<string, unknown>, auth = token) =>
  fn(`inbound-api/tasks/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json; charset=utf-8', 'user-agent': 'ExpeditionPlan/1.0' },
    body: JSON.stringify({ source: sourceOf(key), ...body }),
  });

type Result = { id: string; key: string; created: boolean; status: string; deleted: boolean; url: string; applied: string[]; kept: string[]; error?: string };

async function tagNames(taskId: string): Promise<string[]> {
  const { data: links } = await db.from('task_tags').select('tag_id').eq('task_id', taskId).is('deleted_at', null);
  const ids = (links ?? []).map((l) => l.tag_id as string);
  if (!ids.length) return [];
  const { data } = await db.from('tags').select('name').in('id', ids);
  return (data ?? []).map((t) => t.name as string).sort();
}
const get = (key: string, auth = token) => fn(`inbound-api/tasks/${encodeURIComponent(key)}`, { method: 'GET', headers: { authorization: `Bearer ${auth}` } });

async function createToken(u: TestUser, list: string, label = 'Expedition Plan') {
  const res = await fn('inbound-api/tokens/create', { jwt: u.jwt, body: JSON.stringify({ label, listId: list }) });
  const body = (await res.json()) as { tokenId: string; token: string; error?: string };
  expect(res.status, body.error).toBe(200);
  return body;
}

beforeAll(async () => {
  [user, other] = await Promise.all([createUser('api'), createUser('api-obcy')]);
  const ws = await createWorkspace(user, 'Wyjazdy', [{ name: 'Maroko' }]);
  listId = ws.lists.Maroko!;
  ({ token, tokenId } = await createToken(user, listId));
});

describe('inbound-api', () => {
  it('token: jawny tylko w odpowiedzi, w bazie skrót; cudza lista odrzucona', async () => {
    expect(token).toMatch(/^tpk_[A-Za-z0-9_-]{43}$/);
    const { data } = await db.from('api_tokens').select('token_hash, token_hint, list_id').eq('id', tokenId).single();
    expect(data!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data!.token_hash).not.toContain(token);
    expect(data!.token_hint).toBe(`…${token.slice(-4)}`);
    const res = await fn('inbound-api/tokens/create', { jwt: other.jwt, body: JSON.stringify({ label: 'x', listId }) });
    expect(res.status).toBe(403);
  });

  it('PUT zakłada zadanie (201), powtórka nic nie zmienia', async () => {
    const body = {
      title: 'Kupić bilety', description: 'Pociąg do Krakowa', status: 'todo', priority: 2, startDate: null, dueDate: '2026-12-10', dueTime: '18:00',
      timeZone: 'Europe/Lisbon', tags: ['wyjazd', 'Maroko 2026'],
    };
    const res = await put(KEY, body);
    const created = (await res.json()) as Result;
    expect(res.status, JSON.stringify(created)).toBe(201);
    expect(created).toMatchObject({ key: KEY, created: true, status: 'todo', deleted: false, kept: [] });
    expect(created.url).toMatch(new RegExp(`\\?task=${created.id}$`));
    expect(created.applied).toEqual(['title', 'description', 'status', 'priority', 'startDate', 'dueDate', 'dueTime', 'timeZone', 'tags']);
    const { data: row } = await db.from('tasks').select('list_id, title, priority, due_date, due_time, time_zone, source').eq('id', created.id).single();
    expect(row).toMatchObject({ list_id: listId, title: 'Kupić bilety', priority: 2, due_date: '2026-12-10', due_time: '18:00', time_zone: 'Europe/Lisbon', source: SOURCE });
    expect(await tagNames(created.id)).toEqual(['Maroko 2026', 'wyjazd']);

    const again = await put(KEY, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: created.id, created: false, applied: [], kept: [] });
  });

  it('scalanie: zmiana użytkownika zostaje, reszta się aktualizuje', async () => {
    const id = ((await (await get(KEY)).json()) as Result).id;
    const hlc = `${String(Date.now()).padStart(15, '0')}:00001:test`;
    const push = await user.client.rpc('push_changes', { p_ops: [{ op: uuidv7(), table: 'tasks', id, set: { title: 'Bilety — moje', status: 'in_progress' }, hlc }] });
    expect(push.error).toBeNull();

    // EP znów wysyła `todo` (bez zmian po jego stronie) — status użytkownika zostaje bez konfliktu.
    const res = await put(KEY, { title: 'Kupić bilety PKP', description: 'Pociąg nocny', status: 'todo', priority: 2, startDate: null, dueDate: '2026-12-10', dueTime: '18:00', timeZone: 'Europe/Lisbon', tags: ['wyjazd', 'pkp'] });
    const body = (await res.json()) as Result;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ created: false, status: 'in_progress', kept: ['title'] });
    expect(body.applied).toEqual(['description', 'tags']);
    const { data: row } = await db.from('tasks').select('title, description_md').eq('id', id).single();
    expect(row).toEqual({ title: 'Bilety — moje', description_md: 'Pociąg nocny' });
    expect(await tagNames(id)).toEqual(['pkp', 'wyjazd']);

    // `done` to zmiana po stronie EP — wygrywa.
    const done = (await (await put(KEY, { title: 'Kupić bilety PKP', status: 'done' })).json()) as Result;
    expect(done).toMatchObject({ status: 'done', applied: ['status'], kept: [] });
  });

  it('pola nieobecne bez zmian, null czyści', async () => {
    const res = (await (await put(KEY, { title: 'Kupić bilety PKP', dueTime: null, timeZone: null })).json()) as Result;
    expect(res.applied).toEqual(['dueTime', 'timeZone']);
    const { data: row } = await db.from('tasks').select('status, priority, description_md, due_date, due_time, time_zone').eq('id', res.id).single();
    expect(row).toEqual({ status: 'done', priority: 2, description_md: 'Pociąg nocny', due_date: '2026-12-10', due_time: null, time_zone: null });
    expect(await tagNames(res.id)).toEqual(['pkp', 'wyjazd']);
  });

  it('GET: ten sam kształt; inny klucz = 404', async () => {
    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: KEY, created: false, status: 'done', deleted: false, applied: [], kept: [] });
    expect((await get(`ep:${trip}:nieznany`)).status).toBe(404);
  });

  it('ładunek pluginu niesie source zadania (webhook task.completed)', async () => {
    const id = ((await (await get(KEY)).json()) as Result).id;
    const { data } = await db.rpc('plugin_task_context', { p_task: id, p_user: user.id });
    expect((data as { source: Record<string, unknown> }).source).toEqual(SOURCE);
  });

  it('błędy: token, klucz, treść, rozmiar, metoda', async () => {
    const noAuth = await fn(`inbound-api/tasks/${KEY}`, { method: 'GET' });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect((await get(KEY, `tpk_${'x'.repeat(43)}`)).status).toBe(401);
    expect((await put('gitlab:1:2', { title: 'x', source: SOURCE })).status).toBe(400);

    const bad = await put(KEY, { title: 'x', priority: 7 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'priority: Priorytet: 1 (krytyczny) … 4 (niski).', details: [{ path: 'priority', message: 'Priorytet: 1 (krytyczny) … 4 (niski).' }] });
    const mismatch = await put(KEY, { title: 'x', source: { ...SOURCE, ref: 'pkt-2' } });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toMatch(/^source: tripId i ref/);
    const noSource = await fn(`inbound-api/tasks/${encodeURIComponent(KEY)}`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ title: 'x' }) });
    expect(noSource.status).toBe(400);

    const big = await put(KEY, { title: 'x', description: 'y'.repeat(70 * 1024) });
    expect(big.status).toBe(413);
    expect((await fn(`inbound-api/tasks/${KEY}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it('token innego konta nie widzi i nie zmienia zadań tego konta', async () => {
    const ws = await createWorkspace(other, 'Obca');
    const foreign = await createToken(other, ws.inbox, 'Obcy');
    expect((await get(KEY, foreign.token)).status).toBe(404);
    // Ten sam klucz u innego konta = osobne zadanie na jego liście.
    const res = await put(KEY, { title: 'Moje własne' }, foreign.token);
    expect(res.status).toBe(201);
    const { data } = await db.from('tasks').select('title').eq('source->>tripId', trip).eq('source->>ref', 'pkt-1').order('created_at');
    expect(data!.map((t) => t.title).sort()).toEqual(['Bilety — moje', 'Moje własne']);
  });

  it('zadanie w koszu: bez zmian, deleted: true', async () => {
    const key = `ep:${trip}:kosz`;
    const created = (await (await put(key, { title: 'Do kosza' })).json()) as Result;
    await db.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', created.id);
    const res = await put(key, { title: 'Z kosza?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: created.id, created: false, deleted: true, applied: [] });
    expect(await (await get(key)).json()).toMatchObject({ deleted: true });
    const { data } = await db.from('tasks').select('title').eq('id', created.id).single();
    expect(data!.title).toBe('Do kosza');
  });

  it('limit zapytań na token: 429 z Retry-After', async () => {
    const limited = await createToken(user, listId, 'Limit');
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await get(`ep:${trip}:limit`, limited.token);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('odwołany token przestaje działać od razu', async () => {
    const res = await fn('inbound-api/tokens/revoke', { jwt: user.jwt, body: JSON.stringify({ tokenId }) });
    expect(res.status).toBe(200);
    expect((await get(KEY)).status).toBe(401);
    const again = await fn('inbound-api/tokens/revoke', { jwt: user.jwt, body: JSON.stringify({ tokenId }) });
    expect(again.status).toBe(404);
  });
});
