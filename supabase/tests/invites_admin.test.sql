-- v1.x: lista zaproszonych z aplikacji (`app_admins`, `list_invites`, `add_invite`, `remove_invite`).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a7', 'admin-zapr@test.local'),
  ('00000000-0000-4000-8000-0000000000a8', 'zwykly-zapr@test.local'),
  ('00000000-0000-4000-8000-0000000000a9', 'Ktos@Zaproszona-Domena.pl');
insert into public.app_admins (user_id) values ('00000000-0000-4000-8000-0000000000a7');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;

select pg_temp.login('00000000-0000-4000-8000-0000000000a8');
select is(public.is_app_admin(), false, 'zwykłe konto nie jest administratorem');
select throws_ok($$ select * from public.list_invites() $$, '42501', null, 'zwykłe konto nie widzi listy');
select throws_ok($$ select public.add_invite('obcy@example.com') $$, '42501', null, 'zwykłe konto nie dodaje');
select throws_ok($$ select public.remove_invite('obcy@example.com') $$, '42501', null, 'zwykłe konto nie usuwa');
select throws_ok($$ select * from public.app_admins $$, '42501', null, 'tabela administratorów niewidoczna');

select pg_temp.login('00000000-0000-4000-8000-0000000000a7');
select is(public.is_app_admin(), true, 'administrator');
select lives_ok($$ select public.add_invite('  Jan@Example.COM ', ' Jan ') $$, 'dodanie (normalizacja adresu i notatki)');
select lives_ok($$ select public.add_invite('@zaproszona-domena.pl', null) $$, 'dodanie domeny');
select lives_ok($$ select public.add_invite('jan@example.com', 'Jan K.') $$, 'ten sam adres jeszcze raz — zmiana notatki');
select results_eq($$ select pattern, note, accounts from public.list_invites() order by pattern $$,
  $$ values ('@zaproszona-domena.pl', null::text, 1), ('jan@example.com', 'Jan K.', 0) $$, 'lista z liczbą założonych kont');
select throws_ok($$ select public.add_invite('bez-malpy') $$, '23514', null, 'zły wzorzec odrzucony');
select is(public.remove_invite('JAN@example.com'), true, 'usunięcie');

select * from finish();
rollback;
