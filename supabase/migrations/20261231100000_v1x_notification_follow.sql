-- Centrum powiadomień: więcej ustawień (PLAN_ETAPOWY.md → „Centrum powiadomień (web)”). Migracja addytywna:
-- nowe funkcje, zastąpione dwie funkcje wyzwalaczy, stara RPC `assignee_reminder_tasks` zostaje (starsze wdrożenie
-- `reminders-push`).
--
-- Ustawienia konta w `profiles.settings.notifications` (core `NotificationPrefs`, brak pola = dotychczasowe zachowanie):
--   follow.created        twórca zadania dostaje też ukończenie i zmianę terminu (oraz automatyczne przypomnienie),
--                         gdy zadanie jest przypisane komuś innemu
--   follow.participating  to samo dla uczestnika zadania (komentarze uczestnicy dostawali już wcześniej)
--   autoReminder          automatyczne przypomnienie o zadaniu z datą i godziną: `shared` (odpowiedzialny we wspólnych
--                         przestrzeniach — jak dotąd), `all` (także w przestrzeniach jednej osoby), `off`
--   autoReminderOffset    minuty przed terminem — liczy je `reminders-push` / aplikacje, nie baza
--   muted                 wyciszone rodzaje — tylko po stronie klienta (wiersze powstają jak dotąd)

-- Wartość ustawienia powiadomień konta (tekst z `#>>`; null = brak).
create function public.notification_pref(p_user uuid, p_path text[]) returns text
language sql stable security definer set search_path = '' as $$
  select p.settings -> 'notifications' #>> p_path from public.profiles p where p.id = p_user
$$;

