-- v1.x: strzałki w widoku „Karteczki” (migracja *_v1x_task_derived_from.sql) — „wynika z” w
-- `tasks.derived_from` (jedno pole LWW, walidacja, poza historią zadania, dostęp gości) i „blokuje” jako
-- zwykła zależność z odrzuceniem cyklu.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000e1', 'strzalki-wl@test.local'),
  ('00000000-0000-4000-8000-0000000000e2', 'strzalki-ed@test.local'),
  ('00000000-0000-4000-8000-0000000000e3', 'strzalki-pg@test.local');

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

\set O  '''00000000-0000-4000-8000-0000000000e1'''
\set E  '''00000000-0000-4000-8000-0000000000e2'''
\set V  '''00000000-0000-4000-8000-0000000000e3'''
\set W  '''b7000000-0000-4000-8000-000000000001'''
\set L  '''c7000000-0000-4000-8000-000000000001'''
\set LV '''c7000000-0000-4000-8000-000000000002'''
\set A  '''d7000000-0000-4000-8000-000000000001'''
\set B  '''d7000000-0000-4000-8000-000000000002'''
\set C  '''d7000000-0000-4000-8000-000000000003'''
\set TV '''d7000000-0000-4000-8000-000000000004'''
\set D1 '''e7000000-0000-4000-8000-000000000001'''
\set D2 '''e7000000-0000-4000-8000-000000000002'''

select pg_temp.login(:O);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Burza"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Pomysły'), pg_temp.h(1001)),
  pg_temp.op('lists', :LV, jsonb_build_object('scope_id', :W, 'name', 'Tylko podgląd', 'guest_access', 'view'), pg_temp.h(1002)),
  pg_temp.op('tasks', :A, jsonb_build_object('list_id', :L, 'title', 'Pomysł A'), pg_temp.h(1003)),
  pg_temp.op('tasks', :B, jsonb_build_object('list_id', :L, 'title', 'Pomysł B'), pg_temp.h(1004)),
  pg_temp.op('tasks', :C, jsonb_build_object('list_id', :L, 'title', 'Pomysł C'), pg_temp.h(1005)),
  pg_temp.op('tasks', :TV, jsonb_build_object('list_id', :LV, 'title', 'Budżet'), pg_temp.h(1006)));

select is((select derived_from from public.tasks where id = :B), null, 'nowe zadanie bez „wynika z”');

reset role;
create temp table log_before as select count(*) as n from public.activity_log where row_id = :B;
select pg_temp.login(:O);
select is((pg_temp.push(pg_temp.op('tasks', :B, jsonb_build_object('derived_from', jsonb_build_array(:A)), pg_temp.h(2000))) ->> 'applied')::int, 1, 'derived_from zapisywalne przez push_changes');
select is((select derived_from from public.tasks where id = :B), jsonb_build_array(:A), 'B wynika z A');
reset role;
select is((select count(*) from public.activity_log where row_id = :B), (select n from log_before), 'zmiana „wynika z” nie trafia do historii zadania');
select pg_temp.login(:O);

-- LWW całej listy: nowszy zapis zastępuje listę w całości, starszy (inne urządzenie) nic nie zmienia.
select pg_temp.push(pg_temp.op('tasks', :B, jsonb_build_object('derived_from', jsonb_build_array(:C)), pg_temp.h(2200, 'tel')));
select pg_temp.push(pg_temp.op('tasks', :B, jsonb_build_object('derived_from', jsonb_build_array(:A, :C)), pg_temp.h(2100, 'web')));
select is((select derived_from from public.tasks where id = :B), jsonb_build_array(:C), 'starsza lista nie skleja się z nowszą (jedno pole LWW)');

select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :B, '{"derived_from": {"id": 1}}', pg_temp.h(2300)))), '23514', 'derived_from innego typu niż tablica odrzucone');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :B, '{"derived_from": [1]}', pg_temp.h(2310)))), '23514', 'derived_from z elementem innym niż tekst odrzucone');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :B, '{"derived_from": []}', pg_temp.h(2320)))), '23514', 'pusta lista odrzucona (brak = null)');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :B, jsonb_build_object('derived_from', (select jsonb_agg(gen_random_uuid()::text) from generate_series(1, 51))), pg_temp.h(2330)))), '23514', 'więcej niż 50 źródeł odrzucone');
select is((pg_temp.push(pg_temp.op('tasks', :B, '{"derived_from": null}', pg_temp.h(2400))) ->> 'applied')::int, 1, 'usunięcie ostatniego powiązania = null');

-- „blokuje” = zwykła zależność; cykl odrzuca serwer.
select is((pg_temp.push(pg_temp.op('task_dependencies', :D1, jsonb_build_object('predecessor_id', :A, 'successor_id', :B), pg_temp.h(2500))) ->> 'applied')::int, 1, 'A blokuje B — wiersz zależności');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_dependencies', :D2, jsonb_build_object('predecessor_id', :B, 'successor_id', :A), pg_temp.h(2510)))), 'TP002', 'B blokuje A — cykl odrzucony');
select is((select count(*) from public.task_dependencies where id = :D2), 0::bigint, 'po odrzuceniu cyklu brak wiersza');

reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :E, 'editor'), (:W, :V, 'viewer');

select pg_temp.login(:E);
select is((pg_temp.push(pg_temp.op('tasks', :C, jsonb_build_object('derived_from', jsonb_build_array(:A)), pg_temp.h(3000, 'ed'))) ->> 'applied')::int, 1, 'edytor dodaje „wynika z” na liście z edycją dla gości');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :TV, jsonb_build_object('derived_from', jsonb_build_array(:A)), pg_temp.h(3100, 'ed')))), 'TP003', 'edytor nie dodaje „wynika z” na liście „tylko podgląd”');

select pg_temp.login(:V);
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :C, '{"derived_from": null}', pg_temp.h(3200, 'pg')))), 'TP003', 'osoba z podglądem nie zmienia powiązań');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_dependencies', :D1, jsonb_build_object('deleted_at', now()), pg_temp.h(3300, 'pg')))), 'TP003', 'osoba z podglądem nie usuwa strzałki „blokuje”');

select * from finish();
rollback;
