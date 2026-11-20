-- Etap 12: kalendarz „Task Planner” — ustawienie w profilu, sygnał do wysyłki (pg_net raz na transakcję),
-- zmiany z kalendarza z HLC serwera, powiązania, dzierżawa, uprawnienia.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000c1', 'wlasciciel-kal@test.local'),
  ('00000000-0000-4000-8000-0000000000c2', 'obcy-kal@test.local');

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
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', pg_temp.h())
$$;
-- Żądania `pg_net` do `tasks/flush` (wysyłane dopiero po zatwierdzeniu — tu liczymy kolejkę w transakcji).
create function pg_temp.kicks() returns int language sql security definer as $$
  select count(*)::int from net.http_request_queue where url like '%/calendar-sync/tasks/flush'
$$;
create function pg_temp.kicks_for(p_user uuid) returns int language sql security definer as $$
  select count(*)::int from net.http_request_queue
   where url like '%/calendar-sync/tasks/flush' and convert_from(body, 'utf8')::jsonb ->> 'userId' = p_user::text
$$;
grant execute on function pg_temp.kicks(), pg_temp.kicks_for(uuid) to authenticated, service_role;

-- Bez sekretów Vault `call_edge_function` nic nie wysyła (świeża baza bez `npm run setup`).
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'functions_url') then
    perform vault.create_secret('http://functions.invalid/functions/v1', 'functions_url');
  end if;
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret('test', 'cron_secret');
  end if;
end $$;

\set U  '''00000000-0000-4000-8000-0000000000c1'''
\set X  '''00000000-0000-4000-8000-0000000000c2'''
\set W  '''f1000000-0000-4000-8000-000000000001'''
\set W2 '''f1000000-0000-4000-8000-000000000002'''
\set L  '''f2000000-0000-4000-8000-000000000001'''
\set L2 '''f2000000-0000-4000-8000-000000000002'''
\set A  '''f3000000-0000-4000-8000-000000000001'''
\set C  '''f4000000-0000-4000-8000-000000000001'''
\set T1 '''f7000000-0000-4000-8000-000000000001'''
\set T2 '''f7000000-0000-4000-8000-000000000002'''
\set T3 '''f7000000-0000-4000-8000-000000000003'''
\set T4 '''f7000000-0000-4000-8000-000000000004'''

select pg_temp.login(:U);
select is((public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name":"Praca"}'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox')),
  pg_temp.op('workspaces', :W2, '{"name":"Dom"}'),
  pg_temp.op('lists', :L2, jsonb_build_object('scope_id', :W2, 'kind', 'inbox', 'name', 'Inbox'))
)) -> 'rejected'), '[]'::jsonb, 'przestrzenie i Inboxy');

-- ── Ustawienie (profil, LWW) ─────────────────────────────────────────────────────────────────
select is(jsonb_array_length(public.push_changes(jsonb_build_array(
  pg_temp.op('profiles', :U, jsonb_build_object('calendar_sync', jsonb_build_object('accountId', :A, 'workspaceIds', 'zle'))))) -> 'rejected'), 1,
  'calendar_sync bez listy przestrzeni odrzucone');
select is((public.push_changes(jsonb_build_array(
  pg_temp.op('profiles', :U, jsonb_build_object('calendar_sync', jsonb_build_object('accountId', :A, 'workspaceIds', jsonb_build_array(:W)))))) -> 'rejected'),
  '[]'::jsonb, 'calendar_sync zapisany przez push_changes');
select is(pg_temp.kicks(), 1, 'zmiana wyboru → sygnał do wysyłki');
select is((public.pull_changes() -> 'tables' -> 'profiles' -> 0 -> 'calendar_sync' -> 'workspaceIds'), jsonb_build_array(:W),
  'calendar_sync w pull_changes');

-- ── Sygnał: raz na transakcję, tylko zadania z godziną z wybranych przestrzeni ──────────────
select is((public.push_changes(jsonb_build_array(
  pg_temp.op('tasks', :T1, jsonb_build_object('list_id', :L, 'title', 'Raport', 'due_date', '2026-11-20', 'due_time', '10:00')),
  pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Drugie', 'due_date', '2026-11-20', 'due_time', '11:00')),
  pg_temp.op('tasks', :T3, jsonb_build_object('list_id', :L, 'title', 'Bez godziny', 'due_date', '2026-11-20')),
  pg_temp.op('tasks', :T4, jsonb_build_object('list_id', :L2, 'title', 'Dom', 'due_date', '2026-11-20', 'due_time', '18:00'))
)) -> 'rejected'), '[]'::jsonb, 'zadania przez push_changes');
select is(pg_temp.kicks(), 1, 'kilka zadań w jednej transakcji — nadal jeden sygnał na użytkownika');
select is(pg_temp.kicks_for(:U), 1, 'sygnał niesie id użytkownika');

