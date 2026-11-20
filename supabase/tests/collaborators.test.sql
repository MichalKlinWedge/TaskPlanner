-- v1.x: współpracownicy, uczestnicy zadań, odpowiedzialny i komentarze (migracja *_v1x_collaborators_comments.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000c1', 'wlasciciel-wsp@test.local'),
  ('00000000-0000-4000-8000-0000000000c2', 'obcy-wsp@test.local');

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

\set U  '''00000000-0000-4000-8000-0000000000c1'''
\set U2 '''00000000-0000-4000-8000-0000000000c2'''
\set W  '''b3000000-0000-4000-8000-000000000001'''
\set W2 '''b3000000-0000-4000-8000-000000000002'''
\set L  '''c3000000-0000-4000-8000-000000000001'''
\set L2 '''c3000000-0000-4000-8000-000000000002'''
\set T  '''d3000000-0000-4000-8000-000000000001'''
\set C  '''e3000000-0000-4000-8000-000000000001'''
\set P  '''e3000000-0000-4000-8000-000000000002'''
\set K  '''e3000000-0000-4000-8000-000000000003'''
\set W9 '''b3000000-0000-4000-8000-000000000009'''
\set L9 '''c3000000-0000-4000-8000-000000000009'''
\set T9 '''d3000000-0000-4000-8000-000000000009'''

select pg_temp.login(:U);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Dom"}', pg_temp.h(1000)),
  pg_temp.op('workspaces', :W2, '{"name": "Praca"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('lists', :L2, jsonb_build_object('scope_id', :W2, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Raport'), pg_temp.h(1002)));

-- ── Zapis ────────────────────────────────────────────────────────────────────────────────────
select is((pg_temp.push(
    pg_temp.op('collaborators', :C, '{"name": "Anna", "email": "anna@example.com"}', pg_temp.h(2000)),
    pg_temp.op('task_participants', :P, jsonb_build_object('task_id', :T, 'collaborator_id', :C), pg_temp.h(2000)),
    pg_temp.op('task_comments', :K, jsonb_build_object('task_id', :T, 'body', 'Liczby w piątek', 'posted_at', '2026-11-20T09:00:00Z'), pg_temp.h(2000)),
    pg_temp.op('tasks', :T, jsonb_build_object('assignee_id', :C), pg_temp.h(2000))
  ) ->> 'applied')::int, 4, 'właściciel zapisuje współpracownika, uczestnika, komentarz i odpowiedzialnego');
select is((select scope_id from public.collaborators where id = :C), :U::uuid, 'współpracownik trafia do zakresu osobistego');
select is((select scope_id from public.task_participants where id = :P), :W::uuid, 'uczestnik dostaje zakres zadania');
select is((select scope_id from public.task_comments where id = :K), :W::uuid, 'komentarz dostaje zakres zadania');
select is((select created_by from public.task_comments where id = :K), :U::uuid, 'autor komentarza = zalogowany (created_by)');
select ok(exists (select 1 from public.activity_log where row_id = :T and changes ->> 'assignee_id' = :C),
  'zmiana odpowiedzialnego w historii zmian');

-- ── Reguły ───────────────────────────────────────────────────────────────────────────────────
select is(pg_temp.code(pg_temp.push(pg_temp.op('collaborators', gen_random_uuid(), '{"name": "Ola", "email": "ola@"}', pg_temp.h(2100)))), '23514',
  'zły e-mail odrzucony');
select is(pg_temp.code(pg_temp.push(pg_temp.op('collaborators', gen_random_uuid(), '{"name": "Ola", "acronym": "ABCDEF"}', pg_temp.h(2100)))), '23514',
  'akronim dłuższy niż 5 znaków odrzucony');
select is((pg_temp.push(pg_temp.op('collaborators', :C, '{"acronym": "AN", "archived_at": "2026-11-20T10:00:00Z"}', pg_temp.h(2150))) ->> 'applied')::int, 1,
  'akronim i status (archived_at) zapisywalne przez push_changes');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_comments', gen_random_uuid(),
    jsonb_build_object('task_id', :T, 'body', '   ', 'posted_at', '2026-11-20T09:00:00Z'), pg_temp.h(2100)))), '23514', 'pusty komentarz odrzucony');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_participants', gen_random_uuid(),
    jsonb_build_object('task_id', :T, 'collaborator_id', :C), pg_temp.h(2100)))), '23505', 'ta sama osoba drugi raz w uczestnikach (inny id) odrzucona');

-- ── Przeniesienie zadania do innej przestrzeni ──────────────────────────────────────────────
select pg_temp.push(pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L2), pg_temp.h(3000)));
select is((select array[(select scope_id from public.task_participants where id = :P), (select scope_id from public.task_comments where id = :K)]),
  array[:W2::uuid, :W2::uuid], 'uczestnicy i komentarze przechodzą z zadaniem do nowej przestrzeni');

-- ── Usunięty współpracownik ──────────────────────────────────────────────────────────────────
select is((pg_temp.push(
    pg_temp.op('tasks', :T, '{"assignee_id": null}', pg_temp.h(4000)),
    pg_temp.op('task_participants', :P, '{"deleted_at": "2026-11-20T10:00:00Z"}', pg_temp.h(4000)),
    pg_temp.op('collaborators', :C, '{"deleted_at": "2026-11-20T10:00:00Z"}', pg_temp.h(4000))
  ) ->> 'applied')::int, 3, 'usunięcie współpracownika z zadaniem wracającym do twórcy');

-- ── Obcy użytkownik ──────────────────────────────────────────────────────────────────────────
select pg_temp.login(:U2);
select pg_temp.push(
  pg_temp.op('workspaces', :W9, '{"name": "Obca"}', pg_temp.h(5000)),
  pg_temp.op('lists', :L9, jsonb_build_object('scope_id', :W9, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(5001)),
  pg_temp.op('tasks', :T9, jsonb_build_object('list_id', :L9, 'title', 'Obce'), pg_temp.h(5002)));
select is((select count(*) from public.collaborators) + (select count(*) from public.task_participants) + (select count(*) from public.task_comments),
  0::bigint, 'obcy nie widzi cudzych współpracowników, uczestników ani komentarzy (RLS)');
select is(pg_temp.code(pg_temp.push(pg_temp.op('tasks', :T9, jsonb_build_object('assignee_id', :C), pg_temp.h(5100)))), 'TP003',
  'obcy nie przypisze swojego zadania cudzemu współpracownikowi');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_participants', gen_random_uuid(),
    jsonb_build_object('task_id', :T9, 'collaborator_id', :C), pg_temp.h(5100)))), 'TP003', 'obcy nie doda cudzego współpracownika do uczestników');
select is(pg_temp.code(pg_temp.push(pg_temp.op('task_comments', gen_random_uuid(),
    jsonb_build_object('task_id', :T, 'body', 'Wtrącam się', 'posted_at', '2026-11-20T09:00:00Z'), pg_temp.h(5100)))), 'TP003', 'obcy nie skomentuje cudzego zadania');
select is(pg_temp.code(pg_temp.push(pg_temp.op('collaborators', gen_random_uuid(),
    jsonb_build_object('scope_id', :U, 'name', 'Podrzutek'), pg_temp.h(5100)))), 'TP003', 'obcy nie dopisze współpracownika do cudzego zakresu osobistego');

-- ── Anonim ───────────────────────────────────────────────────────────────────────────────────
select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role": "anon"}', true);
select throws_ok($$ select * from public.task_comments $$, '42501', null, 'anonim nie czyta komentarzy');

select * from finish();
rollback;
