-- v1.x: centrum powiadomień, etap N3 — zmiany terminów i zdarzenia systemowe (migracja *_v1x_notification_system.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000003a1', 'wlasciciel-n3@test.local'),
  ('00000000-0000-4000-8000-0000000003a2', 'gosc-n3@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.logout() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true)
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_wall bigint) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set,
                            'hlc', lpad(p_wall::text, 15, '0') || ':00000:dev')
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;
create function pg_temp.notes(p_user uuid) returns text language sql security definer as $$
  select string_agg(n.kind || coalesce('×' || (n.data ->> 'count'), ''), ', ' order by n.kind, n.row_version)
    from public.notifications n where n.user_id = p_user and n.deleted_at is null
$$;
create function pg_temp.data(p_user uuid, p_kind text) returns jsonb language sql security definer as $$
  select n.data from public.notifications n where n.user_id = p_user and n.kind = p_kind order by n.row_version desc limit 1
$$;
create function pg_temp.file(p_name text, p_size bigint) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner_id, metadata) values ('attachments', p_name, split_part(p_name, '/', 1), jsonb_build_object('size', p_size))
$$;

\set O  '''00000000-0000-4000-8000-0000000003a1'''
\set G  '''00000000-0000-4000-8000-0000000003a2'''
\set W  '''b9300000-0000-4000-8000-000000000001'''
\set L  '''c9300000-0000-4000-8000-000000000001'''
\set C  '''e9300000-0000-4000-8000-0000000000c1'''
\set T1 '''d9300000-0000-4000-8000-000000000001'''
\set T2 '''d9300000-0000-4000-8000-000000000002'''
\set T3 '''d9300000-0000-4000-8000-000000000003'''

-- Przestrzeń właściciela z gościem; T1 przypisane gościowi, T3 to seria.
select pg_temp.login(:O);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', 1000),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), 1001),
  pg_temp.op('collaborators', :C, '{"name": "Grażyna", "email": "gosc-n3@test.local"}', 1002),
  pg_temp.op('tasks', :T1, jsonb_build_object('list_id', :L, 'title', 'Raport', 'assignee_id', :C, 'due_date', '2026-11-19'), 1003),
  pg_temp.op('tasks', :T3, jsonb_build_object('list_id', :L, 'title', 'Co tydzień', 'assignee_id', :C, 'due_date', '2026-11-19',
                                              'recurrence', '{"rrule": "FREQ=WEEKLY"}'), 1004));
select pg_temp.logout();
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');
delete from public.notifications where user_id in (:O, :G);

-- ── Terminy ──────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T1, '{"due_date": "2026-11-20", "due_time": "14:00"}', 2000));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'due_changed', 'odpowiedzialny dostaje zmianę terminu');
select is(pg_temp.data(:G, 'due_changed') - 'actor', '{"title": "Raport", "due": "2026-11-20", "time": "14:00", "before": "2026-11-19", "beforeTime": ""}'::jsonb,
  'nowy i poprzedni termin (pusty tekst = brak)');

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T1, '{"due_date": "2026-11-21", "due_time": null}', 2001));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'due_changed×2', 'druga zmiana w 10 min — scalona');
select is(pg_temp.data(:G, 'due_changed') - 'actor' - 'count' - 'title',
  '{"due": "2026-11-21", "time": "", "before": "2026-11-19", "beforeTime": ""}'::jsonb, 'scalone: nowy termin, pierwotne „przed”, godzina wyczyszczona');

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T3, '{"due_date": "2026-11-26"}', 2002),
                    pg_temp.op('tasks', :T1, '{"title": "Raport roczny"}', 2003));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'due_changed×2', 'seria i zmiana bez terminu — nic');

select pg_temp.login(:G);
select pg_temp.push(pg_temp.op('tasks', :T1, '{"due_date": "2026-11-22"}', 2004),
                    pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Od gościa', 'due_date', '2026-11-19'), 2005));
select pg_temp.logout();
select is(pg_temp.notes(:O), null, 'własna zmiana odpowiedzialnego — nikt nie dostaje');

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T2, '{"due_date": "2026-11-23"}', 2006));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'due_changed×2, due_changed', 'bez wskazanej osoby — twórca zadania');

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T2, '{"status": "done"}', 2007), pg_temp.op('tasks', :T2, '{"due_date": "2026-11-24"}', 2008));
select pg_temp.logout();
select is((select count(*) from public.notifications where user_id = :G and kind = 'due_changed'), 2::bigint, 'ukończone zadanie — bez zmiany terminu');

-- ── Integracje ───────────────────────────────────────────────────────────────────────────────
insert into public.plugin_connections (id, user_id, plugin, label, config) values ('f9300000-0000-4000-8000-000000000001', :O, 'gitlab', 'GitLab firmowy', '{}');
insert into public.plugin_deliveries (id, user_id, connection_id, task_id, source, status) values
  ('f9310000-0000-4000-8000-000000000001', :O, 'f9300000-0000-4000-8000-000000000001', :T1, 'event', 'pending'),
  ('f9310000-0000-4000-8000-000000000002', :O, 'f9300000-0000-4000-8000-000000000001', :T1, 'event', 'pending'),
  ('f9310000-0000-4000-8000-000000000003', :O, 'f9300000-0000-4000-8000-000000000001', :T1, 'manual', 'pending');
