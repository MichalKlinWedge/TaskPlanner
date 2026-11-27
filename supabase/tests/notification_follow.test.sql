-- v1.x: ustawienia powiadomień — śledzenie zadań (twórca / uczestnik) i automatyczne przypomnienia
-- (migracja *_v1x_notification_follow.sql). Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000004a1', 'wlasciciel-f@test.local'),
  ('00000000-0000-4000-8000-0000000004a2', 'gosc-f@test.local');

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
  select coalesce(string_agg(n.kind, ', ' order by n.kind, n.row_version), '')
    from public.notifications n where n.user_id = p_user and n.deleted_at is null
$$;
create function pg_temp.prefs(p_user uuid, p_prefs jsonb) returns void language sql as $$
  update public.profiles set settings = jsonb_build_object('notifications', p_prefs) where id = p_user
$$;
create function pg_temp.auto(p_user uuid) returns text language sql as $$
  select coalesce(string_agg(t.title, ', ' order by t.title), '')
    from public.auto_reminder_tasks(array[p_user], '2026-11-19', '2026-11-21') t
$$;

\set O  '''00000000-0000-4000-8000-0000000004a1'''
\set G  '''00000000-0000-4000-8000-0000000004a2'''
\set W  '''b9400000-0000-4000-8000-000000000001'''
\set W2 '''b9400000-0000-4000-8000-000000000002'''
\set L  '''c9400000-0000-4000-8000-000000000001'''
\set L2 '''c9400000-0000-4000-8000-000000000002'''
\set C  '''e9400000-0000-4000-8000-0000000000c1'''
\set P  '''f9400000-0000-4000-8000-0000000000a1'''
\set T1 '''d9400000-0000-4000-8000-000000000001'''
\set T2 '''d9400000-0000-4000-8000-000000000002'''
\set T3 '''d9400000-0000-4000-8000-000000000003'''
\set T4 '''d9400000-0000-4000-8000-000000000004'''

-- Wspólna przestrzeń właściciela z gościem: „Przypisane” i „Bez echa” — gościowi, „Moje” — właściciela z gościem
-- jako uczestnikiem; „Samotne” w przestrzeni samego właściciela.
select pg_temp.login(:O);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', 1000),
  pg_temp.op('workspaces', :W2, '{"name": "Moja"}', 1001),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), 1002),
  pg_temp.op('lists', :L2, jsonb_build_object('scope_id', :W2, 'kind', 'project', 'name', 'Prywatny'), 1003),
  pg_temp.op('collaborators', :C, '{"name": "Gosia", "email": "gosc-f@test.local"}', 1004),
  pg_temp.op('tasks', :T1, jsonb_build_object('list_id', :L, 'title', 'Przypisane', 'assignee_id', :C, 'due_date', '2026-11-20', 'due_time', '10:00'), 1005),
  pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Moje', 'due_date', '2026-11-20', 'due_time', '11:00'), 1006),
  pg_temp.op('tasks', :T3, jsonb_build_object('list_id', :L, 'title', 'Bez echa', 'assignee_id', :C, 'due_date', '2026-11-20'), 1007),
  pg_temp.op('tasks', :T4, jsonb_build_object('list_id', :L2, 'title', 'Samotne', 'due_date', '2026-11-20', 'due_time', '12:00'), 1008),
  pg_temp.op('task_participants', :P, jsonb_build_object('task_id', :T2, 'collaborator_id', :C), 1009));
select pg_temp.logout();
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');
delete from public.notifications where user_id in (:O, :G);

-- ── Automatyczne przypomnienia ───────────────────────────────────────────────────────────────
select is(pg_temp.auto(:O), 'Moje', 'domyślnie: odpowiedzialny we wspólnej przestrzeni (bez przestrzeni jednej osoby)');
select is(pg_temp.auto(:G), 'Przypisane', 'osoba wskazana dostaje swoje');
select pg_temp.prefs(:O, '{"follow": {"created": true}}');
select is(pg_temp.auto(:O), 'Moje, Przypisane', 'twórca śledzi także przypisane innym');
select pg_temp.prefs(:O, '{"autoReminder": "all"}');
select is(pg_temp.auto(:O), 'Moje, Samotne', '„all” — także przestrzeń jednej osoby');
select pg_temp.prefs(:O, '{"autoReminder": "off", "follow": {"created": true}}');
select is(pg_temp.auto(:O), '', '„off” — nic');
select pg_temp.prefs(:G, '{"follow": {"participating": true}}');
select is(pg_temp.auto(:G), 'Moje, Przypisane', 'uczestnik śledzi zadanie');

-- ── Twórca: ukończenie i zmiana terminu przez osobę wskazaną ────────────────────────────────
select pg_temp.prefs(:O, '{"follow": {"created": true}}');
select pg_temp.login(:G);
select pg_temp.push(pg_temp.op('tasks', :T1, '{"due_date": "2026-11-21"}', 2000));
select pg_temp.logout();
select is(pg_temp.notes(:O), 'due_changed', 'twórca dostaje zmianę terminu');
select is(pg_temp.notes(:G), '', 'autor zmiany — nic');
select pg_temp.login(:G);
select pg_temp.push(pg_temp.op('tasks', :T1, '{"status": "done"}', 2001));
select pg_temp.logout();
select is(pg_temp.notes(:O), 'completed, due_changed', 'twórca dostaje ukończenie');

select pg_temp.prefs(:O, '{}');
select pg_temp.login(:G);
select pg_temp.push(pg_temp.op('tasks', :T3, '{"due_date": "2026-11-22"}', 2002), pg_temp.op('tasks', :T3, '{"status": "done"}', 2003));
select pg_temp.logout();
select is(pg_temp.notes(:O), 'completed, due_changed', 'bez śledzenia twórca nie dostaje nic nowego');

-- ── Uczestnik ────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T2, '{"due_time": "15:00"}', 3000));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'due_changed', 'uczestnik ze śledzeniem dostaje zmianę terminu');
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T2, '{"status": "done"}', 3001));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'completed, due_changed', 'i ukończenie');

select pg_temp.prefs(:G, '{}');
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('tasks', :T4, jsonb_build_object('list_id', :L), 3002), pg_temp.op('tasks', :T4, '{"due_time": "13:00"}', 3003));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'completed, due_changed', 'zadanie bez związku z gościem — nic');

select * from finish();
rollback;
