-- Centrum powiadomień (v1.x, etap N1; PLAN_ETAPOWY.md → „Centrum powiadomień (web)”). Migracja addytywna
-- (w chmurze są prawdziwe dane).
--
-- `notifications` = tabela synchronizowana w zakresie osobistym odbiorcy. Wiersze tworzą wyłącznie wyzwalacze
-- serwera przez `notify` (serwerowy HLC w `field_clock`); klient przez `push_changes` zmienia tylko `read_at`
-- i `deleted_at` swoich wierszy, więc „przeczytane” działa offline i przechodzi między urządzeniami.
-- Nieprzeczytany wiersz z tym samym `group_key` z ostatnich 10 min dostaje `count + 1` zamiast nowego wiersza.
-- Autor zmiany nie dostaje powiadomienia o własnym działaniu; zmiany bez autora (serwer, integracje bez
-- `taskplanner.actor`) nie dają powiadomień. Odbiorca zadania musi je widzieć (`list_access` = `view` / `edit`);
-- zadanie przeniesione później na listę ukrytą: `pull_changes` pomija wiersz (kolumna `task_id`, jak inne
-- wiersze zadania) i wysyła `_gone`.
--
-- Rodzaje (`kind`, teksty w `packages/core/src/notifications.ts`):
--   assigned       przypisano mi zadanie (odpowiedzialny = konto współpracownika, `collaborator_account`)
--   comment        nowy komentarz w zadaniu, za które odpowiadam / w którym uczestniczę / które utworzyłem
--   participant    dodano mnie jako uczestnika zadania
--   completed      ktoś ukończył zadanie, za które odpowiadam (bez wskazanej osoby — twórca)
--   invite         zaproszenie do przestrzeni (adres z kontem)
--   owner_offer    propozycja roli właściciela
--   member_joined  ktoś dołączył do przestrzeni, w której jestem właścicielem
--   member_left    ktoś opuścił przestrzeń, w której jestem właścicielem
--   member_removed usunięto mnie z przestrzeni
--   role_changed   zmieniono moją rolę w przestrzeni
-- `data` (camelCase): `actor` (nazwa autora: mój współpracownik z tym adresem → nazwa z profilu → e-mail),
-- `title` (migawka tytułu zadania), `workspace` (nazwa przestrzeni), `excerpt` (początek komentarza), `role`,
-- `after`, `count` (scalone zdarzenia, domyślnie 1).

create table public.notifications (
  id uuid primary key,
  user_id uuid not null,
  kind text not null check (kind in ('assigned', 'comment', 'participant', 'completed', 'invite', 'owner_offer',
                                     'member_joined', 'member_left', 'member_removed', 'role_changed')),
  task_id uuid,
  workspace_id uuid,
  actor_id uuid,
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  group_key text,
  at timestamptz not null default now(),
  read_at timestamptz
);

-- Kolejność = kolejność stosowania u klienta (rodzice przed dziećmi; lokalnie bez kluczy obcych).
create or replace function public.synced_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions', 'profiles', 'devices',
               'reminders', 'task_dependencies', 'time_entries', 'attachments', 'saved_filters', 'review_sessions',
               'collaborators', 'task_participants', 'task_comments', 'plugin_rules', 'plugin_requests',
               'project_templates', 'notifications']
$$;

alter table public.notifications
  add column scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column created_by uuid,
  add column deleted_at timestamptz,
  add column row_version bigint not null default 0,
  add column field_clock jsonb not null default '{}';
alter table public.notifications add constraint notifications_personal check (scope_id = user_id);
create index notifications_sync on public.notifications (scope_id, row_version);
create index notifications_group on public.notifications (user_id, group_key, at desc) where read_at is null and deleted_at is null;
create index notifications_at on public.notifications (at);
alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select to authenticated using (public.has_scope_access(scope_id));
revoke all on public.notifications from anon;
revoke insert, update, delete, truncate on public.notifications from authenticated;
-- Projekt w chmurze nie nadaje ról API do tabel z migracji (wniosek z PoC-6).
grant select on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- Pola, które klient może ustawić: przy powiadomieniach tylko „przeczytane” i usunięcie z listy.
create or replace function public.writable_columns(p_table text) returns text[]
language sql stable set search_path = '' as $$
  select case
           when p_table = 'notifications' then array['read_at', 'deleted_at']::text[]
           else (select coalesce(array_agg(column_name::text order by ordinal_position), '{}')
                   from information_schema.columns
                  where table_schema = 'public' and table_name = p_table
                    and column_name not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock')
                    and (column_name <> 'scope_id'
                         or p_table in ('lists', 'tags', 'devices', 'saved_filters', 'review_sessions', 'collaborators', 'plugin_rules',
                                        'plugin_requests', 'project_templates')))
         end
