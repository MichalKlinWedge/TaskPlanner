-- v1.x: kopie tagów w przestrzeni (`scope_tags`, migracja *_v1x_scope_tags.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'wlasciciel-tag@test.local'),
  ('00000000-0000-4000-8000-0000000000f2', 'gosc-tag@test.local');

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
-- Nazwy tagów z kopii w `pull_changes` od zera (jak u nowego klienta), alfabetycznie.
create function pg_temp.pulled_names() returns jsonb language sql as $$
  select coalesce(jsonb_agg(x ->> 'name' order by x ->> 'name'), '[]')
    from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'scope_tags') x
$$;

\set O   '''00000000-0000-4000-8000-0000000000f1'''
\set G   '''00000000-0000-4000-8000-0000000000f2'''
\set W   '''b6000000-0000-4000-8000-000000000001'''
\set L   '''c6000000-0000-4000-8000-000000000001'''
\set W2  '''b6000000-0000-4000-8000-000000000002'''
\set LP  '''c6000000-0000-4000-8000-000000000002'''
\set T   '''d6000000-0000-4000-8000-000000000001'''
\set T2  '''d6000000-0000-4000-8000-000000000002'''
\set TP  '''d6000000-0000-4000-8000-000000000003'''
\set A   '''e6000000-0000-4000-8000-000000000001'''
\set B   '''e6000000-0000-4000-8000-000000000002'''
\set X   '''e6000000-0000-4000-8000-000000000003'''
\set TT1 '''f6000000-0000-4000-8000-000000000001'''
\set TT2 '''f6000000-0000-4000-8000-000000000002'''
\set TT3 '''f6000000-0000-4000-8000-000000000003'''
\set TT4 '''f6000000-0000-4000-8000-000000000004'''

-- Właściciel: przestrzeń udostępniana (W) i własna (W2). „pilne” na zadaniu w W, „prywatny” tylko
-- w W2, „lista” przypisany wprost do W („Widoczny w”), bez zadań.
select pg_temp.login(:O);
select is((pg_temp.push(
    pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', pg_temp.h(1000)),
    pg_temp.op('workspaces', :W2, '{"name": "Moja"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
    pg_temp.op('lists', :LP, jsonb_build_object('scope_id', :W2, 'kind', 'project', 'name', 'Moje'), pg_temp.h(1001)),
    pg_temp.op('tags', :A, '{"name": "pilne", "color": "#DC2626", "sort_key": "a0"}', pg_temp.h(1002)),
    pg_temp.op('tags', :B, '{"name": "prywatny", "sort_key": "a1"}', pg_temp.h(1002)),
    pg_temp.op('tags', :X, jsonb_build_object('name', 'lista', 'sort_key', 'a2', 'workspace_ids', jsonb_build_array(:W)), pg_temp.h(1002)),
    pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Raport'), pg_temp.h(1003)),
    pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Analiza'), pg_temp.h(1003)),
    pg_temp.op('tasks', :TP, jsonb_build_object('list_id', :LP, 'title', 'Prywatne'), pg_temp.h(1003)),
    pg_temp.op('task_tags', :TT1, jsonb_build_object('task_id', :T, 'tag_id', :A), pg_temp.h(1004)),
    pg_temp.op('task_tags', :TT2, jsonb_build_object('task_id', :TP, 'tag_id', :B), pg_temp.h(1004))
  ) -> 'rejected'), '[]'::jsonb, 'właściciel zakłada przestrzenie, tagi i zadania z tagami');

reset role;
select is((select count(*)::int from public.scope_tags where scope_id = :W), 2, 'w przestrzeni kopie tagu z zadania i tagu przypisanego wprost');
select is((select scope_id from public.scope_tags where tag_id = :B), :W2::uuid, 'tag z W2 skopiowany tylko do W2');
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');

-- ── Gość widzi tagi przestrzeni ──────────────────────────────────────────────────────────────
select pg_temp.login(:G);
select is(pg_temp.pulled_names(), '["lista", "pilne"]'::jsonb, 'gość dostaje kopie tagów swojej przestrzeni');
select is((select x ->> 'color' from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'scope_tags') x where x ->> 'name' = 'pilne'),
  '#DC2626', 'z kolorem');

-- ── Gość przypina i zdejmuje tagi właściciela ────────────────────────────────────────────────
select is((pg_temp.push(pg_temp.op('task_tags', :TT3, jsonb_build_object('task_id', :T2, 'tag_id', :A), pg_temp.h(2000))) ->> 'applied')::int, 1,
  'gość przypina tag z kopii w przestrzeni');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_tags', :TT4, jsonb_build_object('task_id', :T2, 'tag_id', :B), pg_temp.h(2001)))), 'TP003',
  'cudzy tag bez kopii w przestrzeni — odrzucony');
select is((pg_temp.push(pg_temp.op('task_tags', :TT1, jsonb_build_object('deleted_at', now()), pg_temp.h(2002))) ->> 'applied')::int, 1,
  'gość zdejmuje tag właściciela z zadania');

-- ── Zmiany tagu idą do kopii ─────────────────────────────────────────────────────────────────
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tags', :A, '{"name": "bardzo pilne", "color": "#16A34A"}', pg_temp.h(3000)));
select pg_temp.login(:G);
select is(pg_temp.pulled_names(), '["bardzo pilne", "lista"]'::jsonb, 'zmiana nazwy dociera do gościa');
select is((select x ->> 'color' from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'scope_tags') x where x ->> 'name' = 'bardzo pilne'),
  '#16A34A', 'zmiana koloru też');

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tags', :X, '{"workspace_ids": null}', pg_temp.h(3001)));
select pg_temp.login(:G);
select is(pg_temp.pulled_names(), '["bardzo pilne"]'::jsonb, 'przestrzeń zdjęta z „Widoczny w” nieużywanego tagu — kopia znika');

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tags', :A, jsonb_build_object('deleted_at', now()), pg_temp.h(3002)));
select pg_temp.login(:G);
select is(pg_temp.pulled_names(), '[]'::jsonb, 'usunięty tag znika z pierwszego pobrania');

select * from finish();
rollback;