-- Nowa transakcja: podtransakcja nie czyści zmiennej, więc sprawdzamy warunki wyzwalacza osobno.
select set_config('taskplanner.calendar_kicked', '', true);
select is((public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T3, '{"title":"Nadal bez godziny"}'))) -> 'rejected'), '[]'::jsonb, 'zmiana zadania bez godziny');
select is(pg_temp.kicks(), 1, 'zadanie bez godziny przed i po — bez sygnału');
select is((public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T4, '{"due_time":"19:00"}'))) -> 'rejected'), '[]'::jsonb, 'zmiana zadania z niewybranej przestrzeni');
select is(pg_temp.kicks(), 1, 'niewybrana przestrzeń — bez sygnału');
select is((public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T1, '{"due_time":"10:30"}'))) -> 'rejected'), '[]'::jsonb, 'przesunięcie zadania');
select is(pg_temp.kicks(), 2, 'przesunięcie zadania z godziną → sygnał');

-- ── Klient nie dotyka powiązań ani RPC serwera ───────────────────────────────────────────────
select throws_ok($$ select * from public.calendar_task_links $$, '42501', null, 'klient nie czyta powiązań');
select throws_ok(format($$ select public.calendar_task_apply(%L, %L, '{}', null) $$, :C, :T1), '42501', null, 'klient nie woła calendar_task_apply');

-- ── service_role: zmiana z kalendarza (HLC serwera) ──────────────────────────────────────────
select pg_temp.service();
insert into public.calendar_accounts (id, user_id, provider, label, external_id) values (:A, :U, 'google', 'ja@gmail.com', 'ja@gmail.com');
insert into public.calendars (id, account_id, external_id, name, is_task_target) values (:C, :A, 'tp@group.calendar.google.com', 'Task Planner', true);
select set_config('taskplanner.calendar_kicked', '', true);

select is((public.calendar_task_apply(:C, :T1, '{"due_time":"12:30","duration_min":60,"status":"done"}',
  '{"external_id":"tpf7000000","etag":"\"e1\"","pushed":{"title":"Raport"}}') ->> 'due_time'), '12:30', 'godzina z kalendarza zapisana');
select ok((select field_clock ->> 'due_time' like '%:server' and field_clock ->> 'duration_min' like '%:server' and field_clock ->> 'title' like '%:dev'
                  and status = 'todo' from public.tasks where id = :T1),
  'HLC serwera tylko dla zmienionych pól; pola spoza listy (status) pominięte');
select is(pg_temp.kicks(), 2, 'zmiana z kalendarza nie wywołuje ponownej wysyłki (znacznik źródła)');
select is((select etag from public.calendar_task_links where task_id = :T1), '"e1"', 'powiązanie zapisane');
select lives_ok(format($$ select public.calendar_task_apply(%L, %L, '{}', null) $$, :C, :T1), 'usunięcie powiązania');
select is((select count(*)::int from public.calendar_task_links where task_id = :T1), 0, 'powiązanie usunięte');
select throws_ok(format($$ select public.calendar_task_apply(%L, gen_random_uuid(), '{"title":"x"}', null) $$, :C), 'TP003', null, 'obce / nieistniejące zadanie odrzucone');

-- Wydarzenie dodane w Google → zadanie; powtórka zwraca to samo.
select is(public.calendar_task_create(:C, jsonb_build_object('list_id', :L, 'title', 'Dentysta', 'due_date', '2026-11-21', 'due_time', '14:00'), '{"external_id":"usr1","etag":"\"e2\"","pushed":{}}'),
          public.calendar_task_create(:C, jsonb_build_object('list_id', :L, 'title', 'Dentysta', 'due_date', '2026-11-21', 'due_time', '14:00'), '{"external_id":"usr1","etag":"\"e2\"","pushed":{}}'),
  'to samo wydarzenie dwa razy → jedno zadanie');

-- ── Dzierżawa ────────────────────────────────────────────────────────────────────────────────
select is(array[public.calendar_task_lock(:C, 'a'), public.calendar_task_lock(:C, 'b'), public.calendar_task_unlock(:C, 'a'), public.calendar_task_unlock(:C, 'a'), public.calendar_task_lock(:C, 'b')],
  array[true, false, true, false, true], 'dzierżawa: drugi czeka, posiadacz powtarza przebieg, potem oddaje');

-- ── Kalendarz usunięty w Google → wysyłanie wyłączone (HLC serwera) ─────────────────────────
select public.calendar_sync_disable(:U, :A);
select ok((select calendar_sync is null and field_clock ->> 'calendar_sync' like '%:server' from public.profiles where id = :U), 'calendar_sync wyczyszczone z HLC serwera');

select * from finish();
rollback;