$$;

-- Wersja wiersza z licznika zakresu (jak `stamp_row`). Zapis klienta (`auth.uid()` bez znacznika `notify`):
-- tylko zmiana `read_at` / `deleted_at` własnego wiersza; wstawienie zawsze odrzucone.
create function public.stamp_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fixed constant text[] := array['read_at', 'deleted_at', 'updated_at', 'row_version', 'field_clock'];
begin
  if auth.uid() is not null and coalesce(current_setting('taskplanner.notify', true), '') <> 'on' then
    if tg_op = 'INSERT' then
      raise exception using errcode = 'TP003', message = 'Powiadomienia tworzy serwer';
    end if;
    if old.user_id <> auth.uid() or not public.can_write_scope(new.scope_id) then
      raise exception using errcode = 'TP003', message = 'Brak dostępu do zakresu';
    end if;
    if (to_jsonb(new) - fixed) is distinct from (to_jsonb(old) - fixed) then
      raise exception using errcode = 'TP005', message = 'Niedozwolone pole w notifications';
    end if;
  end if;
  update public.sync_scopes set sync_version = sync_version + 1 where id = new.scope_id
  returning sync_version into new.row_version;
  if new.row_version is null then
    raise exception using errcode = 'TP004', message = 'Brak zakresu ' || coalesce(new.scope_id::text, 'null');
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  end if;
  return new;
end $$;
create trigger z_stamp before insert or update on public.notifications for each row execute function public.stamp_notification();

-- ── Tworzenie ────────────────────────────────────────────────────────────────────────────────

-- Autor bieżącej zmiany: zalogowany albo właściciel reguły (`taskplanner.actor`, zmiany po wysyłce pluginu).
create function public.notification_actor() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.uid(), nullif(current_setting('taskplanner.actor', true), '')::uuid)
$$;

-- Nazwa autora dla odbiorcy: jego współpracownik z tym adresem, nazwa z profilu autora, e-mail.
create function public.notification_actor_name(p_user uuid, p_actor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select c.name from public.collaborators c
       join auth.users u on lower(u.email) = lower(btrim(c.email))
      where c.scope_id = p_user and u.id = p_actor and c.deleted_at is null
      order by c.created_at limit 1),
    (select nullif(btrim(p.display_name), '') from public.profiles p where p.id = p_actor),
    (select lower(u.email) from auth.users u where u.id = p_actor))
$$;

