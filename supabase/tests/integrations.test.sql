-- PoC-6 / MVP-4: tabele integracji — RLS i uprawnienia kolumn, Vault, zadanie z integracji, dziennik Web Push, cron.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000b1', 'wlasciciel-int@test.local'),
  ('00000000-0000-4000-8000-0000000000b2', 'obcy-int@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.service() returns void language sql as $$
  select set_config('role', 'service_role', true),
         set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true)
$$;
create function pg_temp.h() returns text language sql as $$
  select lpad((floor(extract(epoch from clock_timestamp()) * 1000))::bigint::text, 15, '0') || ':00000:dev'
$$;

\set U  '''00000000-0000-4000-8000-0000000000b1'''
\set X  '''00000000-0000-4000-8000-0000000000b2'''
\set W  '''e1000000-0000-4000-8000-000000000001'''
\set L  '''e2000000-0000-4000-8000-000000000001'''
\set A  '''e3000000-0000-4000-8000-000000000001'''
\set C  '''e4000000-0000-4000-8000-000000000001'''
\set D  '''e6000000-0000-4000-8000-000000000001'''
\set T  '''e7000000-0000-4000-8000-000000000001'''

-- Przestrzeń i Inbox właściciela (jak klient).
select pg_temp.login(:U);
select is((public.push_changes(jsonb_build_array(
  jsonb_build_object('op', gen_random_uuid(), 'table', 'workspaces', 'id', :W, 'set', '{"name":"Dom"}'::jsonb, 'hlc', pg_temp.h()),
  jsonb_build_object('op', gen_random_uuid(), 'table', 'lists', 'id', :L, 'set', jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), 'hlc', pg_temp.h())
)) -> 'rejected'), '[]'::jsonb, 'przestrzeń i Inbox przez push_changes');
select is((public.push_changes(jsonb_build_array(
  jsonb_build_object('op', gen_random_uuid(), 'table', 'devices', 'id', :D, 'hlc', pg_temp.h(), 'set',
    '{"name":"Chrome","platform":"web","reminder_channel":"enabled","push_subscription":{"endpoint":"https://push.example/1","keys":{"p256dh":"p","auth":"a"}}}'::jsonb),
  jsonb_build_object('op', gen_random_uuid(), 'table', 'tasks', 'id', :T, 'set', jsonb_build_object('list_id', :L, 'title', 'Przypomnij'), 'hlc', pg_temp.h())
)) -> 'rejected'), '[]'::jsonb, 'urządzenie z subskrypcją i zadanie przez push_changes');

-- ── Klient nie pisze tabel integracji ────────────────────────────────────────────────────────
select throws_ok($$ insert into public.calendar_accounts (user_id, provider, label, external_id) values (auth.uid(), 'ics', 'x', 'x') $$,
  '42501', null, 'klient nie zakłada konta kalendarza');
select throws_ok($$ insert into public.inbound_messages (user_id, status) values (auth.uid(), 'created') $$, '42501', null, 'klient nie pisze dziennika maili');
select throws_ok(format($$ insert into public.reminder_deliveries (user_id, device_id, fire_key, task_id, fire_at) values (auth.uid(), %L, 'x', %L, now()) $$, :D, :T),
  '42501', null, 'klient nie pisze dziennika wysyłek');
select throws_ok($$ select public.account_secret_get(gen_random_uuid()) $$, '42501', null, 'klient nie czyta Vault');
select throws_ok($$ select public.create_integration_task(auth.uid(), '{}', '[]') $$, '42501', null, 'klient nie woła create_integration_task');
select throws_ok($$ select * from public.claim_reminder_deliveries('[]') $$, '42501', null, 'klient nie zajmuje wysyłek');

-- ── service_role: konto, kalendarz, wydarzenie, sekret ───────────────────────────────────────
select pg_temp.service();
select lives_ok(format($$ insert into public.calendar_accounts (id, user_id, provider, label, external_id) values (%L, %L, 'google', 'ja@gmail.com', 'ja@gmail.com') $$, :A, :U),
  'service_role zakłada konto');
select lives_ok(format($$ select public.account_secret_set(%L, '{"refreshToken":"rt"}') $$, :A), 'sekret do Vault');
select is(public.account_secret_get(:A), '{"refreshToken":"rt"}', 'sekret z Vault');
select lives_ok(format($$ select public.account_secret_set(%L, '{"refreshToken":"rt2"}') $$, :A), 'aktualizacja sekretu');
select is((select count(*)::int from vault.secrets where name = 'calendar_account:' || :A), 1, 'jeden wpis w Vault na konto');

insert into public.calendars (id, account_id, external_id, name, sync_state) values (:C, :A, 'primary', 'ja@gmail.com', '{"syncToken":"tajne"}');
select is((select user_id from public.calendars where id = :C), :U::uuid, 'kalendarz dziedziczy użytkownika z konta');
select lives_ok(format($$ insert into public.calendar_events (calendar_id, external_id, title, start_at, end_at) values (%L, 'e1', 'Spotkanie', now(), now() + interval '1 hour') $$, :C),
  'wydarzenie z godziną');
