-- MVP-1: tabele §5 spoza PoC-1, macierz uprawnień, zależności, dziennik zmian, stronicowane pull_changes.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000b1', 'wlasciciel-mvp1@test.local'),
  ('00000000-0000-4000-8000-0000000000b2', 'obcy-mvp1@test.local');

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
-- Pobranie stronami aż do końca: liczba nieusuniętych wierszy, liczba stron i końcowe wersje.
create function pg_temp.pull_all(p_limit int) returns jsonb language plpgsql as $$
declare
  since jsonb := '{}';
  res jsonb;
  n int := 0;
  pages int := 0;
begin
  loop
    res := public.pull_changes(since, p_limit);
    pages := pages + 1;
    n := n + (select count(*) from jsonb_each(res -> 'tables') t, jsonb_array_elements(t.value) e where e ->> 'deleted_at' is null);
    since := (select jsonb_object_agg(key, value -> 'version') from jsonb_each(res -> 'scopes'));
    exit when not (res ->> 'more')::boolean or pages > 1000;
  end loop;
  return jsonb_build_object('rows', n, 'pages', pages, 'since', since);
end $$;

\set U  '''00000000-0000-4000-8000-0000000000b1'''
\set U2 '''00000000-0000-4000-8000-0000000000b2'''
\set W  '''b2000000-0000-4000-8000-000000000001'''
\set W2 '''b2000000-0000-4000-8000-000000000002'''
\set L  '''c2000000-0000-4000-8000-000000000001'''
\set L2 '''c2000000-0000-4000-8000-000000000002'''
\set T1 '''d2000000-0000-4000-8000-000000000001'''
\set T2 '''d2000000-0000-4000-8000-000000000002'''
\set T3 '''d2000000-0000-4000-8000-000000000003'''
\set T9 '''d2000000-0000-4000-8000-000000000009'''
\set R  '''e2000000-0000-4000-8000-000000000001'''
\set D  '''e2000000-0000-4000-8000-000000000002'''
\set E1 '''e2000000-0000-4000-8000-000000000003'''
\set E2 '''e2000000-0000-4000-8000-000000000004'''
\set DP1 '''e2000000-0000-4000-8000-000000000011'''
\set DP2 '''e2000000-0000-4000-8000-000000000012'''

select ok(exists (select 1 from public.profiles where id = :U and scope_id = :U), 'konto dostaje profil w zakresie osobistym');

select pg_temp.login(:U);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Dom"}', pg_temp.h(1000)),
  pg_temp.op('workspaces', :W2, '{"name": "Praca"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('lists', :L2, jsonb_build_object('scope_id', :W2, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('tasks', :T1, jsonb_build_object('list_id', :L, 'title', 'Pierwsze'), pg_temp.h(1002)),
  pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Drugie'), pg_temp.h(1002)),
  pg_temp.op('tasks', :T3, jsonb_build_object('list_id', :L, 'title', 'Trzecie'), pg_temp.h(1002)),
  pg_temp.op('tasks', :T9, jsonb_build_object('list_id', :L2, 'title', 'W pracy'), pg_temp.h(1002)));

-- ── Nowe tabele ──────────────────────────────────────────────────────────────────────────────
select is((pg_temp.push(
    pg_temp.op('profiles', :U, '{"display_name": "Ja", "settings": {"firstDayOfWeek": 1}}', pg_temp.h(2000)),
    pg_temp.op('devices', :D, '{"name": "Laptop", "platform": "web"}', pg_temp.h(2000)),
    pg_temp.op('reminders', :R, jsonb_build_object('task_id', :T1, 'kind', 'relative', 'offset_min', 15), pg_temp.h(2000)),
    pg_temp.op('task_dependencies', :DP1, jsonb_build_object('predecessor_id', :T1, 'successor_id', :T2), pg_temp.h(2000)),
    pg_temp.op('time_entries', :E1, jsonb_build_object('task_id', :T1, 'kind', 'focus', 'started_at', '2026-11-19T08:00:00Z'), pg_temp.h(2000)),
    pg_temp.op('time_entries', :E2, '{"kind": "manual", "started_at": "2026-11-19T09:00:00Z"}', pg_temp.h(2000)),
    pg_temp.op('attachments', gen_random_uuid(), jsonb_build_object('task_id', :T1, 'kind', 'link', 'name', 'Strona', 'url', 'https://example.com'), pg_temp.h(2000)),
    pg_temp.op('saved_filters', gen_random_uuid(), '{"name": "Pilne", "query": {"priority": [1]}}', pg_temp.h(2000)),
    pg_temp.op('review_sessions', gen_random_uuid(), '{"kind": "daily", "started_at": "2026-11-19T20:00:00Z"}', pg_temp.h(2000))
  ) ->> 'applied')::int, 9, 'właściciel zapisuje wszystkie nowe tabele przez push_changes');
select is((select scope_id from public.reminders where id = :R), :W::uuid, 'przypomnienie dostaje zakres zadania');
select is((select scope_id from public.time_entries where id = :E2), :U::uuid, 'wpis czasu bez zadania trafia do zakresu osobistego');
select is((select scope_id from public.devices where id = :D), :U::uuid, 'urządzenie trafia do zakresu osobistego');
select is((select scope_id from public.task_dependencies where id = :DP1), :W::uuid, 'zależność dostaje zakres poprzednika');

