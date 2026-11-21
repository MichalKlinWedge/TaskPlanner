-- v1.x: limit miejsca na załączniki na konto (`attachment_quota_bytes`, `attachment_usage`, `can_upload_attachment`).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'limit-a@test.local'),
  ('00000000-0000-4000-8000-0000000000f2', 'limit-b@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', lpad((extract(epoch from now()) * 1000)::bigint::text, 15, '0') || ':00000:dev')
$$;
-- Plik o danym rozmiarze (jak po wysyłce: rozmiar w `metadata`), wstawiony z pominięciem reguł.
create function pg_temp.file(p_name text, p_size bigint) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner_id, metadata) values ('attachments', p_name, split_part(p_name, '/', 1), jsonb_build_object('size', p_size))
$$;

\set A '''00000000-0000-4000-8000-0000000000f1'''
\set B '''00000000-0000-4000-8000-0000000000f2'''
\set W '''b4000000-0000-4000-8000-000000000001'''
\set L '''c4000000-0000-4000-8000-000000000001'''
\set T '''d4000000-0000-4000-8000-000000000001'''

select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name": "Limit"}'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox')),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Z plikami'))));

select is(public.attachment_quota_bytes(), 262144000::bigint, 'limit 250 MB (= core ATTACHMENT_QUOTA_BYTES)');
select ok(public.can_upload_attachment('00000000-0000-4000-8000-0000000000f1/d4000000-0000-4000-8000-000000000001/a.pdf'), 'puste konto — wysyłka dozwolona');

reset role;
select pg_temp.file('00000000-0000-4000-8000-0000000000f1/d4000000-0000-4000-8000-000000000001/duzy.bin', 200000000);
select pg_temp.file('00000000-0000-4000-8000-0000000000f2/d4000000-0000-4000-8000-000000000009/cudzy.bin', 900000000);

select pg_temp.login(:A);
select is(public.attachment_usage(), '{"used": 200000000, "quota": 262144000}'::jsonb, 'zajęte liczy tylko własny folder');
select ok(public.can_upload_attachment('00000000-0000-4000-8000-0000000000f1/d4000000-0000-4000-8000-000000000001/b.pdf'), 'poniżej limitu — dozwolona (ostatni plik może go przekroczyć)');

reset role;
select pg_temp.file('00000000-0000-4000-8000-0000000000f1/d4000000-0000-4000-8000-000000000001/drugi.bin', 70000000);

select pg_temp.login(:A);
select ok(not public.can_upload_attachment('00000000-0000-4000-8000-0000000000f1/d4000000-0000-4000-8000-000000000001/c.pdf'), 'limit wyczerpany — odmowa');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('attachments', '00000000-0000-4000-8000-0000000000f1/d4000000-0000-4000-8000-000000000001/d.pdf', auth.uid()::text) $$,
  '42501', null, 'reguła Storage odrzuca plik ponad limit');

reset role;
set role anon;
select throws_ok($$ select public.attachment_usage() $$, '42501', null, 'anon nie pyta o zajęte miejsce');

select * from finish();
rollback;
