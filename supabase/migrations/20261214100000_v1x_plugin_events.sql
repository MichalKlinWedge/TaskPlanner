-- Integracje wychodzące, etap I2: wyzwalacze zdarzeń (SPECYFIKACJA M21; PLAN_ETAPOWY.md → v1.x).
--
-- Zmiana zadania, jego tagów, ukończenie wystąpienia serii i nowy komentarz trafiają do `plugin_outbox`
-- (rzut zadania przed i po zmianie — `plugin_task_state`, ten sam kształt co `PluginTaskState` w
-- `core/plugins/events.ts`) — **tylko gdy któryś członek przestrzeni ma włączoną regułę zdarzeniową**; inaczej
-- wyzwalacz kończy się na jednym zapytaniu po indeksie. Zdarzenia liczy i łączy Edge Function `plugins`
-- (`core/plugins/dispatch.ts`): wysyłka z opóźnieniem reguły, zdarzenia tego samego zadania i reguły z okna
-- w jednej wysyłce, warunek sprawdzany ponownie tuż przed wysyłką (stan z `plugin_deliveries.context`).
-- Migracja wyłącznie dodaje (dane produkcyjne od 20.11.2026).

alter table public.plugin_outbox add column extra jsonb;
comment on column public.plugin_outbox.extra is 'Dodatek zdarzenia: {completion: {id, occurrence}} albo {comment: {id}}';
alter table public.plugin_deliveries add column context jsonb;
comment on column public.plugin_deliveries.context is 'Wysyłka zdarzeniowa: {baseline, completions, comments} — EventContext w core/plugins/dispatch.ts';

-- Wysyłki zdarzeniowe czekające na koniec okna (łączenie kolejnych zdarzeń tego samego zadania i reguły).
create index plugin_deliveries_window on public.plugin_deliveries (rule_id, task_id) where status = 'pending' and attempts = 0 and source = 'event';
-- Właściciele włączonych reguł zdarzeniowych (sprawdzane przy każdej zmianie zadania).
create index plugin_rules_event_owner on public.plugin_rules (scope_id) where enabled and deleted_at is null and (trigger ->> 'kind') = 'event';

-- ── Rzut zadania ─────────────────────────────────────────────────────────────────────────────

create function public.plugin_task_tag_ids(p_task uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(tt.tag_id order by tt.tag_id), '{}')
    from public.task_tags tt
   where tt.task_id = p_task and tt.deleted_at is null;
$$;

create function public.plugin_task_state(p_task public.tasks, p_tags uuid[]) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'status', p_task.status, 'deletedAt', p_task.deleted_at, 'listId', p_task.list_id, 'workspaceId', p_task.scope_id,
    'tagIds', to_jsonb(coalesce(p_tags, '{}'::uuid[])), 'dueDate', p_task.due_date, 'dueTime', p_task.due_time,
    'assigneeId', p_task.assignee_id, 'priority', p_task.priority);
$$;