update public.plugin_deliveries set status = 'pending', error = 'HTTP 503' where id = 'f9310000-0000-4000-8000-000000000001';
select is(pg_temp.notes(:O), null, 'ponowienie — jeszcze nic');
update public.plugin_deliveries set status = 'dead', error = 'HTTP 503' where id = 'f9310000-0000-4000-8000-000000000001';
select is(pg_temp.data(:O, 'delivery_failed') - 'actor', '{"label": "GitLab firmowy", "plugin": "gitlab", "title": "Raport roczny", "excerpt": "HTTP 503"}'::jsonb,
  'wysyłka „dead” — nazwa połączenia, tytuł zadania, błąd');
update public.plugin_deliveries set status = 'failed', http_status = 422, error = 'zły szablon' where id = 'f9310000-0000-4000-8000-000000000002';
update public.plugin_deliveries set status = 'failed', http_status = 401, error = 'brak dostępu' where id = 'f9310000-0000-4000-8000-000000000003';
select is(pg_temp.notes(:O), 'delivery_failed×2', 'trwały błąd scalony; 401 (wyłączenie połączenia) — osobno');
update public.plugin_connections set status = 'error', last_error = '401 — połączenie wyłączone' where id = 'f9300000-0000-4000-8000-000000000001';
select is(pg_temp.data(:O, 'connection_error') ->> 'label', 'GitLab firmowy', 'połączenie wyłączone');
update public.plugin_connections set status = 'active' where id = 'f9300000-0000-4000-8000-000000000001';
update public.plugin_connections set status = 'disabled' where id = 'f9300000-0000-4000-8000-000000000001';
select is((select count(*) from public.notifications where user_id = :O and kind = 'connection_error'), 1::bigint, 'wyłączenie przez użytkownika — nic');

-- ── Kalendarz i AI ───────────────────────────────────────────────────────────────────────────
insert into public.calendar_accounts (id, user_id, provider, label, external_id) values
  ('f9320000-0000-4000-8000-000000000001', :O, 'google', 'jan@example.com', 'jan@example.com');
update public.calendar_accounts set status = 'revoked', last_error = 'Dostęp odwołany' where id = 'f9320000-0000-4000-8000-000000000001';
select is(pg_temp.data(:O, 'calendar_error') - 'actor', '{"label": "jan@example.com", "revoked": true, "excerpt": "Dostęp odwołany"}'::jsonb, 'kalendarz odłączony');

insert into public.ai_accounts (id, user_id, provider, key_hint, billing_confirmed_at) values ('f9330000-0000-4000-8000-000000000001', :O, 'gemini', 'x1Y2', now());
update public.ai_accounts set status = 'error', last_error = 'zły klucz' where id = 'f9330000-0000-4000-8000-000000000001';
select is(pg_temp.data(:O, 'ai_error'), null, 'nowy klucz odrzucony przy „Sprawdź” — bez powiadomienia');
update public.ai_accounts set status = 'active' where id = 'f9330000-0000-4000-8000-000000000001';
update public.ai_accounts set status = 'error', last_error = 'API key expired' where id = 'f9330000-0000-4000-8000-000000000001';
select is(pg_temp.data(:O, 'ai_error') - 'actor', '{"label": "Gemini", "excerpt": "API key expired"}'::jsonb, 'działający klucz odrzucony');

-- ── Miejsce na załączniki ────────────────────────────────────────────────────────────────────
select pg_temp.file(:O || '/' || :T1 || '/duzy.bin', 236000000);
select pg_temp.file(:O || '/' || :T1 || '/a.pdf', 1000);
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('attachments', 'f9340000-0000-4000-8000-000000000001',
  jsonb_build_object('task_id', :T1, 'kind', 'file', 'storage_path', :O || '/' || :T1 || '/a.pdf', 'name', 'a.pdf', 'size_bytes', 1000), 3000));
select pg_temp.logout();
select is(pg_temp.data(:O, 'storage_quota') ->> 'percent', '90', '≥ 90 % limitu po zapisaniu pliku');
select pg_temp.file(:O || '/' || :T1 || '/b.pdf', 1000);
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('attachments', 'f9340000-0000-4000-8000-000000000002',
  jsonb_build_object('task_id', :T1, 'kind', 'file', 'storage_path', :O || '/' || :T1 || '/b.pdf', 'name', 'b.pdf', 'size_bytes', 1000), 3001));
select pg_temp.logout();
select is((select count(*) from public.notifications where user_id = :O and kind = 'storage_quota'), 1::bigint, 'ten sam próg — raz na 30 dni');
select pg_temp.file(:O || '/' || :T1 || '/c.bin', 26200000);
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('attachments', 'f9340000-0000-4000-8000-000000000003',
  jsonb_build_object('task_id', :T1, 'kind', 'file', 'storage_path', :O || '/' || :T1 || '/c.bin', 'name', 'c.bin', 'size_bytes', 26200000), 3002));
select pg_temp.logout();
select is((select string_agg(n.data ->> 'percent', ',' order by n.row_version) from public.notifications n where n.user_id = :O and n.kind = 'storage_quota'), '90,100',
  'pełny limit — osobne powiadomienie');

select * from finish();
rollback;
