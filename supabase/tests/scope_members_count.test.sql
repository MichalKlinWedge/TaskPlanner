-- v1.x: liczba członków przestrzeni w `pull_changes` (`scopes[id].members`) — ikona udostępnienia przy listach.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000d1', 'wlasciciel-cnt@test.local'),
  ('00000000-0000-4000-8000-0000000000d2', 'gosc-cnt@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.members(p_scope text) returns int language sql as $$
  select (public.pull_changes('{}', 1000) -> 'scopes' -> p_scope ->> 'members')::int
$$;

\set O '''00000000-0000-4000-8000-0000000000d1'''
\set G '''00000000-0000-4000-8000-0000000000d2'''
\set W '''f8000000-0000-4000-8000-000000000001'''

select pg_temp.login(:O);
select is((public.push_changes(jsonb_build_array(jsonb_build_object(
  'op', gen_random_uuid(), 'table', 'workspaces', 'id', :W, 'set', '{"name":"Licznik"}'::jsonb,
  'hlc', lpad((floor(extract(epoch from clock_timestamp()) * 1000))::bigint::text, 15, '0') || ':00000:dev'))) -> 'rejected'),
  '[]'::jsonb, 'właściciel zakłada przestrzeń');
select is(pg_temp.members('f8000000-0000-4000-8000-000000000001'), 1, 'sama przestrzeń właściciela: 1 członek');
select is(pg_temp.members('00000000-0000-4000-8000-0000000000d1'), 1, 'zakres osobisty: 1 członek');

reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');

select pg_temp.login(:G);
select is(pg_temp.members('f8000000-0000-4000-8000-000000000001'), 2, 'udostępniona przestrzeń: 2 członków (także u gościa)');

select * from finish();
rollback;
