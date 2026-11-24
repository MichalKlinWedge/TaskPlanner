-- v1.x: kilku właścicieli przestrzeni, przekazanie za zgodą, zrzeczenie się (migracja *_v1x_workspace_owners.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

insert into auth.users (id, email, created_at) values
  ('00000000-0000-4000-8000-0000000000e1', 'glowny-wl@test.local', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000e2', 'drugi-wl@test.local', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000e3', 'trzeci-wl@test.local', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000000000e4', 'obcy-wl@test.local', now());

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.logout() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true)
$$;
create function pg_temp.h() returns text language sql as $$
  select lpad((floor(extract(epoch from clock_timestamp()) * 1000))::bigint::text, 15, '0') || ':00000:dev'
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', pg_temp.h())
$$;
create function pg_temp.push(p_table text, p_id uuid, p_set jsonb) returns text language sql as $$
  select coalesce(public.push_changes(jsonb_build_array(pg_temp.op(p_table, p_id, p_set))) -> 'rejected' -> 0 ->> 'code', 'ok')
$$;
-- „rola / główny” każdego członka, np. `owner* editor viewer` (kolejność po adresie).
create function pg_temp.roles(p_scope uuid) returns text language sql security definer as $$
  select string_agg(split_part(u.email, '-', 1) || ':' || m.role || case when s.owner_id = m.user_id then '*' else '' end, ' ' order by u.email)
    from public.scope_members m join auth.users u on u.id = m.user_id join public.sync_scopes s on s.id = m.scope_id
   where m.scope_id = p_scope
$$;
create function pg_temp.offer_id() returns uuid language sql as $$
  select (public.my_ownership_offers() -> 0 ->> 'id')::uuid
$$;

\set A '''00000000-0000-4000-8000-0000000000e1'''
\set B '''00000000-0000-4000-8000-0000000000e2'''
\set C '''00000000-0000-4000-8000-0000000000e3'''
\set X '''00000000-0000-4000-8000-0000000000e4'''
\set W '''f6000000-0000-4000-8000-000000000001'''
\set L '''f6100000-0000-4000-8000-000000000001'''

select pg_temp.login(:A);
select is(public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name":"Firma"}'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox', 'guest_access', 'hidden'))
)) -> 'rejected', '[]'::jsonb, 'właściciel zakłada przestrzeń z ukrytą listą');
select pg_temp.logout();
insert into public.scope_members (scope_id, user_id, role) values (:W, :B, 'editor'), (:W, :C, 'viewer');

-- ── Kto może proponować ──────────────────────────────────────────────────────────────────────
select pg_temp.login(:B);
select throws_ok(format('select public.offer_workspace_ownership(%L, %L)', :W, :C), '42501', null, 'edytor nie proponuje własności');
select throws_ok(format('select public.offer_workspace_ownership(%L, %L)', :W, :B), '42501', null, 'edytor nie proponuje własności sobie');
select throws_ok(format('select public.set_scope_member_role(%L, %L, %L)', :W, :B, 'owner'), '42501', null, 'edytor nie podnosi sobie roli');
select throws_ok($$ select * from public.scope_owner_offers $$, '42501', null, 'tabela propozycji niewidoczna dla klientów');
select throws_ok(format('select public.drop_scope_owner(%L, %L, %L)', :W, :A, 'leave'), '42501', null, 'funkcje pomocnicze niedostępne dla klientów');
select throws_ok(format('select public.signal_scope(%L)', :W), '42501', null, 'sygnał zakresu niedostępny dla klientów');

select pg_temp.login(:A);
select throws_ok(format('select public.offer_workspace_ownership(%L, %L)', :W, :X), 'P0002', null, 'propozycja tylko dla członka');
select throws_ok(format('select public.offer_workspace_ownership(%L, %L)', :W, :A), '22023', null, 'propozycja dla siebie odrzucona');
select throws_ok(format('select public.offer_workspace_ownership(%L, %L, %L)', :W, :B, 'owner'), '22023', null, 'nieznana rola po przekazaniu odrzucona');
select throws_ok($$ select public.offer_workspace_ownership(auth.uid(), '00000000-0000-4000-8000-0000000000e2') $$, '42501', null, 'zakresu osobistego nie da się przekazać');
select throws_ok(format('select public.set_scope_member_role(%L, %L, %L)', :W, :B, 'owner'), '22023', null, 'roli właściciela nie da się nadać bez zgody');
select throws_ok(format('select public.resign_workspace_owner(%L)', :W), '22023', null, 'główny właściciel nie zrzeka się bez następcy');

