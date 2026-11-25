-- Własne przypomnienia przy dostępie „Podgląd” (v1.x): osoba z rolą `viewer` albo gość listy tylko do podglądu
-- może ustawić, zmienić i usunąć swoje przypomnienie (`reminders`, `created_by` = ona) zadania, którego jest
-- uczestnikiem albo za które odpowiada (wskazana osoba; bez niej — twórca). Konto osoby: `scope_collaborators.user_id`.
-- Gdy przestanie nim być, własne przypomnienie może już tylko usunąć. Cudze przypomnienia i cała reszta
-- przestrzeni zostają tylko do odczytu; lista ukryta nie daje nic.

create function public.can_set_own_reminder(p_task uuid, p_removing boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and public.list_access(t.list_id) = 'view'
       and (p_removing or (t.deleted_at is null and (
             (t.assignee_id is null and t.created_by = auth.uid())
             or exists (
               select 1 from public.scope_collaborators sc
                where sc.scope_id = t.scope_id and sc.user_id = auth.uid() and sc.deleted_at is null
                  and (sc.collaborator_id = t.assignee_id
                       or exists (select 1 from public.task_participants p
                                   where p.task_id = t.id and p.collaborator_id = sc.collaborator_id and p.deleted_at is null)))))))
$$;
revoke execute on function public.can_set_own_reminder(uuid, boolean) from anon, authenticated, public;

-- Jak w `*_v1x_list_guest_access.sql`, z wyjątkiem dla własnych przypomnień.
create or replace function public.stamp_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  role text;
  own_reminder boolean := false;
begin
  -- Zapis w imieniu użytkownika (nie `service_role`): tylko do zakresów, w których może pisać.
  if auth.uid() is not null then
    if tg_table_name = 'reminders' then
      if tg_op = 'INSERT' then
        own_reminder := coalesce(new.created_by, auth.uid()) = auth.uid() and public.can_set_own_reminder(new.task_id);
      else
        own_reminder := old.created_by = auth.uid() and new.created_by = auth.uid() and old.task_id = new.task_id and old.scope_id = new.scope_id
          and public.can_set_own_reminder(new.task_id, new.deleted_at is not null);
      end if;
    end if;
    if own_reminder is not true then
      if not public.can_write_scope(new.scope_id)
         or (tg_op = 'UPDATE' and old.scope_id <> new.scope_id and not public.can_write_scope(old.scope_id)) then
        raise exception using errcode = 'TP003', message = 'Brak dostępu do zakresu';
      end if;
      -- Gość (edytor) przestrzeni: tylko listy z `edit` — przed i po zmianie.
      role := public.scope_role(new.scope_id);
      if role is distinct from 'owner' then
        if tg_table_name = 'lists' then
          if new.guest_access <> 'edit' or (tg_op = 'UPDATE' and old.guest_access <> 'edit') then
            raise exception using errcode = 'TP003', message = 'Lista tylko do podglądu';
          end if;
        elsif exists (select 1 from unnest(public.row_lists(tg_table_name, to_jsonb(new))) x(id) where public.list_access(x.id) is distinct from 'edit')
           or (tg_op = 'UPDATE' and exists (
                 select 1 from unnest(public.row_lists(tg_table_name, to_jsonb(old))) x(id)
                  where public.list_access(x.id) is distinct from 'edit')) then
          raise exception using errcode = 'TP003', message = 'Lista tylko do podglądu';
        end if;
      end if;
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
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end $$;

