-- v1.x: definitywne usunięcie zadania z kosza (`purge_tasks`) — dostęp, zakres usunięcia, nagrobki w `_gone`, pliki.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000d1', 'wlasciciel-prg@test.local'),
  ('00000000-0000-4000-8000-0000000000d2', 'edytor-prg@test.local'),
  ('00000000-0000-4000-8000-0000000000d3', 'podglad-prg@test.local'),
  ('00000000-0000-4000-8000-0000000000d4', 'obcy-prg@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.h() returns text language sql as $$
  select lpad((floor(extract(epoch from clock_timestamp()) * 1000))::bigint::text, 15, '0') || ':00000:dev'
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', pg_temp.h())
$$;
create function pg_temp.codes(p_result jsonb) returns text language sql as $$
  select string_agg(r ->> 'code', ',') from jsonb_array_elements(p_result -> 'rejected') r
$$;
create function pg_temp.since(p_pull jsonb) returns jsonb language sql as $$
  select jsonb_object_agg(key, value -> 'version') from jsonb_each(p_pull -> 'scopes')
$$;
create function pg_temp.gone(p_pull jsonb) returns text language sql as $$
  select coalesce(string_agg(r ->> 'id', ',' order by r ->> 'id'), '') from jsonb_array_elements(p_pull -> 'tables' -> '_gone') r where r ->> 'table' = 'tasks'
$$;
create temp table pulls (name text primary key, value jsonb);
grant all on pulls to authenticated;

\set O '''00000000-0000-4000-8000-0000000000d1'''
\set E '''00000000-0000-4000-8000-0000000000d2'''
\set V '''00000000-0000-4000-8000-0000000000d3'''
\set X '''00000000-0000-4000-8000-0000000000d4'''
\set W '''f8000000-0000-4000-8000-000000000001'''
\set L '''f8100000-0000-4000-8000-000000000001'''
\set LV '''f8100000-0000-4000-8000-000000000002'''
\set A '''f8200000-0000-4000-8000-00000000000a'''
\set B '''f8200000-0000-4000-8000-00000000000b'''
\set C '''f8200000-0000-4000-8000-00000000000c'''
\set D '''f8200000-0000-4000-8000-00000000000d'''
\set TV '''f8200000-0000-4000-8000-00000000000e'''
\set G '''f8300000-0000-4000-8000-000000000001'''

select pg_temp.login(:O);
-- a → b (usunięte razem), a → c (usunięte wcześniej, z własnym podzadaniem nie rusza się); d — osobne.
select is(pg_temp.codes(public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name":"Wspólna"}'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox')),
  pg_temp.op('lists', :LV, jsonb_build_object('scope_id', :W, 'name', 'Podgląd', 'guest_access', 'view')),
  pg_temp.op('tasks', :A, jsonb_build_object('list_id', :L, 'title', 'A')),
  pg_temp.op('tasks', :B, jsonb_build_object('parent_id', :A, 'list_id', :L, 'title', 'B')),
  pg_temp.op('tasks', :C, jsonb_build_object('parent_id', :A, 'list_id', :L, 'title', 'C')),
  pg_temp.op('tasks', :D, jsonb_build_object('list_id', :L, 'title', 'D')),
  pg_temp.op('tasks', :TV, jsonb_build_object('list_id', :LV, 'title', 'TV')),
  pg_temp.op('tags', :G, jsonb_build_object('scope_id', :O, 'name', 'kosz')),
  pg_temp.op('task_tags', 'f8400000-0000-4000-8000-000000000001', jsonb_build_object('task_id', :A, 'tag_id', :G)),
  pg_temp.op('task_completions', 'f8400000-0000-4000-8000-000000000002', jsonb_build_object('task_id', :A, 'occurrence_date', '2026-11-20')),
  pg_temp.op('reminders', 'f8400000-0000-4000-8000-000000000003', jsonb_build_object('task_id', :B, 'kind', 'absolute', 'at_date', '2026-12-01', 'at_time', '09:00')),
  pg_temp.op('task_dependencies', 'f8400000-0000-4000-8000-000000000004', jsonb_build_object('predecessor_id', :A, 'successor_id', :D)),
  pg_temp.op('time_entries', 'f8400000-0000-4000-8000-000000000005', jsonb_build_object('task_id', :A, 'kind', 'manual', 'started_at', '2026-11-20T10:00:00Z', 'ended_at', '2026-11-20T10:30:00Z')),
  pg_temp.op('task_comments', 'f8400000-0000-4000-8000-000000000006', jsonb_build_object('task_id', :B, 'body', 'komentarz', 'posted_at', '2026-11-20T10:00:00Z')),
  pg_temp.op('attachments', 'f8400000-0000-4000-8000-000000000007', jsonb_build_object('task_id', :A, 'kind', 'file', 'name', 'plik.txt', 'storage_path', '00000000-0000-4000-8000-0000000000d1/f8200000-0000-4000-8000-00000000000a/plik.txt', 'mime', 'text/plain', 'size_bytes', 3))
))), null, 'dane testowe');

reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :E, 'editor'), (:W, :V, 'viewer');
insert into storage.objects (bucket_id, name, owner_id) values
  ('attachments', '00000000-0000-4000-8000-0000000000d1/f8200000-0000-4000-8000-00000000000a/plik.txt', '00000000-0000-4000-8000-0000000000d1');

select pg_temp.login(:O);
select throws_ok(format('select public.purge_tasks(array[%L::uuid])', :A), 'TP007', null, 'zadania poza koszem nie da się usunąć na stałe');
select throws_ok($$ select public.purge_tasks('{}'::uuid[]) $$, '22023', null, 'pusta lista');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :C, '{"deleted_at":"2026-11-21T08:00:00Z"}')))), null, 'C do kosza wcześniej');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(
  pg_temp.op('tasks', :A, '{"deleted_at":"2026-11-22T08:00:00Z"}'),
  pg_temp.op('tasks', :TV, '{"deleted_at":"2026-11-22T08:00:00Z"}')))), null, 'A (z B) i TV do kosza');
insert into pulls select 'o', public.pull_changes('{}', 1000);
select is(public.pull_changes('{}', 1000) #>> '{tables,_gone}', '[]', 'pełne pobranie bez nagrobków');

-- ── Dostęp ───────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:X);
select throws_ok(format('select public.purge_tasks(array[%L::uuid])', :A), 'TP003', null, 'obcy');
select pg_temp.login(:V);
select throws_ok(format('select public.purge_tasks(array[%L::uuid])', :A), 'TP003', null, 'podgląd');
select pg_temp.login(:E);
select throws_ok(format('select public.purge_tasks(array[%L::uuid])', :TV), 'TP003', null, 'edytor na liście tylko do podglądu');
select throws_ok(format('select public.purge_tasks(array[%L::uuid, %L::uuid])', :A, :TV), 'TP003', null, 'jedno niedozwolone — odrzucone w całości');
insert into pulls select 'e', public.pull_changes('{}', 1000);
select pg_temp.login(null);
select throws_ok(format('select public.purge_tasks(array[%L::uuid])', :A), '42501', null, 'bez logowania');
reset role;
select is((select count(*) from public.tasks where id in (:A, :B, :C, :D)), 4::bigint, 'nic nie zniknęło');

-- ── Usunięcie ────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:E);
insert into pulls select 'purge', public.purge_tasks(array[:A::uuid, '00000000-0000-4000-8000-00000000ffff'::uuid]);
select is((select jsonb_array_length(value -> 'purged') from pulls where name = 'purge'), 2, 'A z podzadaniem usuniętym naraz; nieznane id pominięte');
select is((select value -> 'files' from pulls where name = 'purge'),
  '["00000000-0000-4000-8000-0000000000d1/f8200000-0000-4000-8000-00000000000a/plik.txt"]'::jsonb, 'plik załącznika do skasowania');
