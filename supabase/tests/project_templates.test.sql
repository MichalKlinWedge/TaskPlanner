-- v1.x: szablony projektów (migracja *_v1x_project_templates.sql) — tabela synchronizowana w zakresie
-- osobistym: zapis przez push_changes, LWW całej treści, tylko własne szablony, zły zakres odrzucony,
-- wiersz w pull_changes.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000002a1', 'szablony-a@test.local'),
  ('00000000-0000-4000-8000-0000000002a2', 'szablony-b@test.local');

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
create function pg_temp.content(p_title text) returns jsonb language sql as $$
  select jsonb_build_object('version', 1,
    'project', jsonb_build_object('color', null, 'icon', null, 'descriptionMd', null, 'endDay', 9, 'viewPrefs', null, 'boardColumns', '[]'::jsonb),
    'tasks', jsonb_build_array(jsonb_build_object('key', 't1', 'parent', null, 'title', p_title, 'descriptionMd', null, 'priority', 4,
      'startDay', null, 'dueDay', 9, 'dueTime', null, 'durationMin', null, 'timeZone', null, 'recurrence', null, 'tags', '[]'::jsonb,
      'reminders', '[]'::jsonb, 'boardColumn', null)),
    'dependencies', '[]'::jsonb)
$$;

\set A '''00000000-0000-4000-8000-0000000002a1'''
\set B '''00000000-0000-4000-8000-0000000002a2'''
\set W '''b8000000-0000-4000-8000-000000000001'''
\set P '''e8000000-0000-4000-8000-000000000001'''
\set PB '''e8000000-0000-4000-8000-000000000002'''

select pg_temp.login(:A);
select is((pg_temp.push(pg_temp.op('project_templates', :P, jsonb_build_object('name', 'Wdrożenie', 'content', pg_temp.content('Analiza'), 'sort_key', 'a'), pg_temp.h(1000))) ->> 'applied')::int, 1,
  'szablon zapisany przez push_changes');
select is((select scope_id from public.project_templates where id = :P), :A::uuid, 'szablon w zakresie osobistym');
select is((select created_by from public.project_templates where id = :P), :A::uuid, 'autor z JWT');

-- Treść to jedno pole: nowszy zapis zastępuje ją w całości, starszy (inne urządzenie offline) przegrywa.
select pg_temp.push(pg_temp.op('project_templates', :P, jsonb_build_object('content', pg_temp.content('Nowa analiza')), pg_temp.h(3000)));
select pg_temp.push(pg_temp.op('project_templates', :P, jsonb_build_object('content', pg_temp.content('Stara analiza')), pg_temp.h(2000)));
select is((select content -> 'tasks' -> 0 ->> 'title' from public.project_templates where id = :P), 'Nowa analiza', 'LWW całej treści — wygrywa nowszy zapis');

select is((select jsonb_array_length(public.pull_changes('{}'::jsonb) -> 'tables' -> 'project_templates')), 1, 'szablon przychodzi w pull_changes');

-- Przestrzeń nie jest zakresem osobistym — szablon nie może do niej należeć.
select pg_temp.push(pg_temp.op('workspaces', :W, '{"name": "Praca"}', pg_temp.h(4000)));
select is(pg_temp.code(pg_temp.push(pg_temp.op('project_templates', :PB, jsonb_build_object('scope_id', :W, 'name', 'X', 'content', pg_temp.content('X'), 'sort_key', 'b'), pg_temp.h(4001)))),
  'TP004', 'szablon w przestrzeni odrzucony');
select is(pg_temp.code(pg_temp.push(pg_temp.op('project_templates', :PB, jsonb_build_object('name', 'X', 'content', '[]'::jsonb, 'sort_key', 'b'), pg_temp.h(4002)))) is not null,
  true, 'treść bez wersji formatu odrzucona');

select pg_temp.login(:B);
select is((select count(*)::int from public.project_templates), 0, 'cudze szablony niewidoczne (RLS)');
select is((select jsonb_array_length(public.pull_changes('{}'::jsonb) -> 'tables' -> 'project_templates')), 0, 'cudze szablony nie przychodzą w pull_changes');
select is(pg_temp.code(pg_temp.push(pg_temp.op('project_templates', :P, '{"name": "Przejęty"}', pg_temp.h(5000)))) is not null, true, 'cudzego szablonu nie można zmienić');

select * from finish();
rollback;