-- Konta śledzące zadanie poza odpowiedzialnym: twórca (`follow.created`) i uczestnicy z kontem w przestrzeni
-- (`follow.participating`). Argumenty pojedynczo — funkcja z wierszem `tasks` byłaby w PostgREST polem wyliczanym.
create function public.task_followers(p_task uuid, p_scope uuid, p_creator uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p_creator where p_creator is not null and public.notification_pref(p_creator, '{follow,created}') = 'true'
  union
  select a.user_id
    from (select public.collaborator_account(p_scope, tp.collaborator_id) as user_id
            from public.task_participants tp where tp.task_id = p_task and tp.deleted_at is null) a
   where a.user_id is not null and public.notification_pref(a.user_id, '{follow,participating}') = 'true'
$$;

-- ── Ukończenie: odpowiedzialny + śledzący ────────────────────────────────────────────────────

create or replace function public.notify_task_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.notification_actor();
  recipient uuid;
begin
  if actor is null or not public.scope_has_others(new.scope_id, actor) then
    return null;
  end if;
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform public.notify_task(public.collaborator_account(new.scope_id, new.assignee_id), 'assigned', new, actor);
  end if;
  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done' then
    for recipient in
      select distinct r.user_id from (
        select public.task_responsible_account(new.scope_id, new.assignee_id, new.created_by) as user_id
        union all select f.f from public.task_followers(new.id, new.scope_id, new.created_by) f(f)
      ) r where r.user_id is not null
    loop
      perform public.notify_task(recipient, 'completed', new, actor);
    end loop;
  end if;
  return null;
end $$;

-- ── Zmiana terminu: odpowiedzialny + śledzący ────────────────────────────────────────────────

create or replace function public.notify_task_due() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.notification_actor();
  recipient uuid;
  grp text := 'due:' || new.id;
  prev jsonb;
begin
  if actor is null or new.deleted_at is not null or new.recurrence is not null or new.status in ('done', 'cancelled')
     or (new.due_date is not distinct from old.due_date and new.due_time is not distinct from old.due_time)
     or not public.scope_has_others(new.scope_id, actor) then
    return null;
  end if;
  for recipient in
    select distinct r.user_id from (
      select public.task_responsible_account(new.scope_id, new.assignee_id, new.created_by) as user_id
      union all select f.f from public.task_followers(new.id, new.scope_id, new.created_by) f(f)
    ) r where r.user_id is not null and r.user_id <> actor
  loop
    -- Scalenie z nieprzeczytanym z ostatnich 10 min: „przed” zostaje z pierwszej zmiany.
    prev := null;
    select x.data into prev from public.notifications x
     where x.user_id = recipient and x.group_key = grp and x.read_at is null and x.deleted_at is null
       and x.at > now() - interval '10 minutes'
     order by x.at desc limit 1;
    perform public.notify_task(recipient, 'due_changed', new, actor, jsonb_build_object(
      'due', coalesce(new.due_date::text, ''),
      'time', coalesce(new.due_time::text, ''),
      'before', coalesce(prev ->> 'before', old.due_date::text, ''),
      'beforeTime', coalesce(prev ->> 'beforeTime', old.due_time::text, '')), grp);
  end loop;
  return null;
end $$;

-- ── Automatyczne przypomnienia według ustawień (dla `reminders-push`) ────────────────────────
-- Jak core `assigneeReminderRules`: zadanie zwykłe, otwarte, z datą i godziną; konto odpowiedzialne, twórca
-- (`follow.created`) albo uczestnik (`follow.participating`); `shared` — tylko w przestrzeniach z innymi członkami,
-- `all` — wszędzie, `off` — nic. Członkostwo i listy ukryte przed gośćmi jak w `assignee_reminder_tasks`.

create function public.auto_reminder_tasks(p_users uuid[], p_from date, p_to date)
returns table (user_id uuid, id uuid, kind text, status text, title text, due_date date, due_time text, recurrence jsonb, time_zone text)
language sql stable security definer set search_path = '' as $$
  with prefs as (
    select u.id as user_id,
           case when p.settings -> 'notifications' ->> 'autoReminder' in ('off', 'all')
                then p.settings -> 'notifications' ->> 'autoReminder' else 'shared' end as mode,
           coalesce(p.settings -> 'notifications' -> 'follow' ->> 'created', '') = 'true' as created,
           coalesce(p.settings -> 'notifications' -> 'follow' ->> 'participating', '') = 'true' as participating
      from unnest(p_users) u(id)
      left join public.profiles p on p.id = u.id
  ),
  due as (
    select t.id, t.scope_id, t.list_id, t.assignee_id, t.created_by, l.guest_access
      from public.tasks t
      join public.sync_scopes s on s.id = t.scope_id and s.kind = 'workspace'
      join public.lists l on l.id = t.list_id and l.deleted_at is null and l.archived_at is null
     where t.deleted_at is null
       and t.kind::text = 'task'
       and t.status::text not in ('done', 'cancelled')
       and t.due_time is not null
       and t.due_date <= p_to
       and (t.due_date >= p_from or t.recurrence is not null)
  ),
  candidates as (
    select case when d.assignee_id is null then d.created_by
                else (select sc.user_id from public.scope_collaborators sc
                       where sc.scope_id = d.scope_id and sc.collaborator_id = d.assignee_id and sc.deleted_at is null)
           end as user_id, d.id, 'responsible' as reason
      from due d
    union all
    select d.created_by, d.id, 'created' from due d
    union all
    select sc.user_id, d.id, 'participating'
      from due d
      join public.task_participants tp on tp.task_id = d.id and tp.deleted_at is null
      join public.scope_collaborators sc on sc.scope_id = d.scope_id and sc.collaborator_id = tp.collaborator_id and sc.deleted_at is null
  ),
  picked as (
    select distinct c.user_id, c.id
      from candidates c
      join prefs p on p.user_id = c.user_id
      join due d on d.id = c.id
      join public.scope_members m on m.scope_id = d.scope_id and m.user_id = c.user_id
     where p.mode <> 'off'
       and (c.reason = 'responsible' or (c.reason = 'created' and p.created) or (c.reason = 'participating' and p.participating))
       and (m.role = 'owner' or d.guest_access <> 'hidden')
       and (p.mode = 'all' or exists (select 1 from public.scope_members o where o.scope_id = d.scope_id and o.user_id <> c.user_id))
  )
  select k.user_id, t.id, t.kind::text, t.status::text, t.title, t.due_date, t.due_time, t.recurrence, t.time_zone
    from picked k
    join public.tasks t on t.id = k.id
   order by t.due_date desc, t.id, k.user_id
$$;

revoke execute on function public.notification_pref(uuid, text[]), public.task_followers(uuid, uuid, uuid),
  public.auto_reminder_tasks(uuid[], date, date) from anon, authenticated, public;
grant execute on function public.auto_reminder_tasks(uuid[], date, date) to service_role;
