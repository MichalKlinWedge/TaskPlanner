-- v1.x: centrum powiadomień, etap N2 — „przeczytane” z powiadomienia systemowego (migracja *_v1x_notification_push.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000c1', 'push-pow@test.local');
\set U '''00000000-0000-4000-8000-0000000000c1'''
\set N '''f8000000-0000-4000-8000-000000000001'''

insert into public.notifications (id, scope_id, user_id, kind, data) values (:N, :U, :U, 'invite', '{"workspace": "Dom"}');
create temp table before as select row_version from public.notifications where id = :N;

select is(public.mark_notification_read(:N), true, 'nieprzeczytane → przeczytane');
select ok((select read_at is not null and field_clock ->> 'read_at' like '%:server' from public.notifications where id = :N), 'z serwerowym HLC (urządzenia przyjmą przy synchronizacji)');
select ok((select n.row_version > b.row_version from public.notifications n, before b where n.id = :N), 'nowa wersja wiersza — pobiorą ją urządzenia');
select is(public.mark_notification_read(:N), false, 'drugi raz — bez zmiany');

select set_config('role', 'authenticated', true),
       set_config('request.jwt.claims', json_build_object('sub', :U, 'role', 'authenticated')::text, true);
select throws_ok($$select public.mark_notification_read('f8000000-0000-4000-8000-000000000001')$$, '42501', null, 'tylko serwer (funkcja z podpisem)');

select * from finish();
rollback;
