-- v1.x: integracje wychodzące, etap I3 (migracja *_v1x_plugin_links.sql) — powiązania zadanie ↔ obiekt zewnętrzny:
-- pisze tylko serwer, klient czyta własne, usunięcie połączenia (twarde) albo zadania czyści powiązanie.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000003a1', 'linki-a@test.local'),
  ('00000000-0000-4000-8000-0000000003a2', 'linki-b@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;

\set A '''00000000-0000-4000-8000-0000000003a1'''
\set B '''00000000-0000-4000-8000-0000000003a2'''
\set C '''e9000000-0000-4000-8000-000000000001'''
\set W '''b9000000-0000-4000-8000-000000000001'''
\set L '''c9000000-0000-4000-8000-000000000001'''
\set T '''d9000000-0000-4000-8000-000000000001'''

create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;

select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name": "GitLab"}', '000000000001000:00000:dev'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), '000000000001001:00000:dev'),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Zgłoszenie'), '000000000001002:00000:dev')));
reset role;
insert into public.plugin_connections (id, user_id, plugin, label, config) values (:C, :A, 'gitlab', 'GitLab', '{"baseUrl": "https://gitlab.com", "project": "g/p"}');
insert into public.plugin_links (connection_id, task_id, user_id, external_id, external_url) values (:C, :T, :A, '7:12', 'https://gitlab.com/g/p/-/issues/12');

select pg_temp.login(:A);
select is((select external_id from public.plugin_links), '7:12', 'właściciel widzi swoje powiązanie');
select throws_ok($$ insert into public.plugin_links (connection_id, task_id, user_id, external_id) values ('e9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003a1', '1:1') $$,
  '42501', null, 'klient nie zapisuje powiązań');
select pg_temp.login(:B);
select is((select count(*) from public.plugin_links), 0::bigint, 'inna osoba nie widzi cudzych powiązań');
reset role;

select throws_ok($$ insert into public.plugin_links (connection_id, task_id, user_id, external_id) values ('e9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003a1', '7:13') $$,
  '23505', null, 'jedno powiązanie na zadanie i połączenie');
delete from public.tasks where id = :T;
select is((select count(*) from public.plugin_links where connection_id = :C), 0::bigint, 'usunięcie zadania usuwa powiązanie');
select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Zgłoszenie'), '000000000002000:00000:dev')));
reset role;
insert into public.plugin_links (connection_id, task_id, user_id, external_id) values (:C, :T, :A, '7:12');
delete from public.plugin_connections where id = :C;
select is((select count(*) from public.plugin_links where connection_id = :C), 0::bigint, 'usunięcie połączenia usuwa powiązanie');

select * from finish();
rollback;
