-- v1.x: dostęp gości do list (`lists.guest_access`: hidden / view / edit) — odczyt, zapis, RLS, `_gone`.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000c1', 'wlasciciel-lst@test.local'),
  ('00000000-0000-4000-8000-0000000000c2', 'edytor-lst@test.local'),
  ('00000000-0000-4000-8000-0000000000c3', 'podglad-lst@test.local');

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
create function pg_temp.ids(p_pull jsonb, p_table text) returns text language sql as $$
  select coalesce(string_agg(r ->> 'id', ',' order by r ->> 'id'), '') from jsonb_array_elements(p_pull -> 'tables' -> p_table) r
$$;
create temp table pulls (name text primary key, value jsonb);
grant all on pulls to authenticated;

\set O '''00000000-0000-4000-8000-0000000000c1'''
\set E '''00000000-0000-4000-8000-0000000000c2'''
\set V '''00000000-0000-4000-8000-0000000000c3'''
\set W '''f7000000-0000-4000-8000-000000000001'''
\set LE '''f7100000-0000-4000-8000-00000000000e'''
\set LV '''f7100000-0000-4000-8000-00000000000a'''
\set LH '''f7100000-0000-4000-8000-00000000000b'''
\set TE '''f7200000-0000-4000-8000-00000000000e'''
\set TV '''f7200000-0000-4000-8000-00000000000a'''
\set TH '''f7200000-0000-4000-8000-00000000000b'''
\set SH '''f7200000-0000-4000-8000-0000000000bb'''
\set RH '''f7300000-0000-4000-8000-00000000000b'''
\set DH '''f7400000-0000-4000-8000-00000000000b'''

select pg_temp.login(:O);
select is(pg_temp.codes(public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name":"Wspólna"}'),
  pg_temp.op('lists', :LE, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Edycja')),
  pg_temp.op('lists', :LV, jsonb_build_object('scope_id', :W, 'name', 'Podgląd', 'guest_access', 'view')),
  pg_temp.op('lists', :LH, jsonb_build_object('scope_id', :W, 'name', 'Ukryta', 'guest_access', 'hidden')),
  pg_temp.op('tasks', :TE, jsonb_build_object('list_id', :LE, 'title', 'Jawne')),
  pg_temp.op('tasks', :TV, jsonb_build_object('list_id', :LV, 'title', 'Do czytania')),
  pg_temp.op('tasks', :TH, jsonb_build_object('list_id', :LH, 'title', 'Tajne')),
  pg_temp.op('tasks', :SH, jsonb_build_object('parent_id', :TH, 'list_id', :LH, 'title', 'Tajne podzadanie')),
  pg_temp.op('reminders', :RH, jsonb_build_object('task_id', :TH, 'kind', 'absolute', 'at_date', '2026-12-01', 'at_time', '09:00')),
  pg_temp.op('task_dependencies', :DH, jsonb_build_object('predecessor_id', :TE, 'successor_id', :TH))
))), null, 'właściciel zakłada listy z różnym dostępem dla gości');

reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :E, 'editor'), (:W, :V, 'viewer');

-- ── Dostęp ───────────────────────────────────────────────────────────────────────────────────
select results_eq(
  $$ select public.list_access(l, u) from (values
       ('f7100000-0000-4000-8000-00000000000e'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid),
       ('f7100000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-0000000000c1'),
       ('f7100000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-0000000000c2'),
       ('f7100000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000c2'),
       ('f7100000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-0000000000c2'),
       ('f7100000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-0000000000c3'),
       ('f7100000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-0000000000c3')) v(l, u) $$,
  $$ values ('edit'), ('edit'), ('edit'), ('view'), ('hidden'), ('view'), ('hidden') $$,
  'list_access: właściciel zawsze edit, gość — słabsze z roli i ustawienia listy');

-- ── Odczyt edytora ───────────────────────────────────────────────────────────────────────────
select pg_temp.login(:E);
insert into pulls select 'e', public.pull_changes('{}', 1000);
select is(pg_temp.ids((select value from pulls where name = 'e'), 'lists'),
  'f7100000-0000-4000-8000-00000000000a,f7100000-0000-4000-8000-00000000000e', 'pull: bez ukrytej listy');
select is(pg_temp.ids((select value from pulls where name = 'e'), 'tasks'),
  'f7200000-0000-4000-8000-00000000000a,f7200000-0000-4000-8000-00000000000e', 'pull: bez zadań ukrytej listy (też podzadań)');
select is(pg_temp.ids((select value from pulls where name = 'e'), 'reminders'), '', 'pull: bez przypomnień zadań ukrytej listy');
select is(pg_temp.ids((select value from pulls where name = 'e'), 'task_dependencies'), '', 'pull: bez zależności z zadaniem ukrytej listy');
select is((select value from pulls where name = 'e') -> 'scopes' -> 'f7000000-0000-4000-8000-000000000001' -> 'hidden',
  '["f7100000-0000-4000-8000-00000000000b"]'::jsonb, 'scopes[].hidden = ukryte listy przestrzeni');
