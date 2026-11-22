/**
 * v1.x — `account-delete`: potwierdzenie adresem, potem kalendarz (z sekretem w Vault), pliki w
 * Storage i konto z całą kaskadą danych znikają; cudze konto zostaje nietknięte. Tag i osoba usuwanego
 * konta użyte w cudzej przestrzeni nie blokują usunięcia — właściciel dostaje je jako usunięte.
 */
import { uuidv7 } from '@taskplanner/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeServices } from './fake-services.ts';
import { adminClient, createUser, createWorkspace, fn, sql, type TestUser } from './helpers.ts';

const fake = new FakeServices();
const db = adminClient();
let user: TestUser;
let other: TestUser;
let taskId: string;
let otherTaskId: string;
let secretId: string;
const tagId = uuidv7();
const collaboratorId = uuidv7();
const taskTagId = uuidv7();

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Usuwany', 'BEGIN:VEVENT', 'UID:jeden@usuwany', 'DTSTART:20261125T090000Z',
  'DTEND:20261125T100000Z', 'SUMMARY:Spotkanie', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

const push = async (u: TestUser, ops: { table: string; id: string; set: Record<string, unknown> }[]) => {
  const hlc = `${String(Date.now()).padStart(15, '0')}:00001:test`;
  const { data, error } = await u.client.rpc('push_changes', { p_ops: ops.map((o) => ({ op: uuidv7(), ...o, hlc })) });
  if (error || data.rejected.length) throw new Error(`push: ${error?.message ?? JSON.stringify(data.rejected)}`);
};

const pushTask = async (u: TestUser, listId: string) => {
  const id = uuidv7();
  await push(u, [{ table: 'tasks', id, set: { list_id: listId, title: 'Do usunięcia' } }]);
  return id;
};

beforeAll(async () => {
  await fake.start();
  [user, other] = await Promise.all([createUser('usun'), createUser('zostaje')]);
  const [ws, otherWs] = await Promise.all([createWorkspace(user, 'Usuwana'), createWorkspace(other, 'Zostaje')]);
  taskId = await pushTask(user, ws.inbox);
  otherTaskId = await pushTask(other, otherWs.inbox);
  // Usuwany jest gościem w przestrzeni drugiego konta: przypina tam swój tag i wskazuje swoją osobę.
  sql(`insert into public.scope_members (scope_id, user_id, role) values ('${otherWs.id}', '${user.id}', 'editor')`);
  await push(user, [
    { table: 'tags', id: tagId, set: { name: 'gościa' } },
    { table: 'collaborators', id: collaboratorId, set: { name: 'Gustaw' } },
    { table: 'tasks', id: otherTaskId, set: { assignee_id: collaboratorId } },
    { table: 'task_tags', id: taskTagId, set: { task_id: otherTaskId, tag_id: tagId } },
  ]);
  const upload = await user.client.storage.from('attachments').upload(`${user.id}/${taskId}/notatka.txt`, new Blob(['treść']), { contentType: 'text/plain' });
  expect(upload.error).toBeNull();
  fake.setIcs('usuwany', ICS);
  const res = await fn('calendar-sync/ics/add', { jwt: user.jwt, body: JSON.stringify({ url: fake.icsUrl('usuwany') }) });
  expect(res.status, await res.clone().text()).toBe(200);
  const { data: account } = await db.from('calendar_accounts').select('secret_id').eq('user_id', user.id).single();
  secretId = account!.secret_id as string;
});
afterAll(() => fake.stop());

const count = (query: string) => Number(sql(query));

describe('account-delete', () => {
  it('bez logowania — 401, zły adres — 400 i nic nie znika', async () => {
    expect((await fn('account-delete', { body: JSON.stringify({ email: user.email }) })).status).toBe(401);
    const wrong = await fn('account-delete', { jwt: user.jwt, body: JSON.stringify({ email: other.email }) });
    expect(wrong.status).toBe(400);
    expect(count(`select count(*) from auth.users where id = '${user.id}'`)).toBe(1);
    expect(count(`select count(*) from public.tasks where id = '${taskId}'`)).toBe(1);
  });

  it('usuwa konto, dane, kalendarz z sekretem i pliki; inne konto zostaje', async () => {
    const res = await fn('account-delete', { jwt: user.jwt, body: JSON.stringify({ email: `  ${user.email.toUpperCase()} ` }) });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ deleted: user.id, calendars: 1, files: 1 });

    expect(count(`select count(*) from auth.users where id = '${user.id}'`)).toBe(0);
    expect(count(`select count(*) from public.sync_scopes where owner_id = '${user.id}'`)).toBe(0);
    expect(count(`select count(*) from public.tasks where id = '${taskId}'`)).toBe(0);
    expect(count(`select count(*) from public.calendar_accounts where user_id = '${user.id}'`)).toBe(0);
    expect(count(`select count(*) from vault.secrets where id = '${secretId}'`)).toBe(0);
    expect(count(`select count(*) from storage.objects where bucket_id = 'attachments' and name like '${user.id}/%'`)).toBe(0);

    expect(count(`select count(*) from auth.users where id = '${other.id}'`)).toBe(1);
    expect(count(`select count(*) from public.tasks where created_by = '${other.id}'`)).toBe(1);
    // Tag i osoba usuniętego w cudzej przestrzeni: nagrobki z nową wersją zamiast błędu klucza obcego.
    expect(count(`select count(*) from public.task_tags where id = '${taskTagId}' and deleted_at is not null`)).toBe(1);
    expect(count(`select count(*) from public.tasks where id = '${otherTaskId}' and assignee_id is null`)).toBe(1);
    expect(count(`select count(*) from public.scope_tags where tag_id = '${tagId}' and deleted_at is null`)).toBe(0);
    expect(count(`select count(*) from public.scope_collaborators where collaborator_id = '${collaboratorId}' and deleted_at is null`)).toBe(0);
    expect(count(`select count(*) from public.scope_tags where tag_id = '${tagId}'`)).toBe(1);
  });
});
