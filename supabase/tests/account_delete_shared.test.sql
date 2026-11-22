-- v1.x: usunięcie konta, którego tag i współpracownik są użyte w cudzej przestrzeni
-- (migracja *_v1x_account_delete_shared.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'wlasciciel-konto@test.local'),
  ('00000000-0000-4000-8000-0000000000a2', 'gosc-konto@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- Jak `auth.admin.deleteUser`: bez JWT użytkownika.
create function pg_temp.logout() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true)
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

\set O   '''00000000-0000-4000-8000-0000000000a1'''
\set G   '''00000000-0000-4000-8000-0000000000a2'''
\set W   '''b7000000-0000-4000-8000-000000000001'''
\set WG  '''b7000000-0000-4000-8000-000000000002'''
\set L   '''c7000000-0000-4000-8000-000000000001'''
\set LG  '''c7000000-0000-4000-8000-000000000002'''
\set T   '''d7000000-0000-4000-8000-000000000001'''
\set T2  '''d7000000-0000-4000-8000-000000000002'''
\set TG  '''d7000000-0000-4000-8000-000000000003'''
\set GT  '''e7000000-0000-4000-8000-000000000001'''
\set GC  '''e7000000-0000-4000-8000-000000000002'''
\set TT1 '''f7000000-0000-4000-8000-000000000001'''
\set TT2 '''f7000000-0000-4000-8000-000000000002'''
\set TT3 '''f7000000-0000-4000-8000-000000000003'''
\set P1  '''a7000000-0000-4000-8000-000000000001'''
\set P2  '''a7000000-0000-4000-8000-000000000002'''

-- Właściciel: przestrzeń W z dwoma zadaniami, gość (edytor) w W.
select pg_temp.login(:O);
select is((pg_temp.push(
    pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
    pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Raport'), pg_temp.h(1002)),
    pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Analiza'), pg_temp.h(1002))
  ) -> 'rejected'), '[]'::jsonb, 'właściciel zakłada przestrzeń i zadania');
reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');

-- Gość: własny tag i współpracownik użyte w W i we własnej przestrzeni WG.
select pg_temp.login(:G);
select is((pg_temp.push(
    pg_temp.op('tags', :GT, '{"name": "gościa", "sort_key": "a0"}', pg_temp.h(2000)),
    pg_temp.op('collaborators', :GC, '{"name": "Gustaw"}', pg_temp.h(2000)),
    pg_temp.op('workspaces', :WG, '{"name": "Gościa"}', pg_temp.h(2000)),
    pg_temp.op('lists', :LG, jsonb_build_object('scope_id', :WG, 'kind', 'project', 'name', 'Moje'), pg_temp.h(2001)),
    pg_temp.op('tasks', :TG, jsonb_build_object('list_id', :LG, 'title', 'Moje', 'assignee_id', :GC), pg_temp.h(2002)),
    pg_temp.op('task_tags', :TT3, jsonb_build_object('task_id', :TG, 'tag_id', :GT), pg_temp.h(2003)),
    pg_temp.op('task_participants', :P2, jsonb_build_object('task_id', :TG, 'collaborator_id', :GC), pg_temp.h(2003)),
    pg_temp.op('tasks', :T, jsonb_build_object('assignee_id', :GC), pg_temp.h(2004)),
    pg_temp.op('task_tags', :TT1, jsonb_build_object('task_id', :T, 'tag_id', :GT), pg_temp.h(2004)),
    pg_temp.op('task_participants', :P1, jsonb_build_object('task_id', :T2, 'collaborator_id', :GC), pg_temp.h(2004))
  ) -> 'rejected'), '[]'::jsonb, 'gość przypina swój tag i wskazuje swoją osobę w W i WG');

-- Właściciel przypina tag gościa z kopii w przestrzeni.
select pg_temp.login(:O);
select is((pg_temp.push(pg_temp.op('task_tags', :TT2, jsonb_build_object('task_id', :T2, 'tag_id', :GT), pg_temp.h(3000))) ->> 'applied')::int, 1,
  'właściciel przypina tag gościa');

reset role;
select sync_version as v0 from public.sync_scopes where id = :W \gset

-- ── Usunięcie konta gościa ───────────────────────────────────────────────────────────────────
select pg_temp.logout();
select lives_ok(format('delete from auth.users where id = %L', :G), 'konto gościa usuwa się mimo tagu i osoby w cudzej przestrzeni');
select is((select count(*)::int from public.sync_scopes where id in (:G, :WG)), 0, 'zakres osobisty i przestrzeń gościa usunięte');
select is((select count(*)::int from public.tags where id = :GT) + (select count(*)::int from public.collaborators where id = :GC), 0,
  'tag i współpracownik gościa usunięci');

-- ── Właściciel dostaje zmiany w pull_changes ─────────────────────────────────────────────────
select pg_temp.login(:O);
-- Jedno pobranie przyrostowe od wersji W sprzed usunięcia.
create temp table pulled as select public.pull_changes(jsonb_build_object(:W, :v0), 1000) -> 'tables' as t;
select is((select jsonb_agg(x ->> 'id' order by x ->> 'id') from pulled, jsonb_array_elements(t -> 'task_tags') x where x ->> 'deleted_at' is not null),
  jsonb_build_array(:TT1, :TT2), 'oba przypięcia tagu gościa przychodzą jako usunięte');
select is((select x ->> 'assignee_id' from pulled, jsonb_array_elements(t -> 'tasks') x where x ->> 'id' = :T), null::text,
  'zadanie bez odpowiedzialnego (wraca do twórcy)');
select ok((select x -> 'field_clock' ? 'assignee_id' from pulled, jsonb_array_elements(t -> 'tasks') x where x ->> 'id' = :T),
  'z HLC serwera dla assignee_id');
select is((select x ->> 'id' from pulled, jsonb_array_elements(t -> 'task_participants') x where x ->> 'deleted_at' is not null), :P1,
  'uczestnik gościa przychodzi jako usunięty');
select is((select count(*)::int from pulled, jsonb_array_elements(t -> 'scope_tags') x where x ->> 'tag_id' = :GT and x ->> 'deleted_at' is not null), 1,
  'kopia tagu w przestrzeni przychodzi jako usunięta');
select is((select count(*)::int from pulled, jsonb_array_elements(t -> 'scope_collaborators') x where x ->> 'collaborator_id' = :GC and x ->> 'deleted_at' is not null), 1,
  'kopia osoby w przestrzeni przychodzi jako usunięta');
select is((select count(*)::int from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'scope_tags') x), 0,
  'pierwsze pobranie bez kopii usuniętego tagu');

-- ── Nagrobki nie dają się przywrócić ani wskazać ─────────────────────────────────────────────
-- HLC nowszy od serwerowego z usunięcia (inaczej operacja byłaby po prostu starsza i pominięta).
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_tags', :TT2, jsonb_build_object('deleted_at', null), pg_temp.h(900000000000000)))), '23503',
  'przywrócenie przypięcia usuniętego tagu — odrzucone');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :T2, jsonb_build_object('assignee_id', :GC), pg_temp.h(900000000000001)))), '23503',
  'wskazanie usuniętej osoby — odrzucone');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_participants', :P1, jsonb_build_object('deleted_at', null), pg_temp.h(900000000000002)))), '23503',
  'przywrócenie usuniętego uczestnika — odrzucone');

select * from finish();
rollback;