select is((select value from pulls where name = 'e') -> 'tables' -> '_gone', '[]'::jsonb, 'pełna migawka bez znaczników _gone');
select is((select count(*)::int from public.tasks where scope_id = :W), 2, 'RLS: zadania ukrytej listy niewidoczne');
select is((select count(*)::int from public.lists where scope_id = :W), 2, 'RLS: ukryta lista niewidoczna');
select is((select count(*)::int from public.reminders where task_id = :TH), 0, 'RLS: dzieci zadań ukrytej listy niewidoczne');
select is((select count(*)::int from public.task_dependencies where id = :DH), 0, 'RLS: zależność z ukrytym zadaniem niewidoczna');

-- ── Zapis edytora ────────────────────────────────────────────────────────────────────────────
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :TE, '{"title":"Jawne 2"}')))), null,
  'edytor zmienia zadanie listy z edycją');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :TV, '{"title":"Zmiana"}')))), 'TP003',
  'edytor nie zmienia zadania listy tylko do podglądu');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(
  pg_temp.op('tasks', 'f7200000-0000-4000-8000-0000000000a1', jsonb_build_object('list_id', :LV, 'title', 'Nowe'))))), 'TP003',
  'edytor nie dodaje zadania do listy tylko do podglądu');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :TE, jsonb_build_object('list_id', :LV))))), 'TP003',
  'edytor nie przenosi zadania na listę tylko do podglądu');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :TV, jsonb_build_object('list_id', :LE))))), 'TP003',
  'edytor nie zabiera zadania z listy tylko do podglądu');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(
  pg_temp.op('task_completions', 'f7500000-0000-4000-8000-00000000000a', jsonb_build_object('task_id', :TV, 'occurrence_date', '2026-11-22'))))), 'TP003',
  'edytor nie ukańcza zadania listy tylko do podglądu');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('lists', :LV, '{"name":"Inna"}')))), 'TP003',
  'edytor nie zmienia listy tylko do podglądu');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('lists', :LE, '{"guest_access":"view"}')))), 'TP003',
  'edytor nie zmienia dostępu gości');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(
  pg_temp.op('lists', 'f7100000-0000-4000-8000-0000000000e2', jsonb_build_object('scope_id', :W, 'name', 'Moja', 'guest_access', 'hidden'))))), 'TP003',
  'edytor nie zakłada ukrytej listy');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(
  pg_temp.op('lists', 'f7100000-0000-4000-8000-0000000000e3', jsonb_build_object('scope_id', :W, 'name', 'Moja'))))), null,
  'edytor zakłada listę (dostęp gości: edycja)');
select is(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :TH, '{"title":"Zgadnięte"}'))) -> 'rows' -> 0 -> 'row', 'null'::jsonb,
  'zapis do zadania ukrytej listy odrzucony bez zwracania wiersza');

-- ── Podgląd ──────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:V);
select is(pg_temp.ids(public.pull_changes('{}', 1000), 'lists'),
  'f7100000-0000-4000-8000-00000000000a,f7100000-0000-4000-8000-00000000000e,f7100000-0000-4000-8000-0000000000e3', 'podgląd: bez ukrytej listy');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :TE, '{"title":"Nie"}')))), 'TP003',
  'rola podglądu nie edytuje nawet listy z edycją');

-- ── Przeniesienie na ukrytą listę → `_gone` w przyroście ─────────────────────────────────────
select pg_temp.login(:O);
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :TE, jsonb_build_object('list_id', :LH))))), null,
  'właściciel przenosi zadanie na ukrytą listę');
select is(pg_temp.ids(public.pull_changes('{}', 1000), 'lists'),
  'f7100000-0000-4000-8000-00000000000a,f7100000-0000-4000-8000-00000000000b,f7100000-0000-4000-8000-00000000000e,f7100000-0000-4000-8000-0000000000e3',
  'właściciel widzi wszystkie listy');
select pg_temp.login(:E);
select ok(exists (
  select 1 from jsonb_array_elements(public.pull_changes(
    (select jsonb_object_agg(k, v -> 'version') from jsonb_each((select value from pulls where name = 'e') -> 'scopes') x(k, v)), 1000) -> 'tables' -> '_gone') g
   where g = jsonb_build_object('table', 'tasks', 'id', 'f7200000-0000-4000-8000-00000000000e')),
  'przyrost: zadanie przeniesione na ukrytą listę przychodzi jako _gone');

-- ── Integracje w imieniu gościa ──────────────────────────────────────────────────────────────
reset role;
select throws_ok($$ select public.create_integration_task('00000000-0000-4000-8000-0000000000c2',
  '{"list_id":"f7100000-0000-4000-8000-00000000000a","title":"Z kalendarza"}'::jsonb) $$,
  'TP003', null, 'integracja nie dodaje zadania gościa do listy tylko do podglądu');

select * from finish();
rollback;
