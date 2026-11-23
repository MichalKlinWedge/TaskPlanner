-- v1.x: integracje wychodzące — zmiana zadania po udanej wysyłce (migracja *_v1x_plugin_after_send.sql):
-- status i tagi z HLC serwera, prawo zapisu właściciela reguły, seria bez zamykania, zmiana „z integracji”.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000004a1', 'po-wysylce-a@test.local'),
  ('00000000-0000-4000-8000-0000000004a2', 'po-wysylce-b@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;

create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;

\set A '''00000000-0000-4000-8000-0000000004a1'''
\set B '''00000000-0000-4000-8000-0000000004a2'''
\set C '''e4000000-0000-4000-8000-000000000001'''
\set W '''b4000000-0000-4000-8000-000000000001'''
\set L '''c4000000-0000-4000-8000-000000000001'''
\set T '''d4000000-0000-4000-8000-000000000001'''
\set S '''d4000000-0000-4000-8000-000000000002'''
\set G1 '''a4000000-0000-4000-8000-000000000001'''
\set G2 '''a4000000-0000-4000-8000-000000000002'''
\set G3 '''a4000000-0000-4000-8000-000000000003'''
\set GB '''a4000000-0000-4000-8000-0000000000b1'''
\set TT1 '''f4000000-0000-4000-8000-000000000001'''
\set TT2 '''f4000000-0000-4000-8000-000000000002'''
\set TT3 '''f4000000-0000-4000-8000-000000000003'''

select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name": "Po wysyłce"}', '000000000001000:00000:dev'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), '000000000001001:00000:dev'),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Zgłoszenie'), '000000000001002:00000:dev'),
  pg_temp.op('tasks', :S, jsonb_build_object('list_id', :L, 'title', 'Seria', 'due_date', '2026-11-23', 'recurrence', '{"mode": "schedule", "rrule": "FREQ=DAILY", "anchor": "2026-11-23"}'::jsonb), '000000000001003:00000:dev'),
  pg_temp.op('tags', :G1, jsonb_build_object('scope_id', :A, 'name', 'wysłane'), '000000000001004:00000:dev'),
  pg_temp.op('tags', :G2, jsonb_build_object('scope_id', :A, 'name', 'zgłoś'), '000000000001005:00000:dev'),
  pg_temp.op('tags', :G3, jsonb_build_object('scope_id', :A, 'name', 'stary'), '000000000001006:00000:dev'),
  pg_temp.op('task_tags', :TT2, jsonb_build_object('task_id', :T, 'tag_id', :G2), '000000000001007:00000:dev'),
  pg_temp.op('task_tags', :TT3, jsonb_build_object('task_id', :T, 'tag_id', :G3, 'deleted_at', '2026-11-20T10:00:00Z'), '000000000001008:00000:dev')));
select pg_temp.login(:B);
select public.push_changes(jsonb_build_array(pg_temp.op('tags', :GB, jsonb_build_object('scope_id', :B, 'name', 'cudzy'), '000000000001009:00000:dev')));
reset role;
-- Reguła zdarzeniowa A — inaczej wyzwalacze nic nie piszą do `plugin_outbox`.
insert into public.plugin_connections (id, user_id, plugin, label, config) values (:C, :A, 'webhook', 'Hook', '{"url": "https://example.com/h"}');
select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('plugin_rules', gen_random_uuid(),
  jsonb_build_object('name', 'Zdarzenia', 'connection_id', :C, 'enabled', true, 'sort_key', 'n',
    'trigger', '{"kind": "event", "events": ["task.completed"]}'::jsonb, 'action', '{}'::jsonb, 'options', '{}'::jsonb), '000000000001010:00000:dev')));
reset role;
delete from public.plugin_outbox where scope_id = :W;

select is(
  public.plugin_after_send(:A, :T, 'done', jsonb_build_array(jsonb_build_object('id', :TT1, 'tagId', :G1), jsonb_build_object('id', gen_random_uuid(), 'tagId', :G3)), array[:G2]::uuid[]),
  null, 'wszystko zmienione — bez uwagi');
select ok((select status = 'done' and completed_at is not null and field_clock ->> 'status' like '%:server' from public.tasks where id = :T), 'status Gotowe z HLC serwera');
select ok((select deleted_at is null from public.task_tags where id = :TT1), 'tag dodany pod id z aplikacji');
select ok((select deleted_at is not null from public.task_tags where id = :TT2), 'tag zdjęty');
select ok((select deleted_at is null from public.task_tags where id = :TT3), 'zdjęty wcześniej tag wraca (ten sam wiersz)');
select ok(
  (select bool_and(origin = 'integration') and count(*) > 0 from public.plugin_outbox where scope_id = :W),
  'zmiana idzie jako z integracji (reguły zdarzeniowe domyślnie ją pomijają)');

select is(
  (select count(*) from public.task_tags where task_id = :T) || ':' || coalesce(public.plugin_after_send(:A, :T, 'done', jsonb_build_array(jsonb_build_object('id', :TT1, 'tagId', :G1)), array[:G2]::uuid[]), 'null')
    || ':' || (select count(*) from public.task_tags where task_id = :T),
  '3:null:3', 'powtórka nic nie zmienia');

select is(public.plugin_after_send(:A, :S, 'done', '[]', '{}'), 'Po wysyłce: status serii bez zmian (ukończ ją w aplikacji)', 'seria nie zamyka się');
select is((select status from public.tasks where id = :S), 'todo', 'seria nadal otwarta');

select is(public.plugin_after_send(:A, :T, null, jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tagId', :GB)), '{}'),
  'Po wysyłce: pominięto usunięte tagi', 'cudzy tag pominięty');

insert into public.scope_members (scope_id, user_id, role) values (:W, :B, 'viewer');
select is(public.plugin_after_send(:B, :T, 'todo', '[]', '{}'), 'Po wysyłce: brak prawa zmiany zadania — bez zmian', 'podgląd nie zmienia zadania');

update public.tasks set deleted_at = now() where id = :T;
select is(public.plugin_after_send(:A, :T, 'todo', '[]', '{}'), 'Po wysyłce: zadanie w koszu — bez zmian', 'zadanie w koszu bez zmian');

select * from finish();
rollback;
