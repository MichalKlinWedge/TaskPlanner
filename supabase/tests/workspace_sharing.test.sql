-- v1.x: współdzielenie przestrzeni (`scope_invites`, `share_workspace`, `accept_scope_invite`, role, opuszczanie).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000d1', 'wlasciciel-wsp@test.local'),
  ('00000000-0000-4000-8000-0000000000d2', 'Edytor-Wsp@Test.local'),
  ('00000000-0000-4000-8000-0000000000d3', 'podglad-wsp@test.local'),
  ('00000000-0000-4000-8000-0000000000d4', 'obcy-wsp@test.local');
insert into public.allowed_emails (pattern, note) values ('nowy-wsp@test.local', null);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.h() returns text language sql as $$
  select lpad((floor(extract(epoch from clock_timestamp()) * 1000))::bigint::text, 15, '0') || ':00000:dev'
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', pg_temp.h())
$$;
create function pg_temp.codes(p_result jsonb) returns text language sql as $$
  select string_agg(r ->> 'code', ',') from jsonb_array_elements(p_result -> 'rejected') r
$$;
create temp table ids (name text primary key, value text);
grant all on ids to authenticated;

\set O '''00000000-0000-4000-8000-0000000000d1'''
\set E '''00000000-0000-4000-8000-0000000000d2'''
\set V '''00000000-0000-4000-8000-0000000000d3'''
\set X '''00000000-0000-4000-8000-0000000000d4'''
\set W '''f5000000-0000-4000-8000-000000000001'''
\set L '''f5100000-0000-4000-8000-000000000001'''
\set T '''f5200000-0000-4000-8000-000000000001'''

select pg_temp.login(:O);
select is((public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name":"Wspólna"}'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox')),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Wspólne zadanie'))
)) -> 'rejected'), '[]'::jsonb, 'właściciel zakłada przestrzeń');

-- ── Zapraszanie ──────────────────────────────────────────────────────────────────────────────
select throws_ok($$ select public.share_workspace('f5000000-0000-4000-8000-000000000001', 'kto@nieznany.pl', 'editor') $$,
  '22023', null, 'adres bez konta i bez zaproszenia do aplikacji odrzucony');
select throws_ok($$ select public.share_workspace('f5000000-0000-4000-8000-000000000001', 'wlasciciel-wsp@test.local', 'editor') $$,
  '22023', null, 'własny adres odrzucony');
select throws_ok($$ select public.share_workspace('f5000000-0000-4000-8000-000000000001', 'podglad-wsp@test.local', 'owner') $$,
  '22023', null, 'rola właściciela niedostępna');
select throws_ok($$ select public.share_workspace(auth.uid(), 'podglad-wsp@test.local', 'editor') $$,
  '42501', null, 'zakresu osobistego nie da się udostępnić');
select lives_ok($$ insert into ids select 'e', public.share_workspace('f5000000-0000-4000-8000-000000000001', ' EDYTOR-wsp@test.local ', 'viewer') ->> 'token' $$,
  'zaproszenie istniejącego konta (normalizacja adresu)');
select lives_ok($$ insert into ids select 'e2', public.share_workspace('f5000000-0000-4000-8000-000000000001', 'edytor-wsp@test.local', 'editor') ->> 'token' $$,
  'ponowne zaproszenie zmienia rolę i token');
select lives_ok($$ insert into ids select 'v', public.share_workspace('f5000000-0000-4000-8000-000000000001', 'podglad-wsp@test.local', 'viewer') ->> 'token' $$,
  'zaproszenie z rolą podglądu');
select lives_ok($$ select public.share_workspace('f5000000-0000-4000-8000-000000000001', 'nowy-wsp@test.local', 'editor') $$,
  'adres z listy zaproszonych do aplikacji (jeszcze bez konta)');
select results_eq($$ select i ->> 'email', i ->> 'role' from jsonb_array_elements(public.workspace_sharing('f5000000-0000-4000-8000-000000000001') -> 'invites') i order by 1 $$,
  $$ values ('edytor-wsp@test.local', 'editor'), ('nowy-wsp@test.local', 'editor'), ('podglad-wsp@test.local', 'viewer') $$,
  'właściciel widzi zaproszenia');

