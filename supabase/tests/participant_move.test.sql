-- v1.x: przeniesienie zadania z uczestnikiem innego członka do innej przestrzeni
-- (migracja *_v1x_participant_move.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'autor-osob@test.local'),
  ('00000000-0000-4000-8000-0000000000a2', 'przenoszacy@test.local');

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
create function pg_temp.code(p_result jsonb) returns text language sql as $$
  select p_result -> 'rejected' -> 0 ->> 'code'
$$;
create function pg_temp.live(p_scope uuid, p_collaborator uuid) returns boolean language sql security definer as $$
  select exists (select 1 from public.scope_collaborators where scope_id = p_scope and collaborator_id = p_collaborator and deleted_at is null)
$$;
create function pg_temp.participant_scope(p_id uuid) returns uuid language sql security definer as $$
  select scope_id from public.task_participants where id = p_id
$$;

\set A '''00000000-0000-4000-8000-0000000000a1'''
\set M '''00000000-0000-4000-8000-0000000000a2'''
\set W1 '''b7000000-0000-4000-8000-000000000001'''
\set W2 '''b7000000-0000-4000-8000-000000000002'''
\set L1 '''c7000000-0000-4000-8000-000000000001'''
\set L2 '''c7000000-0000-4000-8000-000000000002'''
\set T '''d7000000-0000-4000-8000-000000000001'''
\set T2 '''d7000000-0000-4000-8000-000000000002'''
\set T3 '''d7000000-0000-4000-8000-000000000003'''
\set C '''e7000000-0000-4000-8000-000000000001'''
\set D '''e7000000-0000-4000-8000-000000000002'''
\set P '''f7000000-0000-4000-8000-000000000001'''
\set PD '''f7000000-0000-4000-8000-000000000002'''
\set PX '''f7000000-0000-4000-8000-000000000004'''

-- Autor: przestrzeń „Firma” z zadaniami; Cezary (C) uczestnikiem zadania T, Dorota (D) uczestnikiem
-- zadania T2, ale już usuniętym.
select pg_temp.login(:A);
select is((pg_temp.push(
    pg_temp.op('workspaces', :W1, '{"name": "Firma"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L1, jsonb_build_object('scope_id', :W1, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
    pg_temp.op('collaborators', :C, '{"name": "Cezary", "acronym": "CZ"}', pg_temp.h(1002)),
    pg_temp.op('collaborators', :D, '{"name": "Dorota"}', pg_temp.h(1002)),
    pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L1, 'title', 'Rozmowa'), pg_temp.h(1003)),
    pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L1, 'title', 'Notatka'), pg_temp.h(1003)),
    pg_temp.op('task_participants', :P, jsonb_build_object('task_id', :T, 'collaborator_id', :C), pg_temp.h(1004)),
    pg_temp.op('task_participants', :PD, jsonb_build_object('task_id', :T2, 'collaborator_id', :D), pg_temp.h(1004))
  ) -> 'rejected'), '[]'::jsonb, 'autor zakłada przestrzeń, osoby i uczestników');
select pg_temp.push(pg_temp.op('task_participants', :PD, jsonb_build_object('deleted_at', now()), pg_temp.h(1005)));

-- Drugi członek (edycja w „Firma”) ma własną przestrzeń „Prywatne”, w której autora nie ma.
reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W1, :M, 'editor');
select pg_temp.login(:M);
select pg_temp.push(
  pg_temp.op('workspaces', :W2, '{"name": "Prywatne"}', pg_temp.h(2000)),
  pg_temp.op('lists', :L2, jsonb_build_object('scope_id', :W2, 'kind', 'project', 'name', 'Moje'), pg_temp.h(2001)));

select is((pg_temp.push(pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L2), pg_temp.h(2002))) -> 'rejected'),
  '[]'::jsonb, 'zadanie z uczestnikiem autora przechodzi do innej przestrzeni');
select is(pg_temp.participant_scope(:P), :W2::uuid, 'uczestnik idzie za zadaniem');
reset role;
select ok(pg_temp.live(:W2, :C), 'osoba dostaje kopię w przestrzeni docelowej');
select ok(pg_temp.live(:W1, :C), 'kopia w przestrzeni źródłowej zostaje — autor jest jej członkiem');

select pg_temp.login(:M);
select is((pg_temp.push(pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L2), pg_temp.h(2003))) -> 'rejected'),
  '[]'::jsonb, 'usunięty uczestnik nie blokuje przeniesienia');

-- Wskazanie nadal sprawdzane: osoba autora bez kopii w „Prywatne” — odrzucone.
select pg_temp.push(pg_temp.op('tasks', :T3, jsonb_build_object('list_id', :L2, 'title', 'Inne'), pg_temp.h(2004)));
select is(pg_temp.code(pg_temp.push(
    pg_temp.op('task_participants', :PX, jsonb_build_object('task_id', :T3, 'collaborator_id', :D), pg_temp.h(2005)))),
  'TP003', 'nowy uczestnik spoza kopii w przestrzeni nadal odrzucony');
select is(pg_temp.code(pg_temp.push(
    pg_temp.op('task_participants', :PD, jsonb_build_object('deleted_at', null), pg_temp.h(2006)))),
  'TP003', 'przywrócenie usuniętego uczestnika bez kopii odrzucone');

select * from finish();
rollback;
