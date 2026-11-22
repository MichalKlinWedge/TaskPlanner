-- v1.x: kopie współpracowników w przestrzeni (`scope_collaborators`, migracja *_v1x_scope_collaborators.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000e1', 'wlasciciel-kopia@test.local'),
  ('00000000-0000-4000-8000-0000000000e2', 'gosc-kopia@test.local');

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
-- Kopie współpracowników z `pull_changes` od zera (jak u nowego klienta).
create function pg_temp.pulled() returns jsonb language sql as $$
  select public.pull_changes('{}', 1000) -> 'tables' -> 'scope_collaborators'
$$;

\set O  '''00000000-0000-4000-8000-0000000000e1'''
\set G  '''00000000-0000-4000-8000-0000000000e2'''
\set W  '''b5000000-0000-4000-8000-000000000001'''
\set L  '''c5000000-0000-4000-8000-000000000001'''
\set W2 '''b5000000-0000-4000-8000-000000000002'''
\set LP '''c5000000-0000-4000-8000-000000000002'''
\set T  '''d5000000-0000-4000-8000-000000000001'''
\set T2 '''d5000000-0000-4000-8000-000000000002'''
\set TP '''d5000000-0000-4000-8000-000000000003'''
\set C  '''e5000000-0000-4000-8000-000000000001'''
\set D  '''e5000000-0000-4000-8000-000000000002'''
\set E  '''e5000000-0000-4000-8000-000000000003'''
\set P  '''f5000000-0000-4000-8000-000000000001'''

-- Właściciel: przestrzeń udostępniana (W) i własna (W2); Anna odpowiada za zadanie w W, Dorota
-- tylko w W2, Ewa nie jest nigdzie wskazana.
select pg_temp.login(:O);
select is((pg_temp.push(
    pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', pg_temp.h(1000)),
    pg_temp.op('workspaces', :W2, '{"name": "Moja"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
    pg_temp.op('lists', :LP, jsonb_build_object('scope_id', :W2, 'kind', 'project', 'name', 'Moje'), pg_temp.h(1001)),
    pg_temp.op('collaborators', :C, '{"name": "Anna Nowak", "acronym": "AN", "email": "anna@example.com"}', pg_temp.h(1002)),
    pg_temp.op('collaborators', :D, '{"name": "Dorota"}', pg_temp.h(1002)),
    pg_temp.op('collaborators', :E, '{"name": "Ewa"}', pg_temp.h(1002)),
    pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Raport', 'assignee_id', :C), pg_temp.h(1003)),
    pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Analiza'), pg_temp.h(1003)),
    pg_temp.op('tasks', :TP, jsonb_build_object('list_id', :LP, 'title', 'Prywatne', 'assignee_id', :D), pg_temp.h(1003))
  ) -> 'rejected'), '[]'::jsonb, 'właściciel zakłada przestrzeń, osoby i zadania');

reset role;
select is((select count(*)::int from public.scope_collaborators where scope_id = :W), 1, 'w przestrzeni kopia tylko wskazanej osoby');
select is((select scope_id from public.scope_collaborators where collaborator_id = :D), :W2::uuid, 'kopia też w nieudostępnionej przestrzeni (gotowa na udostępnienie)');
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');

-- ── Gość widzi osobę ─────────────────────────────────────────────────────────────────────────
select pg_temp.login(:G);
select is((select jsonb_agg(x ->> 'name') from jsonb_array_elements(pg_temp.pulled()) x), '["Anna Nowak"]'::jsonb, 'gość dostaje kopię odpowiedzialnego');
select is((pg_temp.pulled() -> 0 ->> 'acronym'), 'AN', 'z akronimem');
select ok(not (pg_temp.pulled() -> 0 ? 'email'), 'bez e-maila');
select is((pg_temp.pulled() -> 0 ->> 'collaborator_id'), 'e5000000-0000-4000-8000-000000000001', 'id współpracownika = assignee_id zadania');

-- ── Gość wskazuje tę samą osobę, ale nie cudzą spoza przestrzeni ─────────────────────────────
select is((pg_temp.push(pg_temp.op('tasks', :T2, jsonb_build_object('assignee_id', :C), pg_temp.h(2000))) ->> 'applied')::int, 1,
  'gość wskazuje odpowiedzialnego z kopii w przestrzeni');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :T2, jsonb_build_object('assignee_id', :E), pg_temp.h(2001)))), 'TP003',
  'cudzy współpracownik bez kopii w przestrzeni — odrzucony');
select is((pg_temp.push(pg_temp.op('task_participants', :P, jsonb_build_object('task_id', :T2, 'collaborator_id', :C), pg_temp.h(2002))) ->> 'applied')::int, 1,
  'gość dodaje uczestnika z kopii');

-- ── Zmiany współpracownika idą do kopii ──────────────────────────────────────────────────────
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('collaborators', :C, '{"name": "Anna Kowalska"}', pg_temp.h(3000)));
select pg_temp.login(:G);
select is((pg_temp.pulled() -> 0 ->> 'name'), 'Anna Kowalska', 'zmiana nazwy dociera do gościa');
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('collaborators', :C, jsonb_build_object('deleted_at', now()), pg_temp.h(3001)));
select pg_temp.login(:G);
select is(jsonb_array_length(pg_temp.pulled()), 0, 'usunięty współpracownik znika z pierwszego pobrania');

select * from finish();
rollback;