-- ── Zależności ───────────────────────────────────────────────────────────────────────────────
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_dependencies', gen_random_uuid(),
    jsonb_build_object('predecessor_id', :T2, 'successor_id', :T1), pg_temp.h(2100)))), 'TP002', 'zależność odwrotna (cykl A→B→A) odrzucona');
select is((pg_temp.push(pg_temp.op('task_dependencies', :DP2,
    jsonb_build_object('predecessor_id', :T2, 'successor_id', :T3), pg_temp.h(2100))) ->> 'applied')::int, 1, 'łańcuch A→B→C przyjęty');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_dependencies', gen_random_uuid(),
    jsonb_build_object('predecessor_id', :T3, 'successor_id', :T1), pg_temp.h(2100)))), 'TP002', 'zamknięcie łańcucha C→A odrzucone');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_dependencies', gen_random_uuid(),
    jsonb_build_object('predecessor_id', :T1, 'successor_id', :T9), pg_temp.h(2100)))), 'TP004', 'zależność między przestrzeniami odrzucona');
select is(pg_temp.code(pg_temp.push(pg_temp.op('reminders', gen_random_uuid(),
    jsonb_build_object('task_id', :T1, 'kind', 'relative'), pg_temp.h(2100)))), '23514', 'przypomnienie względne bez wyprzedzenia odrzucone');

-- ── board_sort_key i dziennik zmian ─────────────────────────────────────────────────────────
select pg_temp.push(pg_temp.op('tasks', :T1, '{"board_sort_key": "m"}', pg_temp.h(3000, 'laptop')));
select is((select board_sort_key from public.tasks where id = :T1), 'm', 'board_sort_key zapisywany przez push_changes (D15)');
select ok(exists (select 1 from public.activity_log
                   where row_id = :T1 and changes ? 'board_sort_key' and device_id = 'laptop' and actor_id = :U),
  'dziennik zmian zapisuje zmienione pole, urządzenie i autora');

-- ── Przeniesienie zadania do innej przestrzeni ──────────────────────────────────────────────
select pg_temp.push(pg_temp.op('tasks', :T1, jsonb_build_object('list_id', :L2), pg_temp.h(3100)));
select ok((select deleted_at is not null from public.task_dependencies where id = :DP1),
  'zależność z zadaniem z innej przestrzeni usunięta po przeniesieniu');
select is((select scope_id from public.reminders where id = :R), :W2::uuid, 'przypomnienie przechodzi z zadaniem do nowej przestrzeni');

-- ── Stronicowane pull_changes ────────────────────────────────────────────────────────────────
select ok((public.pull_changes('{}', 3) ->> 'more')::boolean
          and (select sum(jsonb_array_length(value)) from jsonb_each(public.pull_changes('{}', 3) -> 'tables')) = 3,
  'strona ma najwyżej p_limit wierszy i znacznik more');
select is((pg_temp.pull_all(3) ->> 'rows')::int,
          (select count(*)::int from jsonb_each(public.pull_changes('{}', 5000) -> 'tables') t, jsonb_array_elements(t.value) e),
  'pobranie stronami daje te same wiersze co jedna duża strona');
select is(pg_temp.pull_all(3) -> 'since',
          (select jsonb_object_agg(s.id, s.sync_version) from public.sync_scopes s
             join public.scope_members m on m.scope_id = s.id and m.user_id = :U),
  'po ostatniej stronie wersje zakresów są pełne');

-- ── Obcy użytkownik ──────────────────────────────────────────────────────────────────────────
select pg_temp.login(:U2);
select is((select count(*) from public.reminders) + (select count(*) from public.task_dependencies)
          + (select count(*) from public.time_entries) + (select count(*) from public.attachments)
          + (select count(*) from public.devices) + (select count(*) from public.saved_filters)
          + (select count(*) from public.review_sessions), 0::bigint, 'obcy nie widzi żadnego wiersza nowych tabel (RLS)');
select is((select count(*) from public.profiles where id = :U), 0::bigint, 'obcy nie widzi cudzego profilu');
select is((select count(*) from public.activity_log), 0::bigint, 'obcy nie widzi cudzego dziennika zmian');
select is(pg_temp.code(pg_temp.push(pg_temp.op('reminders', :R, '{"offset_min": 0}', pg_temp.h(9000)))), 'TP003',
  'obcy nie zmieni cudzego przypomnienia');
select is(pg_temp.code(pg_temp.push(pg_temp.op('devices', gen_random_uuid(),
    jsonb_build_object('scope_id', :U, 'name', 'Obcy', 'platform', 'web'), pg_temp.h(9000)))), 'TP003',
  'obcy nie dopisze urządzenia do cudzego zakresu osobistego');
select is(pg_temp.code(pg_temp.push(pg_temp.op('profiles', :U, '{"display_name": "Włamanie"}', pg_temp.h(9000)))), 'TP003',
  'obcy nie zmieni cudzego profilu');

-- ── Anonim ───────────────────────────────────────────────────────────────────────────────────
select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role": "anon"}', true);
select throws_ok($$ select * from public.reminders $$, '42501', null, 'anonim nie czyta tabel');
select throws_ok($$ select public.pull_changes('{}', 10) $$, '42501', null, 'anonim nie wywoła pull_changes');

select * from finish();
rollback;
