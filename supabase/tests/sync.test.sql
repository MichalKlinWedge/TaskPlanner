-- PoC-1: zakresy, RLS, push_changes (LWW per pole, reguły drzewa) i pull_changes.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'wlasciciel@test.local'),
  ('00000000-0000-4000-8000-0000000000a2', 'obcy@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- HLC o podanym „czasie” (milisekundy) z urządzenia `dev`.
create function pg_temp.h(p_wall bigint, p_node text default 'dev') returns text language sql as $$
  select lpad(p_wall::text, 15, '0') || ':00000:' || p_node
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;

-- Identyfikatory: W/W2 przestrzenie, L/L2 listy, T* zadania.
\set W  '''b1000000-0000-4000-8000-000000000001'''
\set W2 '''b1000000-0000-4000-8000-000000000002'''
\set L  '''c1000000-0000-4000-8000-000000000001'''
\set L2 '''c1000000-0000-4000-8000-000000000002'''
\set T1 '''d1000000-0000-4000-8000-000000000001'''
\set T2 '''d1000000-0000-4000-8000-000000000002'''
\set T3 '''d1000000-0000-4000-8000-000000000003'''
\set T4 '''d1000000-0000-4000-8000-000000000004'''
\set T5 '''d1000000-0000-4000-8000-000000000005'''

select ok(exists (select 1 from public.sync_scopes where id = '00000000-0000-4000-8000-0000000000a1' and kind = 'personal'),
  'konto dostaje zakres osobisty');

select pg_temp.login('00000000-0000-4000-8000-0000000000a1');

select is((pg_temp.push(
    pg_temp.op('workspaces', :W, '{"name": "Dom"}', pg_temp.h(1000)),
    pg_temp.op('workspaces', :W2, '{"name": "Praca"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
    pg_temp.op('lists', :L2, jsonb_build_object('scope_id', :W, 'name', 'Zakupy'), pg_temp.h(1001)),
    pg_temp.op('tasks', :T1, jsonb_build_object('list_id', :L, 'title', 'Pierwsze'), pg_temp.h(1002))
  ) ->> 'applied')::int, 5, 'właściciel tworzy przestrzenie, listy i zadanie jedną paczką');

select ok(exists (select 1 from public.scope_members where scope_id = :W and role = 'owner'),
  'nowa przestrzeń ma zakres i właściciela');
select is((select scope_id from public.tasks where id = :T1), :W::uuid, 'zakres zadania wyliczony z listy');
select ok((public.pull_changes() -> 'scopes') ? :W, 'pull_changes zwraca zakres przestrzeni');
select is(jsonb_array_length(public.pull_changes() -> 'tables' -> 'tasks'), 1, 'pull_changes zwraca zadanie');

-- ── LWW per pole ─────────────────────────────────────────────────────────────────────────────
select pg_temp.push(pg_temp.op('tasks', :T1, '{"title": "Nowszy"}', pg_temp.h(3000)));
select pg_temp.push(pg_temp.op('tasks', :T1, '{"title": "Starszy"}', pg_temp.h(2000)));
select is((select title from public.tasks where id = :T1), 'Nowszy', 'starsza zmiana tego samego pola przegrywa niezależnie od kolejności');
select pg_temp.push(pg_temp.op('tasks', :T1, '{"status": "in_progress"}', pg_temp.h(2500)));
select is((select status from public.tasks where id = :T1), 'in_progress', 'zmiana innego pola ze starszym HLC wchodzi');
select is((select title from public.tasks where id = :T1), 'Nowszy', '… i nie rusza tytułu');
select ok(pg_temp.h(1000, 'b') > pg_temp.h(1000, 'a'), 'remis czasu rozstrzyga węzeł (porównanie tekstu)');

create temp table v as select row_version from public.tasks where id = :T1;
select pg_temp.push(pg_temp.op('tasks', :T1, '{"title": "Nowszy"}', pg_temp.h(3000)));
select is((select row_version from public.tasks where id = :T1), (select row_version from v), 'powtórzona operacja nic nie zmienia (idempotencja)');

-- ── Drzewo zadań ─────────────────────────────────────────────────────────────────────────────
select is((pg_temp.push(
    pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L2, 'parent_id', :T1, 'title', 'Dziecko'), pg_temp.h(4000)),
    pg_temp.op('tasks', :T3, jsonb_build_object('list_id', :L, 'parent_id', :T2, 'title', 'Wnuk'), pg_temp.h(4000)),
    pg_temp.op('tasks', :T4, jsonb_build_object('list_id', :L, 'parent_id', :T3, 'title', 'Prawnuk'), pg_temp.h(4000))
  ) ->> 'applied')::int, 3, 'cztery poziomy zadań są dozwolone');
select is((select list_id from public.tasks where id = :T2), :L::uuid, 'podzadanie dostaje listę rodzica');

select is((pg_temp.push(
    pg_temp.op('tasks', :T5, jsonb_build_object('list_id', :L, 'parent_id', :T4, 'title', 'Za głęboko'), pg_temp.h(4100))
  ) -> 'rejected' -> 0 ->> 'code'), 'TP001', 'piąty poziom odrzucony');
