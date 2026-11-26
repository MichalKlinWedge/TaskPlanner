-- v1.x: centrum powiadomień, etap N1 (migracja *_v1x_notifications.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'wlasciciel-pow@test.local'),
  ('00000000-0000-4000-8000-0000000000a2', 'gosc-pow@test.local'),
  ('00000000-0000-4000-8000-0000000000a3', 'nowy-pow@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.logout() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true)
$$;
create function pg_temp.h(p_wall bigint) returns text language sql as $$
  select lpad(p_wall::text, 15, '0') || ':00000:dev'
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;
-- „rodzaj[×liczba]” powiadomień konta (bez usuniętych), po rodzaju i wersji (w jednej transakcji `now()` jest stałe).
create function pg_temp.notes(p_user uuid) returns text language sql security definer as $$
  select string_agg(n.kind || coalesce('×' || (n.data ->> 'count'), ''), ', ' order by n.kind, n.row_version)
    from public.notifications n where n.user_id = p_user and n.deleted_at is null
$$;

\set O  '''00000000-0000-4000-8000-0000000000a1'''
\set G  '''00000000-0000-4000-8000-0000000000a2'''
\set N  '''00000000-0000-4000-8000-0000000000a3'''
\set W  '''b7000000-0000-4000-8000-000000000001'''
\set L  '''c7000000-0000-4000-8000-000000000001'''
\set C  '''e7000000-0000-4000-8000-000000000001'''
\set T1 '''d7000000-0000-4000-8000-000000000001'''
\set T2 '''d7000000-0000-4000-8000-000000000002'''

-- Właściciel zakłada przestrzeń; Grażyna (C) to jego współpracownik z adresem gościa.
select pg_temp.login(:O);
select is((pg_temp.push(
    pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
    pg_temp.op('collaborators', :C, '{"name": "Grażyna", "email": "gosc-pow@test.local"}', pg_temp.h(1002)),
    pg_temp.op('tasks', :T1, jsonb_build_object('list_id', :L, 'title', 'Raport', 'assignee_id', :C), pg_temp.h(1003))
  ) -> 'rejected'), '[]'::jsonb, 'właściciel zakłada przestrzeń, osobę i zadanie');
select pg_temp.logout();
select is(pg_temp.notes(:O), null, 'przestrzeń jednej osoby — żadnych powiadomień');

-- ── Udostępnianie ─────────────────────────────────────────────────────────────────────────────
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');
select is(pg_temp.notes(:O), 'member_joined', 'właściciel dostaje „nowa osoba w przestrzeni”');
select is((select data ->> 'actor' from public.notifications where user_id = :O and kind = 'member_joined'), 'Grażyna',
  'autor po nazwie współpracownika odbiorcy z tym adresem');
select is((select data ->> 'workspace' from public.notifications where user_id = :O and kind = 'member_joined'), 'Wspólna', 'migawka nazwy przestrzeni');

-- ── Zadania ──────────────────────────────────────────────────────────────────────────────────
select pg_temp.login(:O);
select pg_temp.push(
  pg_temp.op('tasks', :T1, '{"title": "Raport roczny"}', pg_temp.h(2000)),
  pg_temp.op('tasks', :T2, jsonb_build_object('list_id', :L, 'title', 'Bez osoby'), pg_temp.h(2000)),
  pg_temp.op('tasks', :T1, jsonb_build_object('assignee_id', null), pg_temp.h(2001)));
select pg_temp.push(pg_temp.op('tasks', :T1, jsonb_build_object('assignee_id', :C), pg_temp.h(2002)));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'assigned', 'przypisanie osobie z kontem w przestrzeni');
select is((select data ->> 'title' from public.notifications where user_id = :G and kind = 'assigned'), 'Raport roczny', 'migawka tytułu');
select is((select data ->> 'actor' from public.notifications where user_id = :G and kind = 'assigned'), 'wlasciciel-pow@test.local',
  'autor bez współpracownika u odbiorcy — e-mail');
select is(pg_temp.notes(:O), 'member_joined', 'autor nie dostaje powiadomień o własnych zmianach');

select pg_temp.login(:O);
select pg_temp.push(
  pg_temp.op('task_comments', gen_random_uuid(), jsonb_build_object('task_id', :T1, 'body', 'Pierwszy', 'posted_at', now()), pg_temp.h(3000)),
  pg_temp.op('task_comments', gen_random_uuid(), jsonb_build_object('task_id', :T1, 'body', 'Drugi', 'posted_at', now()), pg_temp.h(3001)),
  pg_temp.op('task_comments', gen_random_uuid(), jsonb_build_object('task_id', :T1, 'body', E'Trzeci\n  z   odstępami', 'posted_at', now()), pg_temp.h(3002)));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'assigned, comment×3', 'trzy komentarze w 10 min = jeden wiersz z licznikiem');