select ok(public.can_purge_file('00000000-0000-4000-8000-0000000000d1/f8200000-0000-4000-8000-00000000000a/plik.txt'), 'usuwający może skasować plik');
select is((select count(*) from storage.objects where name like '%/plik.txt'), 1::bigint, 'i go widzi (warunek kasowania w Storage)');
select pg_temp.login(:V);
select ok(not public.can_purge_file('00000000-0000-4000-8000-0000000000d1/f8200000-0000-4000-8000-00000000000a/plik.txt'), 'inny członek — nie');

reset role;
select is((select string_agg(title, ',' order by title) from public.tasks where id in (:A, :B, :C, :D)), 'C,D', 'zostaje podzadanie usunięte osobno i inne zadanie');
select results_eq(format('select parent_id, deleted_at is not null from public.tasks where id = %L', :C), $$ values (null::uuid, true) $$, 'C: odpięte, nadal w koszu');
select is(
  (select count(*) from public.task_tags where task_id in (:A, :B)) + (select count(*) from public.task_completions where task_id in (:A, :B))
  + (select count(*) from public.reminders where task_id in (:A, :B)) + (select count(*) from public.task_dependencies where successor_id = :D)
  + (select count(*) from public.time_entries where task_id in (:A, :B)) + (select count(*) from public.task_comments where task_id in (:A, :B))
  + (select count(*) from public.attachments where task_id in (:A, :B)) + (select count(*) from public.activity_log where row_id in (:A, :B)),
  0::bigint, 'nie zostało nic, co należało do zadania');

-- ── Pozostałe urządzenia ─────────────────────────────────────────────────────────────────────
select pg_temp.login(:O);
insert into pulls select 'o2', public.pull_changes(pg_temp.since((select value from pulls where name = 'o')), 1000);
select is(pg_temp.gone((select value from pulls where name = 'o2')),
  'f8200000-0000-4000-8000-00000000000a,f8200000-0000-4000-8000-00000000000b', 'przyrost: nagrobki w `_gone`');
select is((select string_agg(r ->> 'id', ',') from pulls, jsonb_array_elements(value #> '{tables,tasks}') r where name = 'o2'),
  'f8200000-0000-4000-8000-00000000000c', 'przyrost: odpięte podzadanie');
reset role;
select ok((select row_version from public.tasks where id = :C) < (select min(row_version) from public.purged_tasks where id in (:A, :B)),
  'odpięte podzadanie ma wersję sprzed nagrobków (klient nie usunie go z drzewem rodzica)');
select pg_temp.login(:O);
-- Urządzenie, które o usunięciu jeszcze nie wie: zmiany odrzucone, wiersz wraca jako `null`.
insert into pulls select 'stale', public.push_changes(jsonb_build_array(
  pg_temp.op('tasks', :A, '{"deleted_at":null}'),
  pg_temp.op('task_comments', 'f8400000-0000-4000-8000-000000000009', jsonb_build_object('task_id', :A, 'body', 'spóźniony', 'posted_at', '2026-11-22T10:00:00Z'))));
select is(pg_temp.codes((select value from pulls where name = 'stale')), '23503,23503', 'spóźnione zmiany odrzucone');
select is((select string_agg(coalesce(r ->> 'row', 'null'), ',') from pulls, jsonb_array_elements(value -> 'rows') r where name = 'stale'), 'null,null', 'klient usuwa swoją kopię');

-- Kopia zapasowa z tymi samymi id: zadanie wraca, nagrobek znika.
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :A, jsonb_build_object('list_id', :L, 'title', 'A z kopii'))))), null, 'import z kopii');
select is(pg_temp.gone(public.pull_changes(pg_temp.since((select value from pulls where name = 'o')), 1000)),
  'f8200000-0000-4000-8000-00000000000b', 'bez nagrobka przywróconego zadania');

select * from finish();
rollback;