-- ── Kolejny właściciel za zgodą ──────────────────────────────────────────────────────────────
select lives_ok(format('select public.offer_workspace_ownership(%L, %L)', :W, :B), 'propozycja roli właściciela');
select is(pg_temp.roles(:W), 'drugi:editor glowny:owner* trzeci:viewer', 'bez zgody nic się nie zmienia');
select is(jsonb_array_length(public.workspace_sharing(:W) -> 'offers'), 1, 'właściciel widzi czekającą propozycję');

select pg_temp.login(:C);
select is(public.workspace_sharing(:W) -> 'offers', '[]'::jsonb, 'inny członek nie widzi cudzej propozycji');
select pg_temp.logout();
create temp table ids as select id from public.scope_owner_offers;
grant select on ids to authenticated;
select pg_temp.login(:C);
select throws_ok($$ select public.answer_workspace_ownership_offer((select id from ids), true) $$, 'P0002', null, 'cudzej propozycji nie da się przyjąć');
select is(public.cancel_workspace_ownership_offer((select id from ids)), false, 'ani wycofać');

select pg_temp.login(:B);
select is((select jsonb_build_object('w', o -> 'workspace', 'by', o -> 'offeredBy', 'after', o -> 'after', 'primary', o -> 'primary') from jsonb_array_elements(public.my_ownership_offers()) o),
  '{"w":"Firma","by":"glowny-wl@test.local","after":null,"primary":false}'::jsonb, 'adresat widzi propozycję');
select lives_ok($$ select public.answer_workspace_ownership_offer(pg_temp.offer_id(), false) $$, 'odmowa');
select is(pg_temp.roles(:W), 'drugi:editor glowny:owner* trzeci:viewer', 'odmowa niczego nie zmienia');
select is(public.my_ownership_offers(), '[]'::jsonb, 'po odmowie propozycji nie ma');

select pg_temp.login(:A);
select lives_ok(format('select public.offer_workspace_ownership(%L, %L)', :W, :B), 'ponowna propozycja');
select pg_temp.logout();
create temp table ver as select sync_version as v from public.sync_scopes where id = 'f6000000-0000-4000-8000-000000000001';
select pg_temp.login(:B);
select is(jsonb_array_length(public.pull_changes() -> 'scopes' -> 'f6000000-0000-4000-8000-000000000001' -> 'hidden'), 1, 'przed przyjęciem lista ukryta');
select is(public.answer_workspace_ownership_offer(pg_temp.offer_id(), true), :W::uuid, 'przyjęcie');
select is(pg_temp.roles(:W), 'drugi:owner glowny:owner* trzeci:viewer', 'dwóch właścicieli, główny bez zmian');
select is(public.pull_changes() -> 'scopes' -> 'f6000000-0000-4000-8000-000000000001' ->> 'role', 'owner', 'nowa rola w pull_changes');
select is(public.pull_changes() -> 'scopes' -> 'f6000000-0000-4000-8000-000000000001' -> 'hidden', '[]'::jsonb, 'właściciel widzi ukryte listy');
select is(pg_temp.push('lists', :L, '{"guest_access":"view"}'), 'ok', 'współwłaściciel zmienia dostęp gości do listy');
select is(pg_temp.push('workspaces', :W, jsonb_build_object('deleted_at', now())), 'ok', 'współwłaściciel usuwa przestrzeń');
select is(pg_temp.push('workspaces', :W, '{"deleted_at":null}'), 'ok', 'i ją przywraca');
select lives_ok(format('select public.share_workspace(%L, %L, %L)', :W, 'obcy-wl@test.local', 'viewer'), 'współwłaściciel zaprasza');
select lives_ok(format('select public.set_scope_member_role(%L, %L, %L)', :W, :C, 'editor'), 'współwłaściciel zmienia rolę członka');
select throws_ok(format('select public.set_scope_member_role(%L, %L, %L)', :W, :A, 'viewer'), '42501', null, 'współwłaściciel nie odbiera roli głównemu');
select throws_ok(format('select public.remove_scope_member(%L, %L)', :W, :A), '42501', null, 'ani go nie usuwa');
select throws_ok(format('select public.remove_scope_member(%L, %L)', :W, :B), '22023', null, 'właściciel nie wychodzi bez zrzeczenia się roli');
select pg_temp.logout();
select ok((select sync_version from public.sync_scopes where id = :W) > (select v from ver), 'zmiana ról daje sygnał synchronizacji');

