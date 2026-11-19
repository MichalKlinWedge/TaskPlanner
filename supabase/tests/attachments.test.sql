-- Etap 10: bucket `attachments` i reguły dostępu do plików załączników.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000c1', 'autor-zal@test.local'),
  ('00000000-0000-4000-8000-0000000000c2', 'czlonek-zal@test.local'),
  ('00000000-0000-4000-8000-0000000000c3', 'obcy-zal@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_wall bigint) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', lpad(p_wall::text, 15, '0') || ':00000:dev')
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;
create function pg_temp.upload(p_name text, p_owner uuid) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner_id) values ('attachments', p_name, p_owner::text)
$$;
create function pg_temp.visible(p_name text) returns boolean language sql as $$
  select exists (select 1 from storage.objects where bucket_id = 'attachments' and name = p_name)
$$;

\set A  '''00000000-0000-4000-8000-0000000000c1'''
\set B  '''00000000-0000-4000-8000-0000000000c2'''
\set C  '''00000000-0000-4000-8000-0000000000c3'''
\set W  '''b3000000-0000-4000-8000-000000000001'''
\set L  '''c3000000-0000-4000-8000-000000000001'''
\set T  '''d3000000-0000-4000-8000-000000000001'''
\set TC '''d3000000-0000-4000-8000-000000000002'''
\set LC '''c3000000-0000-4000-8000-000000000002'''
\set WC '''b3000000-0000-4000-8000-000000000002'''
\set AT '''e3000000-0000-4000-8000-000000000001'''
\set P  '''00000000-0000-4000-8000-0000000000c1/d3000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000001-skan.pdf'''

select ok(exists (select 1 from storage.buckets where id = 'attachments' and not public and file_size_limit = 26214400), 'prywatny bucket `attachments` z limitem 25 MB');

-- Przestrzeń autora A z członkiem B (edytor); osobna przestrzeń C.
select pg_temp.login(:A);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', 1000),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), 1001),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Ze skanem'), 1002));
reset role;
insert into public.scope_members (scope_id, user_id, role) values (:W, :B, 'editor');
select pg_temp.login(:C);
select pg_temp.push(
  pg_temp.op('workspaces', :WC, '{"name": "Cudza"}', 1000),
  pg_temp.op('lists', :LC, jsonb_build_object('scope_id', :WC, 'kind', 'inbox', 'name', 'Inbox'), 1001),
  pg_temp.op('tasks', :TC, jsonb_build_object('list_id', :LC, 'title', 'Cudze'), 1002));

-- ── Wysyłka ──────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:A);
select lives_ok(format($$ select pg_temp.upload(%L, %L) $$, :P, :A), 'autor wysyła plik do własnego folderu i swojego zadania');
select throws_ok(format($$ select pg_temp.upload(%L, %L) $$, :B || '/' || :T || '/x.pdf', :A), '42501', null, 'cudzy folder odrzucony');
select throws_ok(format($$ select pg_temp.upload(%L, %L) $$, :A || '/' || :TC || '/x.pdf', :A), '42501', null, 'zadanie bez dostępu odrzucone');
select throws_ok(format($$ select pg_temp.upload(%L, %L) $$, :A || '/nie-uuid/x.pdf', :A), '42501', null, 'zła ścieżka odrzucona');
select throws_ok(format($$ select pg_temp.upload(%L, %L) $$, :A || '/' || :T || '/a/b.pdf', :A), '42501', null, 'zagnieżdżony folder odrzucony');

-- ── Odczyt ───────────────────────────────────────────────────────────────────────────────────
select ok(pg_temp.visible(:P), 'autor widzi swój plik od razu (przed wierszem `attachments`)');
select pg_temp.login(:B);
select ok(not pg_temp.visible(:P), 'członek nie widzi pliku bez wiersza `attachments`');
select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('attachments', :AT,
  jsonb_build_object('task_id', :T, 'kind', 'file', 'name', 'skan.pdf', 'storage_path', :P, 'mime', 'application/pdf', 'size_bytes', 1000), 2000));
select pg_temp.login(:B);
select ok(pg_temp.visible(:P), 'członek przestrzeni widzi plik po zsynchronizowaniu wiersza');
select pg_temp.login(:C);
select ok(not pg_temp.visible(:P), 'obcy nie widzi pliku');

select * from finish();
rollback;
