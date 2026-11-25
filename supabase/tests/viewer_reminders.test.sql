-- v1.x: własne przypomnienia przy dostępie „Podgląd” (migracja *_v1x_viewer_reminders.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f5', 'wlasciciel-podg@test.local'),
  ('00000000-0000-4000-8000-0000000000f6', 'gosc-podg@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.h(p_wall bigint) returns text language sql as $$
  select lpad(p_wall::text, 15, '0') || ':00000:dev'
$$;
-- Jedna operacja: kod odrzucenia albo „ok”.
create function pg_temp.try(p_table text, p_id uuid, p_set jsonb, p_wall bigint) returns text language sql as $$
  select coalesce(public.push_changes(jsonb_build_array(jsonb_build_object(
    'op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', pg_temp.h(p_wall)))) -> 'rejected' -> 0 ->> 'code', 'ok')
$$;
create function pg_temp.rem(p_n int) returns uuid language sql as $$ select ('a7000000-0000-4000-8000-00000000000' || p_n)::uuid $$;
create function pg_temp.task(p_n int) returns uuid language sql as $$ select ('d7000000-0000-4000-8000-00000000000' || p_n)::uuid $$;
create function pg_temp.rel(p_task int, p_min int default 15) returns jsonb language sql as $$
  select jsonb_build_object('task_id', pg_temp.task(p_task), 'kind', 'relative', 'offset_min', p_min)
$$;

\set O  '''00000000-0000-4000-8000-0000000000f5'''
\set G  '''00000000-0000-4000-8000-0000000000f6'''
\set W  '''b7000000-0000-4000-8000-000000000001'''
\set L  '''c7000000-0000-4000-8000-000000000001'''
\set C  '''e7000000-0000-4000-8000-000000000001'''
\set P  '''f7000000-0000-4000-8000-000000000001'''

-- Zadania: 1 — gość odpowiedzialny, 2 — gość uczestnik, 3 — nic go nie łączy, 4 — utworzone przez gościa.
select pg_temp.login(:O);
select is(array[
    pg_temp.try('workspaces', :W, '{"name": "Wspólna"}', 1000),
    pg_temp.try('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), 1001),
    pg_temp.try('collaborators', :C, '{"name": "Grażyna", "email": "gosc-podg@test.local"}', 1002),
    pg_temp.try('tasks', pg_temp.task(1), jsonb_build_object('list_id', :L, 'title', 'Odpowiedzialny', 'assignee_id', :C), 1003),
    pg_temp.try('tasks', pg_temp.task(2), jsonb_build_object('list_id', :L, 'title', 'Uczestnik'), 1003),
    pg_temp.try('tasks', pg_temp.task(3), jsonb_build_object('list_id', :L, 'title', 'Obce'), 1003),
    pg_temp.try('tasks', pg_temp.task(4), jsonb_build_object('list_id', :L, 'title', 'Twórca'), 1003),
    pg_temp.try('task_participants', :P, jsonb_build_object('task_id', pg_temp.task(2), 'collaborator_id', :C), 1004),
    pg_temp.try('reminders', pg_temp.rem(9), pg_temp.rel(1), 1005)
  ], array_fill('ok'::text, array[9]), 'właściciel zakłada przestrzeń, zadania i własne przypomnienie');
reset role; select set_config('request.jwt.claims', '', true);
update public.tasks set created_by = :G where id = pg_temp.task(4);
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'viewer');

-- ── Rola „Podgląd” ───────────────────────────────────────────────────────────────────────────
select pg_temp.login(:G);
select is(pg_temp.try('reminders', pg_temp.rem(1), pg_temp.rel(1), 2000), 'ok', 'odpowiedzialny dodaje własne');
select is(pg_temp.try('reminders', pg_temp.rem(2), pg_temp.rel(2), 2000), 'ok', 'uczestnik dodaje własne');
select is(pg_temp.try('reminders', pg_temp.rem(4), pg_temp.rel(4), 2000), 'ok', 'twórca zadania bez wskazanej osoby dodaje własne');
select is(pg_temp.try('reminders', pg_temp.rem(3), pg_temp.rel(3), 2000), 'TP003', 'zadanie bez związku z gościem — odrzucone');
select is(pg_temp.try('reminders', pg_temp.rem(1), '{"offset_min": 30}', 2001), 'ok', 'zmiana własnego');
select is(pg_temp.try('reminders', pg_temp.rem(1), jsonb_build_object('task_id', pg_temp.task(2)), 2002), 'TP003', 'przeniesienie własnego na inne zadanie — odrzucone');
select is(pg_temp.try('reminders', pg_temp.rem(9), '{"offset_min": 5}', 2003), 'TP003', 'cudze przypomnienie — odrzucone');
select is(pg_temp.try('reminders', pg_temp.rem(9), '{"deleted_at": "2026-11-25T10:00:00Z"}', 2003), 'TP003', 'usunięcie cudzego — odrzucone');
select is(pg_temp.try('tasks', pg_temp.task(1), '{"title": "Podgląd"}', 2004), 'TP003', 'zadanie dalej tylko do odczytu');
select is(pg_temp.try('task_comments', pg_temp.rem(8), jsonb_build_object('task_id', pg_temp.task(1), 'body', 'x'), 2004), 'TP003', 'inne wiersze zadania dalej tylko do odczytu');
select is((select created_by from public.reminders where id = pg_temp.rem(1)), :G::uuid, 'autor = gość');
select is((select scope_id from public.reminders where id = pg_temp.rem(1)), :W::uuid, 'zakres wyliczony z zadania');
select throws_ok($$select public.can_set_own_reminder('d7000000-0000-4000-8000-000000000001')$$, '42501', null, 'funkcja tylko dla serwera');

-- ── Utrata związku z zadaniem ────────────────────────────────────────────────────────────────
select pg_temp.login(:O);
select is(pg_temp.try('task_participants', :P, '{"deleted_at": "2026-11-25T10:00:00Z"}', 3000), 'ok', 'właściciel odpina uczestnika');
select pg_temp.login(:G);
select is(pg_temp.try('reminders', pg_temp.rem(2), '{"offset_min": 45}', 3001), 'TP003', 'były uczestnik nie zmienia przypomnienia');
select is(pg_temp.try('reminders', pg_temp.rem(2), '{"deleted_at": "2026-11-25T10:00:00Z"}', 3002), 'ok', 'ale własne może usunąć');
select is(pg_temp.try('reminders', pg_temp.rem(2), '{"deleted_at": null}', 3003), 'TP003', 'a przywrócić już nie');

-- ── Lista ukryta, lista tylko do podglądu (edytor) ───────────────────────────────────────────
reset role; select set_config('request.jwt.claims', '', true);
update public.lists set guest_access = 'hidden' where id = :L;
select pg_temp.login(:G);
select is(pg_temp.try('reminders', pg_temp.rem(1), '{"offset_min": 50}', 4000), 'TP003', 'lista ukryta — zmiana odrzucona');
select is(pg_temp.try('reminders', pg_temp.rem(1), '{"deleted_at": "2026-11-25T10:00:00Z"}', 4000), 'TP003', 'lista ukryta — usunięcie odrzucone');
reset role; select set_config('request.jwt.claims', '', true);
update public.lists set guest_access = 'view' where id = :L;
update public.scope_members set role = 'editor' where scope_id = :W and user_id = :G;
select pg_temp.login(:G);
select is(pg_temp.try('reminders', pg_temp.rem(5), pg_temp.rel(1, 60), 5000), 'ok', 'edytor na liście do podglądu: odpowiedzialny — własne');
select is(pg_temp.try('reminders', pg_temp.rem(6), pg_temp.rel(3, 60), 5000), 'TP003', 'edytor na liście do podglądu: obce zadanie — odrzucone');

-- ── Poza przestrzenią ────────────────────────────────────────────────────────────────────────
reset role; select set_config('request.jwt.claims', '', true);
delete from public.scope_members where scope_id = :W and user_id = :G;
select pg_temp.login(:G);
select is(pg_temp.try('reminders', pg_temp.rem(4), '{"deleted_at": "2026-11-25T10:00:00Z"}', 6000), 'TP003', 'po wyjściu z przestrzeni — nic');
select is(pg_temp.try('reminders', pg_temp.rem(7), pg_temp.rel(4), 6000), 'TP003', 'po wyjściu — także twórca zadania');
reset role; select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