select is((select data ->> 'excerpt' from public.notifications where user_id = :G and kind = 'comment'), 'Trzeci z odstępami', 'ostatni fragment, białe znaki ściśnięte');

select pg_temp.login(:G);
select pg_temp.push(
  pg_temp.op('task_comments', gen_random_uuid(), jsonb_build_object('task_id', :T1, 'body', 'Odpowiedź', 'posted_at', now()), pg_temp.h(4000)),
  pg_temp.op('tasks', :T2, '{"status": "done"}', pg_temp.h(4001)),
  pg_temp.op('tasks', :T1, '{"status": "done"}', pg_temp.h(4002)));
select pg_temp.logout();
select is(pg_temp.notes(:O), 'comment, completed, member_joined', 'twórca: komentarz gościa i ukończenie zadania bez osoby');
select is(pg_temp.notes(:G), 'assigned, comment×3', 'ukończenie własnego zadania — bez powiadomienia dla siebie');

-- ── Zapis klienta ────────────────────────────────────────────────────────────────────────────
create temp table ids as select
  (select id from public.notifications where user_id = :G and kind = 'comment') as g_comment,
  (select id from public.notifications where user_id = :O and kind = 'completed') as o_done;
grant select on ids to authenticated;

select pg_temp.login(:G);
select is((pg_temp.push(pg_temp.op('notifications', (select g_comment from ids), jsonb_build_object('read_at', now()), pg_temp.h(5000))) -> 'rejected'),
  '[]'::jsonb, 'odbiorca zaznacza przeczytane');
select is((pg_temp.push(pg_temp.op('notifications', (select g_comment from ids), '{"kind": "invite"}', pg_temp.h(5001))) -> 'rejected' -> 0 ->> 'code'),
  'TP005', 'inne pola tylko serwer');
select is((pg_temp.push(pg_temp.op('notifications', gen_random_uuid(), jsonb_build_object('read_at', now()), pg_temp.h(5002))) -> 'rejected' -> 0 ->> 'code'),
  'TP003', 'klient nie tworzy powiadomień');
select is((pg_temp.push(pg_temp.op('notifications', (select o_done from ids), jsonb_build_object('read_at', now()), pg_temp.h(5003))) -> 'rejected' -> 0 ->> 'code'),
  'TP003', 'cudze powiadomienie — brak dostępu');
select is((select count(*)::int from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'notifications')), 2,
  'pull_changes przynosi własne powiadomienia');
select pg_temp.logout();
select is((select read_at is not null from public.notifications where id = (select g_comment from ids)), true, 'przeczytane zapisane');

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('task_comments', gen_random_uuid(), jsonb_build_object('task_id', :T1, 'body', 'Po przeczytaniu', 'posted_at', now()), pg_temp.h(6000)));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'assigned, comment×3, comment', 'przeczytany wiersz nie jest scalany — nowy');

-- ── Lista ukryta przed gośćmi ────────────────────────────────────────────────────────────────
update public.lists set guest_access = 'hidden' where id = :L;
select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('task_comments', gen_random_uuid(), jsonb_build_object('task_id', :T1, 'body', 'Tajne', 'posted_at', now()), pg_temp.h(7000)));
select pg_temp.logout();
select is(pg_temp.notes(:G), 'assigned, comment×3, comment', 'z listy ukrytej nic nie przychodzi');
select pg_temp.login(:G);
select is((select count(*)::int from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'notifications')), 0,
  'dawne powiadomienia z ukrytej listy nie są pobierane');
select pg_temp.logout();
update public.lists set guest_access = 'edit' where id = :L;

-- ── Zaproszenie, rola, usunięcie ─────────────────────────────────────────────────────────────
select pg_temp.login(:O);
select public.share_workspace(:W, 'nowy-pow@test.local', 'viewer');
select public.set_scope_member_role(:W, :G, 'viewer');
select public.remove_scope_member(:W, :G);
select pg_temp.logout();
select is(pg_temp.notes(:N), 'invite', 'zaproszenie do konta z tym adresem');
select is(pg_temp.notes(:G), 'assigned, comment×3, comment, member_removed, role_changed', 'zmiana roli i usunięcie z przestrzeni');

select * from finish();
rollback;
