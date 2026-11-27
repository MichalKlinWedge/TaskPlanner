-- v1.x: osoby po autorze, który opuścił przestrzeń (migracja *_v1x_collaborator_takeover.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'stary-wlasciciel@test.local'),
  ('00000000-0000-4000-8000-0000000000f2', 'nowy-wlasciciel@test.local');

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
create function pg_temp.live(p_scope uuid, p_collaborator uuid) returns boolean language sql security definer as $$
  select exists (select 1 from public.scope_collaborators where scope_id = p_scope and collaborator_id = p_collaborator and deleted_at is null)
$$;

\set O '''00000000-0000-4000-8000-0000000000f1'''
\set N '''00000000-0000-4000-8000-0000000000f2'''
\set W '''b6000000-0000-4000-8000-000000000001'''
\set L '''c6000000-0000-4000-8000-000000000001'''
\set T '''d6000000-0000-4000-8000-000000000001'''
\set T2 '''d6000000-0000-4000-8000-000000000002'''
\set C '''e6000000-0000-4000-8000-000000000001'''
\set D '''e6000000-0000-4000-8000-000000000002'''
\set X '''e6000000-0000-4000-8000-000000000003'''
\set P '''f6000000-0000-4000-8000-000000000001'''
\set PX '''f6000000-0000-4000-8000-000000000002'''

-- Stary właściciel: Anna (C) odpowiada za zadanie i jest uczestnikiem drugiego; Dorota (D) tylko
-- przypisana do przestrzeni (`workspace_ids`), nigdzie nieużyta.
select pg_temp.login(:O);
select is((pg_temp.push(
    pg_temp.op('workspaces', :W, '{"name": "Firma"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
    pg_temp.op('collaborators', :C, '{"name": "Anna", "acronym": "AN"}', pg_temp.h(1002)),
    pg_temp.op('collaborators', :D, jsonb_build_object('name', 'Dorota', 'workspace_ids', jsonb_build_array(:W)), pg_temp.h(1002)),
    pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Raport', 'assignee_id', :C), pg_temp.h(1003)),
    pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Analiza'), pg_temp.h(1003)),
    pg_temp.op('task_participants', :P, jsonb_build_object('task_id', :T2, 'collaborator_id', :C), pg_temp.h(1004))
  ) -> 'rejected'), '[]'::jsonb, 'stary właściciel zakłada przestrzeń i osoby');

-- Przekazanie przestrzeni: nowy właściciel zostaje, stary wychodzi.
reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :N, 'owner');
update public.sync_scopes set owner_id = :N where id = :W;
delete from public.scope_members where scope_id = :W and user_id = :O;
select ok(pg_temp.live(:W, :C), 'używana osoba po starym właścicielu zostaje');
select ok(not pg_temp.live(:W, :D), 'nieużywana osoba po starym właścicielu znika');

-- Przejęcie: własny wpis, zadania przepięte — kopia Anny znika.
select pg_temp.login(:N);
select is((pg_temp.push(
    pg_temp.op('collaborators', :X, jsonb_build_object('name', 'Anna', 'acronym', 'AN', 'workspace_ids', jsonb_build_array(:W)), pg_temp.h(2000)),
    pg_temp.op('tasks', :T, jsonb_build_object('assignee_id', :X), pg_temp.h(2001))
  ) -> 'rejected'), '[]'::jsonb, 'nowy właściciel przepina odpowiedzialnego na swój wpis');
reset role;
select ok(pg_temp.live(:W, :C), 'Anna nadal uczestnikiem — kopia zostaje');
select pg_temp.login(:N);
select pg_temp.push(
  pg_temp.op('task_participants', :P, jsonb_build_object('deleted_at', now()), pg_temp.h(2002)),
  pg_temp.op('task_participants', :PX, jsonb_build_object('task_id', :T2, 'collaborator_id', :X), pg_temp.h(2002)));
reset role;
select ok(not pg_temp.live(:W, :C), 'po przepięciu uczestnika kopia po starym właścicielu znika');

-- Osoba członka przestrzeni: po zdjęciu z zadania kopia zostaje (jak dotąd).
select pg_temp.login(:N);
select pg_temp.push(pg_temp.op('tasks', :T, jsonb_build_object('assignee_id', null), pg_temp.h(2003)));
reset role;
select ok(pg_temp.live(:W, :X), 'kopia osoby członka zostaje po zdjęciu z zadania');

select * from finish();
rollback;
