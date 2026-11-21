-- v1.x: własne kolumny tablicy listy (migracje *_v1x_board_columns.sql, *_v1x_list_board_columns.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000e1', 'kolumny-tablicy@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.h(p_wall bigint, p_node text default 'dev') returns text language sql as $$
  select lpad(p_wall::text, 15, '0') || ':00000:' || p_node
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;
create function pg_temp.code(p_result jsonb) returns text language sql as $$
  select p_result -> 'rejected' -> 0 ->> 'code'
$$;

\set U  '''00000000-0000-4000-8000-0000000000e1'''
\set W  '''b5000000-0000-4000-8000-000000000001'''
\set L  '''c5000000-0000-4000-8000-000000000001'''
\set T  '''d5000000-0000-4000-8000-000000000001'''
\set K  '''e5000000-0000-4000-8000-000000000001'''

select pg_temp.login(:U);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Dom"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Kupić farbę'), pg_temp.h(1002)));

select is((select board_columns from public.lists where id = :L), null, 'domyślnie lista bez własnych kolumn');
select is((pg_temp.push(pg_temp.op('lists', :L, jsonb_build_object('board_columns', jsonb_build_array(jsonb_build_object('id', :K, 'name', 'Zakupy'))), pg_temp.h(2000))) ->> 'applied')::int, 1,
  'lists.board_columns zapisywalne przez push_changes');
select is(pg_temp.code(pg_temp.push(pg_temp.op('lists', :L, '{"board_columns": "Zakupy"}', pg_temp.h(2100)))), '23514', 'board_columns innego typu niż tablica odrzucone');
select is((select board_column_id from public.tasks where id = :T), null, 'zadanie domyślnie „Do przypisania”');
select is((pg_temp.push(pg_temp.op('tasks', :T, jsonb_build_object('board_column_id', :K), pg_temp.h(2200))) ->> 'applied')::int, 1, 'board_column_id zapisywalne przez push_changes');
select is((select board_column_id from public.tasks where id = :T), :K::uuid, 'zadanie w kolumnie');

select * from finish();
rollback;