-- Bieżący rzut zadania (Edge Function: ponowne sprawdzenie przed wysyłką) albo `null`.
create function public.plugin_task_state_now(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.plugin_task_state(t, public.plugin_task_tag_ids(t.id)) from public.tasks t where t.id = p_task;
$$;

-- Czy ktoś z przestrzeni ma włączoną regułę zdarzeniową (bez niej wyzwalacze nic nie zapisują).
create function public.plugin_events_wanted(p_scope uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.scope_members m
      join public.plugin_rules r on r.scope_id = m.user_id
     where m.scope_id = p_scope and r.enabled and r.deleted_at is null and (r.trigger ->> 'kind') = 'event');
$$;

create function public.plugin_origin() returns text
language sql stable set search_path = '' as $$
  select case when coalesce(current_setting('taskplanner.source', true), '') <> '' then 'integration' else 'client' end;
$$;

-- ── Wyzwalacze ───────────────────────────────────────────────────────────────────────────────

-- `tasks`: nowe zadanie albo zmiana pól, od których zależą zdarzenia i filtry (inne zmiany — nic). Nawyki pomijane.
create function public.plugin_task_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tags uuid[];
  v_before jsonb;
  v_after jsonb;
begin
  if new.kind <> 'task' or not public.plugin_events_wanted(new.scope_id) then
    return null;
  end if;
  v_tags := public.plugin_task_tag_ids(new.id);
  v_after := public.plugin_task_state(new, v_tags);
  if tg_op = 'UPDATE' then
    v_before := public.plugin_task_state(old, v_tags);
    if v_before = v_after then
      return null;
    end if;
  end if;
  insert into public.plugin_outbox (scope_id, table_name, row_id, task_id, before, after, origin)
  values (new.scope_id, 'tasks', new.id, new.id, v_before, v_after, public.plugin_origin());
  perform public.plugin_kick();
  return null;
end $$;
create trigger plugin_events after insert or update on public.tasks for each row execute function public.plugin_task_changed();

-- `task_tags`: tag dodany (także przywrócony) albo zdjęty — stan przed = bieżące tagi bez / z tym tagiem.
create function public.plugin_task_tag_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks;
  v_tags uuid[];
  v_before uuid[];
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is not null then
      return null;
    end if;
  elsif (old.deleted_at is null) = (new.deleted_at is null) then
    return null;
  end if;
  select * into v_task from public.tasks where id = new.task_id;
  if not found or v_task.kind <> 'task' or not public.plugin_events_wanted(v_task.scope_id) then
    return null;
  end if;
  v_tags := public.plugin_task_tag_ids(new.task_id);
  if new.deleted_at is null then
    v_before := array(select x from unnest(v_tags) x where x <> new.tag_id order by x);
  else
    v_before := array(select distinct x from unnest(v_tags || new.tag_id) x order by x);
  end if;
  insert into public.plugin_outbox (scope_id, table_name, row_id, task_id, before, after, origin)
  values (v_task.scope_id, 'task_tags', new.id, new.task_id,
          public.plugin_task_state(v_task, v_before), public.plugin_task_state(v_task, v_tags), public.plugin_origin());
  perform public.plugin_kick();
  return null;
end $$;
create trigger plugin_events after insert or update on public.task_tags for each row execute function public.plugin_task_tag_changed();

-- Wspólne dla ukończenia wystąpienia serii i komentarza: stan bez zmiany + dodatek.
create function public.plugin_task_extra(p_task uuid, p_table text, p_row uuid, p_extra jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks;
  v_state jsonb;
begin
  select * into v_task from public.tasks where id = p_task;
  if not found or v_task.kind <> 'task' or v_task.deleted_at is not null or not public.plugin_events_wanted(v_task.scope_id) then
    return;
  end if;
  v_state := public.plugin_task_state(v_task, public.plugin_task_tag_ids(p_task));
  insert into public.plugin_outbox (scope_id, table_name, row_id, task_id, before, after, extra, origin)
  values (v_task.scope_id, p_table, p_row, p_task, v_state, v_state, p_extra, public.plugin_origin());
  perform public.plugin_kick();
end $$;

-- `task_completions`: ukończenie wystąpienia serii (status serii się nie zmienia). Wpis ma stały id
-- (UUIDv5 z zadania i dnia), więc ponowne ukończenie po „Cofnij” to zmiana `deleted_at`, nie nowy wiersz.
create function public.plugin_completion_added() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind <> 'done' or new.deleted_at is not null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null and old.kind = 'done' then
    return null;
  end if;
  perform public.plugin_task_extra(new.task_id, 'task_completions', new.id,
    jsonb_build_object('completion', jsonb_build_object('id', new.id, 'occurrence', new.occurrence_date)));
  return null;
end $$;
create trigger plugin_events after insert or update on public.task_completions for each row execute function public.plugin_completion_added();

create function public.plugin_comment_added() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is null then
    perform public.plugin_task_extra(new.task_id, 'task_comments', new.id, jsonb_build_object('comment', jsonb_build_object('id', new.id)));
  end if;
  return null;
end $$;
create trigger plugin_events after insert on public.task_comments for each row execute function public.plugin_comment_added();

-- ── Edge Function `plugins` ──────────────────────────────────────────────────────────────────

-- Włączone reguły zdarzeniowe osób, które widzą zadanie (członkowie przestrzeni, lista nie ukryta).
create function public.plugin_event_rules(p_task uuid) returns setof public.plugin_rules
language sql stable security definer set search_path = '' as $$
  select r.*
    from public.tasks t
    join public.scope_members m on m.scope_id = t.scope_id
    join public.plugin_rules r on r.scope_id = m.user_id
   where t.id = p_task
     and r.enabled and r.deleted_at is null and (r.trigger ->> 'kind') = 'event'
     and public.list_access(t.list_id, m.user_id) is distinct from 'hidden';
$$;

revoke execute on function
  public.plugin_task_tag_ids(uuid), public.plugin_task_state(public.tasks, uuid[]), public.plugin_task_state_now(uuid),
  public.plugin_events_wanted(uuid), public.plugin_origin(), public.plugin_task_changed(), public.plugin_task_tag_changed(),
  public.plugin_task_extra(uuid, text, uuid, jsonb), public.plugin_completion_added(), public.plugin_comment_added(),
  public.plugin_event_rules(uuid)
  from public, anon, authenticated;
grant execute on function public.plugin_task_state_now(uuid), public.plugin_event_rules(uuid) to service_role;