select ok(not exists (select 1 from public.tasks where id = :T5), '… i nie zapisany');

select is((pg_temp.push(pg_temp.op('tasks', :T1, jsonb_build_object('parent_id', :T3), pg_temp.h(4200)))
  -> 'rejected' -> 0 ->> 'code'), 'TP002', 'przeniesienie zadania pod własnego potomka odrzucone (cykl)');
select is((pg_temp.push(pg_temp.op('tasks', :T1, jsonb_build_object('parent_id', :T3), pg_temp.h(4200)))
  -> 'rows' -> 0 -> 'row' ->> 'parent_id'), null, 'odrzucenie zwraca bieżący wiersz serwera');

select is((pg_temp.push(pg_temp.op('tasks', :T5, jsonb_build_object('list_id', :L, 'title', 'Ok', 'scope_id', :W2), pg_temp.h(4300)))
  -> 'rejected' -> 0 ->> 'code'), 'TP005', 'zakresu zadania nie ustawia klient');

-- ── Miękkie usunięcie i przywrócenie ─────────────────────────────────────────────────────────
select pg_temp.push(pg_temp.op('tasks', :T2, '{"deleted_at": "2026-11-18T12:00:00Z"}', pg_temp.h(5000)));
select is((select count(*) from public.tasks where id in (:T3, :T4) and deleted_at is not null), 2::bigint,
  'usunięcie zadania usuwa jego poddrzewo');
select pg_temp.push(pg_temp.op('tasks', :T2, '{"deleted_at": null}', pg_temp.h(5100)));
select is((select count(*) from public.tasks where id in (:T3, :T4) and deleted_at is null), 2::bigint,
  'przywrócenie przywraca poddrzewo usunięte razem z nim');

-- ── Przeniesienie listy do innej przestrzeni ─────────────────────────────────────────────────
select pg_temp.push(pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W2), pg_temp.h(6000)));
select is((select count(*) from public.tasks where list_id = :L and scope_id = :W2), 4::bigint,
  'zadania i podzadania idą za listą do nowej przestrzeni');

-- ── Zegar z przyszłości ──────────────────────────────────────────────────────────────────────
select is(jsonb_array_length(pg_temp.push(pg_temp.op('tasks', :T1, '{"title": "Z przyszłości"}', pg_temp.h(4102444800000))) -> 'clamped'), 1,
  'HLC z przyszłości jest obcinany do czasu serwera');
select ok(left((select field_clock ->> 'title' from public.tasks where id = :T1), 15)::bigint < 4102444800000,
  '… i nie trafia do field_clock');

-- ── Ukończenia i tagi ────────────────────────────────────────────────────────────────────────
select pg_temp.push(
  pg_temp.op('task_completions', 'e1000000-0000-4000-8000-000000000001', jsonb_build_object('task_id', :T1, 'occurrence_date', '2026-11-18'), pg_temp.h(7000, 'phone')),
  pg_temp.op('task_completions', 'e1000000-0000-4000-8000-000000000001', jsonb_build_object('task_id', :T1, 'occurrence_date', '2026-11-18'), pg_temp.h(7001, 'web')));
select is((select count(*) from public.task_completions where task_id = :T1), 1::bigint, 'podwójne ukończenie wystąpienia = jeden wiersz');

select is((pg_temp.push(pg_temp.op('tags', 'f1000000-0000-4000-8000-000000000001', jsonb_build_object('name', 'telefon', 'scope_id', :W), pg_temp.h(7100)))
  -> 'rejected' -> 0 ->> 'code'), 'TP004', 'tag w przestrzeni zamiast w zakresie osobistym odrzucony');
select is((pg_temp.push(pg_temp.op('tags', 'f1000000-0000-4000-8000-000000000001', '{"name": "telefon"}', pg_temp.h(7100))) ->> 'applied')::int, 1,
  'tag bez zakresu trafia do zakresu osobistego');

-- ── Przyrosty ────────────────────────────────────────────────────────────────────────────────
select is(jsonb_array_length(public.pull_changes(
    (select jsonb_object_agg(id, sync_version) from public.sync_scopes)) -> 'tables' -> 'tasks'), 0,
  'pull_changes od bieżących wersji nie zwraca nic');

-- ── Obcy użytkownik ──────────────────────────────────────────────────────────────────────────
select pg_temp.login('00000000-0000-4000-8000-0000000000a2');
select is((select count(*) from public.tasks), 0::bigint, 'obcy nie widzi zadań (RLS)');
select ok(not ((public.pull_changes() -> 'scopes') ? :W), 'obcy nie dostaje cudzej przestrzeni w pull_changes');
select is((pg_temp.push(pg_temp.op('tasks', :T1, '{"title": "Włamanie"}', pg_temp.h(9000))) -> 'rejected' -> 0 ->> 'code'), 'TP003',
  'obcy nie zmieni cudzego zadania przez push_changes');
select throws_ok($$ insert into public.tasks (id, list_id, title) values (gen_random_uuid(), 'c1000000-0000-4000-8000-000000000001', 'x') $$,
  '42501', null, 'bezpośredni zapis do tabeli jest zablokowany');

select * from finish();
rollback;