-- Nowe powiadomienie albo scalenie z nieprzeczytanym tej samej grupy z ostatnich 10 min.
create function public.notify(p_user uuid, p_kind text, p_actor uuid, p_data jsonb,
                              p_task uuid default null, p_workspace uuid default null, p_group text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  hlc text;
  payload jsonb;
begin
  if p_user is null or p_user is not distinct from p_actor
     or not exists (select 1 from public.sync_scopes s where s.id = p_user and s.kind = 'personal') then
    return;
  end if;
  hlc := public.server_hlc();
  payload := jsonb_strip_nulls(coalesce(p_data, '{}') || jsonb_build_object('actor', public.notification_actor_name(p_user, p_actor)));
  perform set_config('taskplanner.notify', 'on', true);
  if p_group is not null then
    update public.notifications n
       set data = n.data || payload || jsonb_build_object('count', coalesce((n.data ->> 'count')::int, 1) + 1),
           actor_id = p_actor,
           at = now(),
           field_clock = n.field_clock || jsonb_build_object('data', hlc, 'actor_id', hlc, 'at', hlc)
     where n.id = (select x.id from public.notifications x
                    where x.user_id = p_user and x.group_key = p_group and x.read_at is null and x.deleted_at is null
                      and x.at > now() - interval '10 minutes'
                    order by x.at desc limit 1);
    if found then
      perform set_config('taskplanner.notify', '', true);
      return;
    end if;
  end if;
  insert into public.notifications (id, scope_id, user_id, kind, task_id, workspace_id, actor_id, data, group_key, at, field_clock)
  values (gen_random_uuid(), p_user, p_user, p_kind, p_task, p_workspace, p_actor, payload, p_group, now(),
          (select jsonb_object_agg(c, hlc)
             from unnest(array['user_id', 'kind', 'task_id', 'workspace_id', 'actor_id', 'data', 'group_key', 'at']) c));
  perform set_config('taskplanner.notify', '', true);
end $$;

-- Powiadomienie o zadaniu: tylko dla członka, który je widzi, i tylko w przestrzeni z innymi członkami.
create function public.notify_task(p_user uuid, p_kind text, p_task public.tasks, p_actor uuid, p_data jsonb default '{}',
                                   p_group text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or p_task.deleted_at is not null or public.list_access(p_task.list_id, p_user) not in ('view', 'edit') then
    return;
  end if;
  perform public.notify(p_user, p_kind, p_actor,
                        jsonb_build_object('title', left(p_task.title, 200)) || coalesce(p_data, '{}'),
                        p_task.id, p_task.scope_id, p_group);
end $$;

-- Konto odpowiedzialne za zadanie: wskazana osoba (jej konto w przestrzeni) albo twórca, gdy nikt nie jest wskazany.
-- (Argumenty pojedynczo: funkcja z samym wierszem `tasks` byłaby w PostgREST „polem wyliczanym” tabeli.)
create function public.task_responsible_account(p_scope uuid, p_assignee uuid, p_creator uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case when p_assignee is null then p_creator else public.collaborator_account(p_scope, p_assignee) end
$$;

-- Czy w przestrzeni jest ktoś poza autorem (zakres osobisty i przestrzeń jednej osoby — nic do powiadamiania).
create function public.scope_has_others(p_scope uuid, p_actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.scope_members m where m.scope_id = p_scope and m.user_id <> p_actor)
$$;

-- Nazwa przestrzeni do migawki.
create function public.workspace_name(p_scope uuid) returns text
language sql stable security definer set search_path = '' as $$
  select w.name from public.workspaces w where w.id = p_scope
$$;

-- ── Wyzwalacze: zadania, komentarze, uczestnicy ──────────────────────────────────────────────

create function public.notify_task_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.notification_actor();
begin
  if actor is null or not public.scope_has_others(new.scope_id, actor) then
    return null;
  end if;
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform public.notify_task(public.collaborator_account(new.scope_id, new.assignee_id), 'assigned', new, actor);
  end if;
  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done' then
    perform public.notify_task(public.task_responsible_account(new.scope_id, new.assignee_id, new.created_by), 'completed', new, actor);
  end if;
  return null;
end $$;
create trigger z_notify after insert or update of assignee_id, status on public.tasks
  for each row execute function public.notify_task_change();

create function public.notify_task_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.notification_actor();
  task public.tasks;
  recipient uuid;
begin
  if new.deleted_at is not null or actor is null or not public.scope_has_others(new.scope_id, actor) then
    return null;
  end if;
  select * into task from public.tasks t where t.id = new.task_id;
  if task.id is null then
    return null;
  end if;
  for recipient in
    select distinct x.user_id from (
      select public.task_responsible_account(task.scope_id, task.assignee_id, task.created_by) as user_id
      union all select task.created_by
      union all select public.collaborator_account(task.scope_id, p.collaborator_id)
                  from public.task_participants p where p.task_id = task.id and p.deleted_at is null
    ) x where x.user_id is not null
  loop
    perform public.notify_task(recipient, 'comment', task, actor,
                               jsonb_build_object('excerpt', left(regexp_replace(btrim(new.body), '\s+', ' ', 'g'), 140)),
                               'comment:' || task.id);
  end loop;
  return null;
end $$;
create trigger z_notify after insert on public.task_comments for each row execute function public.notify_task_comment();

create function public.notify_task_participant() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.notification_actor();
  task public.tasks;
begin
  if new.deleted_at is not null or (tg_op = 'UPDATE' and old.deleted_at is null)
     or actor is null or not public.scope_has_others(new.scope_id, actor) then
    return null;
  end if;
  select * into task from public.tasks t where t.id = new.task_id;
  if task.id is not null then
    perform public.notify_task(public.collaborator_account(task.scope_id, new.collaborator_id), 'participant', task, actor);
  end if;
  return null;
end $$;
create trigger z_notify after insert or update of deleted_at on public.task_participants
  for each row execute function public.notify_task_participant();

-- ── Wyzwalacze: udostępnianie ────────────────────────────────────────────────────────────────

-- Zaproszenie (także ponowione) do adresu, który ma już konto; bez konta powiadomienie przyjdzie jako pasek po założeniu.
create function public.notify_scope_invite() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify(u.id, 'invite', new.invited_by,
                        jsonb_build_object('workspace', public.workspace_name(new.scope_id), 'role', new.role),
                        null, new.scope_id, 'invite:' || new.scope_id)
     from auth.users u where lower(u.email) = new.email;
  return null;
end $$;
create trigger z_notify after insert or update of token on public.scope_invites
  for each row execute function public.notify_scope_invite();

create function public.notify_owner_offer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify(new.user_id, 'owner_offer', new.offered_by,
                        jsonb_build_object('workspace', public.workspace_name(new.scope_id), 'after', new.after_role),
                        null, new.scope_id, 'owner_offer:' || new.scope_id);
  return null;
end $$;
create trigger z_notify after insert on public.scope_owner_offers for each row execute function public.notify_owner_offer();

create function public.notify_scope_member() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.notification_actor();
  v_scope uuid := coalesce(new.scope_id, old.scope_id);
  owner uuid;
  v_name text;
begin
  -- Usunięta przestrzeń (kaskada) i zakres osobisty — bez powiadomień.
  if not exists (select 1 from public.sync_scopes s where s.id = v_scope and s.kind = 'workspace') then
    return null;
  end if;
  v_name := public.workspace_name(v_scope);
  if tg_op = 'INSERT' then
    for owner in select m.user_id from public.scope_members m
                  where m.scope_id = new.scope_id and m.role = 'owner' and m.user_id <> new.user_id loop
      perform public.notify(owner, 'member_joined', new.user_id, jsonb_build_object('workspace', v_name, 'role', new.role),
                            null, new.scope_id);
    end loop;
  elsif tg_op = 'DELETE' then
    for owner in select m.user_id from public.scope_members m
                  where m.scope_id = old.scope_id and m.role = 'owner' and m.user_id <> old.user_id loop
      if owner is distinct from actor then
        perform public.notify(owner, 'member_left', old.user_id, jsonb_build_object('workspace', v_name), null, old.scope_id);
      end if;
    end loop;
    if actor is not null and actor <> old.user_id then
      perform public.notify(old.user_id, 'member_removed', actor, jsonb_build_object('workspace', v_name), null, old.scope_id);
    end if;
  elsif new.role is distinct from old.role and actor is not null then
    perform public.notify(new.user_id, 'role_changed', actor, jsonb_build_object('workspace', v_name, 'role', new.role),
                          null, new.scope_id, 'role:' || new.scope_id);
  end if;
  return null;
end $$;
create trigger z_notify after insert or delete or update of role on public.scope_members
  for each row execute function public.notify_scope_member();

revoke execute on function public.stamp_notification(), public.notification_actor(), public.notification_actor_name(uuid, uuid),
  public.notify(uuid, text, uuid, jsonb, uuid, uuid, text), public.notify_task(uuid, text, public.tasks, uuid, jsonb, text),
  public.task_responsible_account(uuid, uuid, uuid), public.scope_has_others(uuid, uuid), public.workspace_name(uuid),
  public.notify_task_change(), public.notify_task_comment(), public.notify_task_participant(), public.notify_scope_invite(),
  public.notify_owner_offer(), public.notify_scope_member() from anon, authenticated, public;

-- ── Retencja ─────────────────────────────────────────────────────────────────────────────────

-- Po 90 dniach powiadomienie znika z list (miękko, żeby urządzenia dostały zmianę), po kolejnych 30 — z bazy.
select cron.schedule('taskplanner-notifications-retention', '47 3 * * *', $$
  update public.notifications set deleted_at = now() where deleted_at is null and at < now() - interval '90 days';
  delete from public.notifications where deleted_at < now() - interval '30 days';
$$);