-- ── Współwłaściciel rezygnuje, główny odbiera rolę ───────────────────────────────────────────
select pg_temp.login(:B);
select lives_ok(format('select public.resign_workspace_owner(%L, %L)', :W, 'viewer'), 'współwłaściciel zrzeka się roli');
select is(pg_temp.roles(:W), 'drugi:viewer glowny:owner* trzeci:editor', 'zostaje z wybraną rolą');
select is(pg_temp.push('workspaces', :W, '{"name":"Przejęta"}'), 'TP003', 'i z jej uprawnieniami');
select pg_temp.logout();
update public.scope_members set role = 'owner' where scope_id = :W and user_id = :B;
select pg_temp.login(:B);
select lives_ok(format('select public.offer_workspace_ownership(%L, %L)', :W, :C), 'propozycja współwłaściciela');
select pg_temp.login(:A);
select lives_ok(format('select public.set_scope_member_role(%L, %L, %L)', :W, :B, 'editor'), 'główny odbiera rolę współwłaścicielowi');
select pg_temp.login(:C);
select is(public.my_ownership_offers(), '[]'::jsonb, 'propozycje odebranego właściciela tracą ważność');

-- ── Przekazanie przestrzeni za zgodą ─────────────────────────────────────────────────────────
select pg_temp.login(:A);
select lives_ok(format('select public.offer_workspace_ownership(%L, %L, %L)', :W, :C, 'leave'), 'propozycja przekazania');
select lives_ok(format('select public.offer_workspace_ownership(%L, %L, %L)', :W, :B, 'editor'), 'nowe przekazanie innej osobie');
select is((select jsonb_agg(o -> 'email') from jsonb_array_elements(public.workspace_sharing(:W) -> 'offers') o), '["drugi-wl@test.local"]'::jsonb,
  'przekazanie czeka tylko u jednej osoby');
select is(pg_temp.roles(:W), 'drugi:editor glowny:owner* trzeci:editor', 'do przyjęcia główny pozostaje właścicielem');
select pg_temp.login(:B);
select is(public.my_ownership_offers() -> 0 ->> 'primary', 'true', 'adresat wie, że przejmie rolę głównego');
select lives_ok($$ select public.answer_workspace_ownership_offer(pg_temp.offer_id(), true) $$, 'przyjęcie przekazania');
select is(pg_temp.roles(:W), 'drugi:owner* glowny:editor trzeci:editor', 'przejmujący jest głównym właścicielem, poprzedni — edytorem');
select pg_temp.login(:A);
select throws_ok(format('select public.share_workspace(%L, %L, %L)', :W, 'obcy-wl@test.local', 'editor'), '42501', null, 'poprzedni właściciel nie zarządza');
select is(pg_temp.push('workspaces', :W, jsonb_build_object('deleted_at', now())), 'TP003', 'ani nie usuwa przestrzeni');

-- ── Wygaśnięcie, przekazanie z wyjściem ──────────────────────────────────────────────────────
select pg_temp.login(:B);
select lives_ok(format('select public.offer_workspace_ownership(%L, %L, %L)', :W, :C, 'leave'), 'przekazanie z wyjściem');
select pg_temp.logout();
update public.scope_owner_offers set expires_at = now() - interval '1 minute';
truncate ids;
insert into ids select id from public.scope_owner_offers;
select pg_temp.login(:C);
select throws_ok($$ select public.answer_workspace_ownership_offer((select id from ids), true) $$, '22023', null, 'wygasłej nie da się przyjąć');
select pg_temp.login(:B);
select public.offer_workspace_ownership(:W, :C, 'leave');
select pg_temp.login(:C);
select lives_ok($$ select public.answer_workspace_ownership_offer(pg_temp.offer_id(), true) $$, 'przyjęcie odnowionej');
select is(pg_temp.roles(:W), 'glowny:editor trzeci:owner*', 'poprzedni właściciel wyszedł z przestrzeni');

-- ── Usunięcie konta głównego właściciela ─────────────────────────────────────────────────────
select pg_temp.logout();
update public.scope_members set role = 'owner' where scope_id = :W and user_id = :A;
delete from auth.users where id = :C;
select is(pg_temp.roles(:W), 'glowny:owner*', 'przestrzeń przechodzi na innego właściciela');
select is((select count(*)::int from public.lists where scope_id = :W), 1, 'z danymi');
delete from auth.users where id = :A;
select is((select count(*)::int from public.sync_scopes where id = :W), 0, 'bez innego właściciela znika jak dotąd');

select * from finish();
rollback;
