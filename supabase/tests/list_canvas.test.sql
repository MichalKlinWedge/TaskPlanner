-- v1.x: widok „Karteczki” (migracja *_v1x_list_canvas.sql) — `tasks.canvas_pos`, `lists.canvas_groups`,
-- `task_tags.sort_key`, dostęp gości, przesunięcie karteczki poza historią zadania.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'karteczki-wl@test.local'),
  ('00000000-0000-4000-8000-0000000000f2', 'karteczki-ed@test.local'),
  ('00000000-0000-4000-8000-0000000000f3', 'karteczki-pg@test.local');

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

\set O  '''00000000-0000-4000-8000-0000000000f1'''
\set E  '''00000000-0000-4000-8000-0000000000f2'''
\set V  '''00000000-0000-4000-8000-0000000000f3'''
\set W  '''b6000000-0000-4000-8000-000000000001'''
\set L  '''c6000000-0000-4000-8000-000000000001'''
\set LV '''c6000000-0000-4000-8000-000000000002'''
\set T  '''d6000000-0000-4000-8000-000000000001'''
\set TV '''d6000000-0000-4000-8000-000000000002'''
\set G  '''e6000000-0000-4000-8000-000000000001'''
\set TT '''e6100000-0000-4000-8000-000000000001'''
\set K  '''e6200000-0000-4000-8000-000000000001'''

select pg_temp.login(:O);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Warsztat"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Pomysły'), pg_temp.h(1001)),
  pg_temp.op('lists', :LV, jsonb_build_object('scope_id', :W, 'name', 'Tylko podgląd', 'guest_access', 'view'), pg_temp.h(1002)),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Nowa strona'), pg_temp.h(1003)),
  pg_temp.op('tasks', :TV, jsonb_build_object('list_id', :LV, 'title', 'Budżet'), pg_temp.h(1004)),
  pg_temp.op('tags', :G, jsonb_build_object('name', 'pomysł', 'sort_key', '0010'), pg_temp.h(1005)),
  pg_temp.op('task_tags', :TT, jsonb_build_object('task_id', :T, 'tag_id', :G), pg_temp.h(1006)));

select is((select canvas_pos from public.tasks where id = :T), null, 'nowe zadanie bez miejsca na tablicy (pasek „Do ułożenia”)');

reset role;
create temp table log_before as select count(*) as n from public.activity_log where row_id = :T;
select pg_temp.login(:O);
select is((pg_temp.push(pg_temp.op('tasks', :T, '{"canvas_pos": {"col": 2, "row": -1}}', pg_temp.h(2000))) ->> 'applied')::int, 1, 'canvas_pos zapisywalne przez push_changes');
select is((select canvas_pos from public.tasks where id = :T), '{"col": 2, "row": -1}'::jsonb, 'karteczka w komórce');
reset role;
select is((select count(*) from public.activity_log where row_id = :T), (select n from log_before), 'przesunięcie karteczki nie trafia do historii zadania');
select pg_temp.login(:O);

select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :T, '{"canvas_pos": {"col": "a"}}', pg_temp.h(2100)))), '23514', 'canvas_pos bez liczbowych col/row odrzucone');
select is((pg_temp.push(pg_temp.op('lists', :L, jsonb_build_object('canvas_groups', jsonb_build_array(jsonb_build_object('id', :K, 'name', 'Ryzyka', 'color', null, 'col', 0, 'row', 0, 'w', 2, 'h', 1))), pg_temp.h(2200))) ->> 'applied')::int, 1,
  'lists.canvas_groups zapisywalne przez push_changes');
select is(pg_temp.code(pg_temp.push(pg_temp.op('lists', :L, '{"canvas_groups": {"id": 1}}', pg_temp.h(2300)))), '23514', 'canvas_groups innego typu niż tablica odrzucone');
select is((pg_temp.push(pg_temp.op('task_tags', :TT, '{"sort_key": "0020"}', pg_temp.h(2400))) ->> 'applied')::int, 1, 'task_tags.sort_key zapisywalne przez push_changes');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_tags', :TT, '{"sort_key": "ABC"}', pg_temp.h(2500)))), '23514', 'zły klucz kolejności tagu odrzucony');

reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :E, 'editor'), (:W, :V, 'viewer');

select pg_temp.login(:E);
select is((pg_temp.push(pg_temp.op('tasks', :T, '{"canvas_pos": {"col": 0, "row": 0}}', pg_temp.h(3000, 'ed'))) ->> 'applied')::int, 1, 'edytor przesuwa karteczkę na liście z edycją dla gości');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :TV, '{"canvas_pos": {"col": 0, "row": 0}}', pg_temp.h(3100, 'ed')))), 'TP003', 'edytor nie przesuwa karteczki na liście „tylko podgląd”');

select pg_temp.login(:V);
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :T, '{"canvas_pos": {"col": 5, "row": 5}}', pg_temp.h(3200, 'pg')))), 'TP003', 'osoba z podglądem nie przesuwa karteczek');

select * from finish();
rollback;