select throws_ok(format($$ insert into public.calendar_events (calendar_id, external_id, all_day) values (%L, 'e2', true) $$, :C),
  '23514', null, 'całodniowe wymaga dat');

select cmp_ok((select row_version from public.calendar_events where external_id = 'e1'), '=',
  (select sync_version from public.sync_scopes where id = :U), 'wydarzenie podbija licznik zakresu osobistego (sygnał Realtime)');

-- ── RLS i kolumny ────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:U);
select is((select count(*)::int from public.calendar_events), 1, 'właściciel widzi swoje wydarzenia');
select is((select label from public.calendar_accounts), 'ja@gmail.com', 'właściciel widzi konto');
select throws_ok($$ select secret_id from public.calendar_accounts $$, '42501', null, 'secret_id niewidoczne dla klienta');
select throws_ok($$ select sync_state from public.calendars $$, '42501', null, 'sync_state (syncToken, token kanału) niewidoczne');
select pg_temp.login(:X);
select is((select count(*)::int from public.calendar_events) + (select count(*)::int from public.calendar_accounts), 0, 'obcy nic nie widzi');

-- ── Adres e-mail i zadanie z integracji ─────────────────────────────────────────────────────
select pg_temp.login(:U);
select matches(public.rotate_inbound_token(), '^[a-z0-9]{24}$', 'token adresu: 24 znaki [a-z0-9]');
select lives_ok($$ select public.set_inbound_senders(array['Ja@Example.com', ' ', 'ja@example.com']) $$, 'lista nadawców');
select is((select senders from public.inbound_addresses), array['ja@example.com'], 'nadawcy: małe litery, bez pustych i powtórzeń');

select pg_temp.service();
select lives_ok(format($$ select public.create_integration_task(%L, jsonb_build_object('id', 'e5000000-0000-4000-8000-000000000001', 'list_id', %L, 'title', 'Z maila', 'priority', 2)) $$, :U, :L),
  'zadanie z integracji do Inboxu właściciela');
select is((select row(scope_id, created_by, priority)::text from public.tasks where id = 'e5000000-0000-4000-8000-000000000001'),
  row(:W::uuid, :U::uuid, 2::smallint)::text, 'zakres z listy, autor = użytkownik');
select ok((select field_clock ?& array['list_id', 'title', 'priority'] and field_clock ->> 'title' like '%:server'
             from public.tasks where id = 'e5000000-0000-4000-8000-000000000001'), 'field_clock z HLC serwera dla każdego pola');
select throws_ok(format($$ select public.create_integration_task(%L, jsonb_build_object('list_id', %L, 'title', 'Obce')) $$, :X, :L),
  'TP003', null, 'zadanie do cudzej listy odrzucone');

-- ── Dziennik Web Push (MVP-4) ────────────────────────────────────────────────────────────────
create temp table claim_items as select jsonb_build_array(jsonb_build_object('user_id', :U, 'device_id', :D, 'fire_key', 'r1:2026-11-19', 'task_id', :T, 'fire_at', now())) as items;
grant select on claim_items to service_role;
select is((select count(*)::int from public.claim_reminder_deliveries((select items from claim_items))), 1, 'wysyłka zajęta');
select is((select count(*)::int from public.claim_reminder_deliveries((select items from claim_items))), 0, 'to samo urządzenie i wystąpienie drugi raz — nie');
update public.reminder_deliveries set status = 'failed' where device_id = :D;
select is((select attempts from public.claim_reminder_deliveries((select items from claim_items))), 2, 'po błędzie przejściowym — ponowienie');
select public.clear_push_subscription(:D, 'https://push.example/1');
select ok((select push_subscription is null and field_clock ->> 'push_subscription' like '%:server' from public.devices where id = :D),
  'wygasła subskrypcja wyczyszczona z HLC serwera');

-- ── Odłączenie konta i cron ──────────────────────────────────────────────────────────────────
delete from public.calendar_accounts where id = :A;
select is((select count(*)::int from vault.secrets where name = 'calendar_account:' || :A) + (select count(*)::int from public.calendar_events where calendar_id = :C),
  0, 'usunięcie konta usuwa sekret Vault i wydarzenia');
reset role;
select set_eq($$ select jobname || ' ' || schedule from cron.job where jobname like 'taskplanner-%' $$,
  array['taskplanner-reminders-push * * * * *', 'taskplanner-calendar-poll */10 * * * *', 'taskplanner-calendar-renew 17 3 * * *', 'taskplanner-oauth-states-cleanup 23 * * * *'],
  'zadania pg_cron');

select * from finish();
rollback;