-- Jak w `*_v1x_list_guest_access.sql`: własne przypomnienie przechodzi wstępną kontrolę zakresu, dalej decyduje `stamp_row`.
create or replace function public.push_changes(p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  op jsonb;
  tbl text;
  rid uuid;
  data jsonb;
  hlc text;
  cols text[];
  win text[];
  clock jsonb;
  row_scope uuid;
  inserted int;
  writable jsonb := '{}';
  t text;
  max_wall bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint + 300000;
  applied int := 0;
  rejected jsonb := '[]';
  clamped jsonb := '[]';
  touched jsonb := '[]';
  current_rows jsonb := '[]';
  row_data jsonb;
  item jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  foreach t in array public.synced_tables() loop
    writable := writable || jsonb_build_object(t, to_jsonb(public.writable_columns(t)));
  end loop;

  for op in select value from jsonb_array_elements(p_ops) loop
    tbl := op ->> 'table';
    data := coalesce(op -> 'set', '{}');
    hlc := op ->> 'hlc';
    begin
      rid := (op ->> 'id')::uuid;
      if writable -> tbl is null then
        raise exception using errcode = 'TP005', message = 'Nieznana tabela ' || coalesce(tbl, 'null');
      end if;
      if hlc is null or hlc !~ '^[0-9]{15}:[0-9]{5}:[A-Za-z0-9_-]{1,64}$' then
        raise exception using errcode = 'TP006', message = 'Niepoprawny HLC';
      end if;
      if left(hlc, 15)::bigint > max_wall then
        hlc := public.server_hlc();
        clamped := clamped || jsonb_build_array(op -> 'op');
        touched := touched || jsonb_build_array(jsonb_build_object('table', tbl, 'id', rid));
      end if;
      select coalesce(array_agg(k), '{}') into cols from jsonb_object_keys(data) k;
      if exists (select 1 from unnest(cols) c where not (writable -> tbl) ? c) then
        raise exception using errcode = 'TP005', message = 'Niedozwolone pole w ' || tbl;
      end if;

      execute format('select field_clock, scope_id from public.%I where id = $1 for update', tbl) into clock, row_scope using rid;
      if clock is null then
        execute format(
          'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (id) do nothing',
          tbl, (select string_agg(quote_ident(c), ', ') from unnest(cols || array['id', 'field_clock']) c))
        using data || jsonb_build_object(
          'id', rid,
          'field_clock', (select coalesce(jsonb_object_agg(c, hlc), '{}') from unnest(cols) c));
        get diagnostics inserted = row_count;
        if inserted = 0 then
          -- Ktoś wstawił ten sam id równolegle: dalej jak zwykła zmiana.
          execute format('select field_clock, scope_id from public.%I where id = $1 for update', tbl) into clock, row_scope using rid;
        end if;
      end if;
      -- Także wtedy, gdy żadne pole nie wygra LWW: obcy zapis ma być odrzucony, a nie „przyjęty bez zmian”.
      if clock is not null and not public.can_write_scope(row_scope)
         and not (tbl = 'reminders' and exists (select 1 from public.reminders r where r.id = rid and r.created_by = auth.uid())) then
        raise exception using errcode = 'TP003', message = 'Brak dostępu do zakresu';
      end if;
      if clock is not null then
        select array_agg(c) into win from unnest(cols) c
         where hlc collate "C" > coalesce(clock ->> c, '') collate "C";
        if win is not null then
          execute format(
            'update public.%1$I set (%2$s, field_clock) = (select %2$s, $2 from jsonb_populate_record(null::public.%1$I, $1)) where id = $3',
            tbl, (select string_agg(quote_ident(c), ', ') from unnest(win) c))
          using data, clock || (select jsonb_object_agg(c, hlc) from unnest(win) c), rid;
        end if;
      end if;
      applied := applied + 1;
    exception when others then
      rejected := rejected || jsonb_build_array(jsonb_build_object('op', op -> 'op', 'code', sqlstate, 'message', sqlerrm));
      if tbl = any(public.synced_tables()) and rid is not null then
        touched := touched || jsonb_build_array(jsonb_build_object('table', tbl, 'id', rid));
      end if;
    end;
  end loop;

  -- Wiersz z ukrytej listy wraca jako `null` — klient usuwa swoją kopię.
  for item in select distinct value from jsonb_array_elements(touched) loop
    execute format('select to_jsonb(r) from public.%I r where r.id = $1 and public.has_scope_access(r.scope_id)', item ->> 'table')
      into row_data using (item ->> 'id')::uuid;
    if row_data is not null and not public.row_visible(item ->> 'table', row_data) then
      row_data := null;
    end if;
    current_rows := current_rows || jsonb_build_array(item || jsonb_build_object('row', row_data));
  end loop;

  return jsonb_build_object(
    'applied', applied,
    'rejected', rejected,
    'clamped', clamped,
    'rows', current_rows,
    'serverHlc', public.server_hlc());
end $$;
