-- v1.x: tagi widoczne w wybranych przestrzeniach (migracja *_v1x_tag_workspaces.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000d1', 'tagi-przestrzenie@test.local');

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

\set U  '''00000000-0000-4000-8000-0000000000d1'''
\set W  '''b4000000-0000-4000-8000-000000000001'''
\set G  '''f4000000-0000-4000-8000-000000000001'''

select pg_temp.login(:U);
select pg_temp.push(pg_temp.op('workspaces', :W, '{"name": "Praca"}', pg_temp.h(1000)));

select is((pg_temp.push(pg_temp.op('tags', :G, '{"name": "telefon"}', pg_temp.h(2000))) ->> 'applied')::int, 1, 'tag bez przestrzeni (jak dotąd)');
select is((select workspace_ids from public.tags where id = :G), null, 'domyślnie workspace_ids = null (wszystkie przestrzenie)');
select is((pg_temp.push(pg_temp.op('tags', :G, jsonb_build_object('workspace_ids', jsonb_build_array(:W)), pg_temp.h(2100))) ->> 'applied')::int, 1,
  'workspace_ids zapisywalne przez push_changes');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tags', :G, '{"workspace_ids": "Praca"}', pg_temp.h(2200)))), '23514', 'workspace_ids innego typu niż tablica odrzucone');

select * from finish();
rollback;
