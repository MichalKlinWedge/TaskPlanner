-- Centrum powiadomień, etap N3 (PLAN_ETAPOWY.md → „Centrum powiadomień (web)”). Migracja addytywna.
--
-- Nowe rodzaje (`kind`, teksty w `packages/core/src/notifications.ts`):
--   due_changed      ktoś inny zmienił termin zadania, za które odpowiadam (bez serii, bez ukończonych / anulowanych;
--                    kilka zmian w 10 min = jeden wiersz z pierwotnym terminem w `before`)
--   delivery_failed  wysyłka integracji ostatecznie nieudana (`dead` po ponowieniach albo `failed` bez wyłączenia
--                    połączenia — 401/403/410 daje `connection_error`); seria z jednego połączenia = jeden wiersz
--   connection_error połączenie integracji wyłączone po odmowie usługi (`active` → `error`)
--   calendar_error   konto kalendarza przestało się synchronizować (`active` → `error` / `revoked`)
--   ai_error         działający klucz AI został odrzucony (`active` → `error`; nowy zły klucz przy „Sprawdź” widać od razu)
--   storage_quota    załączniki konta zajmują ≥ 90 % / 100 % limitu (raz na 30 dni na próg)
-- Zdarzenia systemowe nie mają autora (`actor_id` null) ani zadania (`task_id` null — wysyłka może dotyczyć zadania
-- z listy, której odbiorca już nie widzi; tytuł tylko gdy widzi). Nowe pola `data`: `label` (nazwa połączenia /
-- konta), `plugin`, `due` / `time` / `before` / `beforeTime` (puste = brak; pusty tekst, bo `notify` usuwa null
-- i przy scalaniu zostałaby stara wartość), `revoked`, `percent`.

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'assigned', 'comment', 'participant', 'completed', 'invite', 'owner_offer', 'member_joined', 'member_left',
  'member_removed', 'role_changed', 'due_changed', 'delivery_failed', 'connection_error', 'calendar_error', 'ai_error',
  'storage_quota'));

-- ── Termin zmieniony przez innych ────────────────────────────────────────────────────────────

create function public.notify_task_due() returns trigger
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
  recipient := public.task_responsible_account(new.scope_id, new.assignee_id, new.created_by);
  if recipient is null or recipient = actor then
    return null;
  end if;
  -- Scalenie z nieprzeczytanym z ostatnich 10 min: „przed” zostaje z pierwszej zmiany.
  select x.data into prev from public.notifications x
   where x.user_id = recipient and x.group_key = grp and x.read_at is null and x.deleted_at is null
     and x.at > now() - interval '10 minutes'
   order by x.at desc limit 1;
  perform public.notify_task(recipient, 'due_changed', new, actor, jsonb_build_object(
    'due', coalesce(new.due_date::text, ''),
    'time', coalesce(new.due_time::text, ''),
    'before', coalesce(prev ->> 'before', old.due_date::text, ''),
    'beforeTime', coalesce(prev ->> 'beforeTime', old.due_time::text, '')), grp);
  return null;
end $$;
create trigger z_notify_due after update of due_date, due_time on public.tasks
  for each row execute function public.notify_task_due();

-- ── Integracje ───────────────────────────────────────────────────────────────────────────────

create function public.notify_plugin_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  conn record;
  task public.tasks;
begin
  if new.status is not distinct from old.status
     or not (new.status = 'dead' or (new.status = 'failed' and coalesce(new.http_status, 0) not in (401, 403, 410))) then
    return null;
  end if;
  select c.label, c.plugin into conn from public.plugin_connections c where c.id = new.connection_id;
  select * into task from public.tasks t where t.id = new.task_id;
  perform public.notify(new.user_id, 'delivery_failed', null, jsonb_build_object(
    'label', conn.label,
    'plugin', conn.plugin,
    'title', case when task.id is not null and task.deleted_at is null
                       and public.list_access(task.list_id, new.user_id) in ('view', 'edit') then left(task.title, 200) end,
    'excerpt', left(regexp_replace(btrim(coalesce(new.error, '')), '\s+', ' ', 'g'), 140)),
    null, null, 'delivery:' || coalesce(new.connection_id::text, '-'));
  return null;
end $$;
create trigger z_notify after update of status on public.plugin_deliveries
  for each row execute function public.notify_plugin_delivery();

create function public.notify_plugin_connection() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'error' and old.status = 'active' and new.deleted_at is null then
    perform public.notify(new.user_id, 'connection_error', null, jsonb_build_object(
      'label', new.label, 'plugin', new.plugin, 'excerpt', left(coalesce(new.last_error, ''), 140)),
      null, null, 'connection:' || new.id);
  end if;
  return null;
end $$;
create trigger z_notify after update of status on public.plugin_connections
  for each row execute function public.notify_plugin_connection();

-- ── Kalendarz i AI ───────────────────────────────────────────────────────────────────────────

create function public.notify_calendar_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('error', 'revoked') and old.status = 'active' then
    perform public.notify(new.user_id, 'calendar_error', null, jsonb_build_object(
      'label', new.label, 'revoked', new.status = 'revoked', 'excerpt', left(coalesce(new.last_error, ''), 140)),
      null, null, 'calendar:' || new.id);
  end if;
  return null;
end $$;
create trigger z_notify after update of status on public.calendar_accounts
  for each row execute function public.notify_calendar_account();

create function public.notify_ai_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'error' and old.status = 'active' and new.deleted_at is null then
    perform public.notify(new.user_id, 'ai_error', null, jsonb_build_object(
      'label', case new.provider when 'gemini' then 'Gemini' else new.provider end,
      'excerpt', left(coalesce(new.last_error, ''), 140)),
      null, null, 'ai:' || new.id);
  end if;
  return null;
end $$;
create trigger z_notify after update of status on public.ai_accounts
  for each row execute function public.notify_ai_account();

-- ── Miejsce na załączniki ────────────────────────────────────────────────────────────────────

-- Po zapisaniu wiersza pliku (plik jest już w Storage): zajęte miejsce folderu autora wobec limitu. Bez porównania
-- „przed / po” (kilka plików wysłanych przed synchronizacją wierszy) — próg zgłaszany najwyżej raz na 30 dni.
create function public.notify_attachment_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  used bigint;
  quota bigint := public.attachment_quota_bytes();
  level int;
begin
  if new.kind <> 'file' or new.created_by is null or new.deleted_at is not null then
    return null;
  end if;
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0) into used
    from storage.objects o
   where o.bucket_id = 'attachments' and (storage.foldername(o.name))[1] = new.created_by::text;
  level := case when used >= quota then 100 when used * 10 >= quota * 9 then 90 end;
  if level is null or exists (
    select 1 from public.notifications n
     where n.user_id = new.created_by and n.kind = 'storage_quota' and (n.data ->> 'percent')::int >= level
       and n.at > now() - interval '30 days') then
    return null;
  end if;
  perform public.notify(new.created_by, 'storage_quota', null,
                        jsonb_build_object('percent', level, 'used', used, 'quota', quota), null, null, null);
  return null;
end $$;
create trigger z_notify_quota after insert on public.attachments
  for each row execute function public.notify_attachment_quota();

revoke execute on function public.notify_task_due(), public.notify_plugin_delivery(), public.notify_plugin_connection(),
  public.notify_calendar_account(), public.notify_ai_account(), public.notify_attachment_quota() from anon, authenticated, public;
