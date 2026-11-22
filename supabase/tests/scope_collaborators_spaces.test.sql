-- v1.x: kopie współpracowników przypisanych do przestrzeni w „Widoczny w” (migracja *_v1x_scope_collaborators_spaces.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'wlasciciel-ws@test.local'),
  ('00000000-0000-4000-8000-0000000000f2', 'gosc-ws@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.h(p_wall bigint) returns text language sql as $$
  select lpad(p_wall::text, 15, '0') || ':00000:dev'
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;
create function pg_temp.live(p_collaborator uuid) returns text language sql as $$
  select coalesce(string_agg(scope_id::text, ',' order by scope_id), '')
    from public.scope_collaborators where collaborator_id = p_collaborator and deleted_at is null
$$;

\set O  '''00000000-0000-4000-8000-0000000000f1'''
\set G  '''00000000-0000-4000-8000-0000000000f2'''
\set W  '''b6000000-0000-4000-8000-000000000001'''
\set W2 '''b6000000-0000-4000-8000-000000000002'''
\set L  '''c6000000-0000-4000-8000-000000000001'''
\set T  '''d6000000-0000-4000-8000-000000000001'''
\set C  '''e6000000-0000-4000-8000-000000000001'''
\set A  '''e6000000-0000-4000-8000-000000000002'''
\set N  '''e6000000-0000-4000-8000-000000000003'''

select pg_temp.login(:O);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', pg_temp.h(1000)),
  pg_temp.op('workspaces', :W2, '{"name": "Moja"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Raport'), pg_temp.h(1001)));
reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');

-- Gość wpisuje swoich współpracowników: Celinę do wspólnej przestrzeni, Adama — do wszystkich (null).
select pg_temp.login(:G);
select pg_temp.push(
  pg_temp.op('collaborators', :C, jsonb_build_object('name', 'Celina', 'workspace_ids', jsonb_build_array(:W)), pg_temp.h(2000)),
  pg_temp.op('collaborators', :A, '{"name": "Adam"}', pg_temp.h(2000)),
  pg_temp.op('collaborators', :N, jsonb_build_object('name', 'Nina', 'workspace_ids', jsonb_build_array(:W2)), pg_temp.h(2000)));
reset role;
select is(pg_temp.live(:C), 'b6000000-0000-4000-8000-000000000001', 'przypisana do przestrzeni wprost — kopia');
select is(pg_temp.live(:A), '', '„wszystkie przestrzenie” nie rozsyła książki adresowej');
select is(pg_temp.live(:N), '', 'przestrzeń, do której wpisujący nie należy — bez kopii');

select pg_temp.login(:O);
select is((select jsonb_agg(x ->> 'name') from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'scope_collaborators') x),
  '["Celina"]'::jsonb, 'właściciel widzi osobę wpisaną przez gościa');

-- Celina odpowiada za zadanie, potem gość zdejmuje przestrzeń — kopia zostaje (osoba w użyciu).
select pg_temp.login(:G);
select pg_temp.push(pg_temp.op('tasks', :T, jsonb_build_object('assignee_id', :C), pg_temp.h(3000)));
select pg_temp.push(pg_temp.op('collaborators', :C, '{"workspace_ids": null}', pg_temp.h(3001)));
reset role;
select is(pg_temp.live(:C), 'b6000000-0000-4000-8000-000000000001', 'zdjęta z przestrzeni, ale w użyciu — kopia zostaje');

-- Bez użycia: zdjęcie przestrzeni usuwa kopię, ponowne przypisanie ją przywraca.
select pg_temp.login(:G);
select pg_temp.push(pg_temp.op('tasks', :T, '{"assignee_id": null}', pg_temp.h(4000)));
select pg_temp.push(pg_temp.op('collaborators', :C, jsonb_build_object('workspace_ids', jsonb_build_array(:W)), pg_temp.h(4001)));
select pg_temp.push(pg_temp.op('collaborators', :C, '{"workspace_ids": null}', pg_temp.h(4002)));
reset role;
select is(pg_temp.live(:C), '', 'zdjęta i nieużywana — kopia usunięta');
select pg_temp.login(:G);
select pg_temp.push(pg_temp.op('collaborators', :C, jsonb_build_object('workspace_ids', jsonb_build_array(:W)), pg_temp.h(5000)));
reset role;
select is(pg_temp.live(:C), 'b6000000-0000-4000-8000-000000000001', 'ponowne przypisanie przywraca kopię');

select * from finish();
rollback;