-- ── Obcy ─────────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:X);
select is(public.my_scope_invites(), '[]'::jsonb, 'obcy nie ma zaproszeń');
select throws_ok($$ select public.workspace_sharing('f5000000-0000-4000-8000-000000000001') $$, '42501', null, 'obcy nie widzi członków');
select throws_ok($$ select public.share_workspace('f5000000-0000-4000-8000-000000000001', 'obcy-wsp@test.local', 'editor') $$,
  '42501', null, 'obcy nie zaprasza');
select throws_ok($$ select public.accept_scope_invite(p_token => (select value from ids where name = 'v')) $$,
  '42501', null, 'cudzy link nie działa dla innego adresu');
select throws_ok($$ select * from public.scope_invites $$, '42501', null, 'tabela zaproszeń niewidoczna dla klientów');

-- ── Edytor (przyjęcie z listy w aplikacji) ───────────────────────────────────────────────────
select pg_temp.login(:E);
select is((select jsonb_agg(jsonb_build_object('workspace', i -> 'workspace', 'role', i -> 'role', 'by', i -> 'invitedBy')) from jsonb_array_elements(public.my_scope_invites()) i),
  '[{"workspace":"Wspólna","role":"editor","by":"wlasciciel-wsp@test.local"}]'::jsonb, 'zaproszony widzi zaproszenie w aplikacji');
select throws_ok($$ select public.accept_scope_invite(p_token => (select value from ids where name = 'e')) $$,
  'P0002', null, 'stary token po ponownym zaproszeniu nie działa');
select is(public.accept_scope_invite(p_id => (public.my_scope_invites() -> 0 ->> 'id')::uuid), 'f5000000-0000-4000-8000-000000000001'::uuid, 'przyjęcie po id');
select is(public.pull_changes() -> 'scopes' -> 'f5000000-0000-4000-8000-000000000001' ->> 'role',
  'editor', 'nowy zakres w pull_changes z rolą');
select is((public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T, '{"title":"Poprawione przez edytora"}'))) -> 'rejected'), '[]'::jsonb, 'edytor zmienia zadanie');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('workspaces', :W, jsonb_build_object('deleted_at', now()))))),
  'TP003', 'edytor nie usuwa przestrzeni');
select throws_ok($$ select public.share_workspace('f5000000-0000-4000-8000-000000000001', 'obcy-wsp@test.local', 'editor') $$,
  '42501', null, 'edytor nie zaprasza');

-- ── Podgląd (przyjęcie z linku) ──────────────────────────────────────────────────────────────
select pg_temp.login(:V);
select lives_ok($$ select public.accept_scope_invite(p_token => (select value from ids where name = 'v')) $$, 'przyjęcie z linku');
select is(pg_temp.codes(public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T, '{"title":"Podgląd próbuje"}')))), 'TP003', 'podgląd nie zapisuje');
select is((select jsonb_agg(m ->> 'role') from jsonb_array_elements(public.workspace_sharing('f5000000-0000-4000-8000-000000000001') -> 'members') m),
  '["owner","editor","viewer"]'::jsonb, 'członek widzi listę członków');
select is(public.workspace_sharing('f5000000-0000-4000-8000-000000000001') -> 'invites', '[]'::jsonb, 'nie-właściciel nie widzi zaproszeń');
select is((select count(*) from jsonb_array_elements(public.workspace_sharing('f5000000-0000-4000-8000-000000000001') -> 'members') m
            where (m ->> 'joinedAt')::timestamptz is not null), 3::bigint, 'każdy członek ma datę dołączenia');

-- ── Właściciel zarządza ──────────────────────────────────────────────────────────────────────
select pg_temp.login(:O);
select lives_ok($$ select public.set_scope_member_role('f5000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000d3', 'editor') $$, 'zmiana roli');
select throws_ok($$ select public.remove_scope_member('f5000000-0000-4000-8000-000000000001', auth.uid()) $$, '22023', null, 'właściciel nie opuszcza własnej przestrzeni');

-- ── Opuszczenie i usunięcie ──────────────────────────────────────────────────────────────────
select pg_temp.login(:E);
select lives_ok($$ select public.remove_scope_member('f5000000-0000-4000-8000-000000000001', auth.uid()) $$, 'edytor opuszcza przestrzeń');
select is((public.pull_changes() -> 'scopes') ? 'f5000000-0000-4000-8000-000000000001',
  false, 'po opuszczeniu zakresu nie ma w pull_changes');

select * from finish();
rollback;
