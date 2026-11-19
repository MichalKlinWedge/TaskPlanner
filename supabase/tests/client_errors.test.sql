-- Etap 13: dziennik błędów aplikacji (`client_errors`, `report_client_errors`).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000e1', 'bledy-a@test.local'),
  ('00000000-0000-4000-8000-0000000000e2', 'bledy-b@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.item(p_fingerprint text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('fingerprint', p_fingerprint, 'kind', 'error', 'platform', 'web', 'message', 'Błąd ' || p_fingerprint,
    'stack', 'at f (app.js:1:2)', 'url', '/#/today', 'count', 1, 'firstAt', now() - interval '1 minute', 'lastAt', now()) || p_extra
$$;

\set A '''00000000-0000-4000-8000-0000000000e1'''
\set B '''00000000-0000-4000-8000-0000000000e2'''

select pg_temp.login(:A);
select is(public.report_client_errors(jsonb_build_array(pg_temp.item('f1'), pg_temp.item('f2', '{"count": 3}'))), 2, 'paczka dwóch błędów przyjęta');
select is(public.report_client_errors(jsonb_build_array(pg_temp.item('f1', '{"count": 4, "message": "Nowa treść"}'))), 1, 'ten sam błąd jeszcze raz');
select results_eq($$ select fingerprint, count, message from public.client_errors order by fingerprint $$,
  $$ values ('f1', 5, 'Nowa treść'), ('f2', 3, 'Błąd f2') $$, 'jeden wiersz na odcisk i dzień, licznik się sumuje');
select is(public.report_client_errors(jsonb_build_array(
    pg_temp.item('zły-rodzaj', '{"kind": "inny"}'), pg_temp.item('', '{}'), pg_temp.item('zła-data', '{"lastAt": "wczoraj"}'), pg_temp.item('f3'))),
  1, 'błędne pozycje pominięte, poprawna przyjęta');
select is(public.report_client_errors(jsonb_build_array(pg_temp.item('przyszłość', '{"firstAt": "2999-01-01T00:00:00Z", "lastAt": "2999-01-01T00:00:00Z"}'))), 1, 'chwila z przyszłości');
select ok((select last_at <= now() and first_at <= last_at from public.client_errors where fingerprint = 'przyszłość'), 'chwila z przyszłości przycięta do teraz');
select is(public.report_client_errors(jsonb_build_array(pg_temp.item('duże', jsonb_build_object('message', repeat('x', 5000), 'context', jsonb_build_object('blob', repeat('y', 5000)))))), 1, 'długie pola');
select ok((select length(message) = 1000 and context = '{}'::jsonb from public.client_errors where fingerprint = 'duże'), 'treść obcięta, za duży kontekst odrzucony');

select throws_ok($$ insert into public.client_errors (user_id, fingerprint, day, kind, platform, message, first_at, last_at)
  values (auth.uid(), 'x', current_date, 'error', 'web', 'x', now(), now()) $$, '42501', null, 'klient nie pisze tabeli bezpośrednio');

select pg_temp.login(:B);
select is((select count(*)::int from public.client_errors), 0, 'cudze błędy niewidoczne');
-- Limit 200 nowych odcisków dziennie (wywołanie po 20).
select is((select sum(public.report_client_errors((select jsonb_agg(pg_temp.item('b' || (n * 20 + k)::text)) from generate_series(1, 20) k)))::int
             from generate_series(0, 10) n), 200, 'najwyżej 200 nowych odcisków dziennie');

reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.report_client_errors('[]') $$, '42501', null, 'bez zalogowania — odmowa');

select * from finish();
rollback;
