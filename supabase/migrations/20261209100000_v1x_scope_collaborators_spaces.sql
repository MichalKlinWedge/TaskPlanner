-- Współpracownicy przypisani do przestrzeni (v1.x): kopia w `scope_collaborators` (migracja
-- `*_v1x_scope_collaborators.sql`) powstaje także wtedy, gdy członek przestrzeni wskaże ją wprost
-- w „Widoczny w” współpracownika (`collaborators.workspace_ids`), nie tylko po użyciu w zadaniu —
-- pozostali członkowie widzą go na liście współpracowników i mogą go wskazać.
--
--   * Tylko przestrzenie z listy wprost (`workspace_ids` = `null` „wszystkie” nie rozsyła książki
--     adresowej) i tylko te, do których właściciel wpisu należy.
--   * Przestrzeń zdjęta z listy: kopia dostaje `deleted_at`, chyba że osoba jest tam nadal
--     odpowiedzialna albo uczestnikiem zadania.

-- Osoba użyta w zadaniach przestrzeni (odpowiedzialny albo uczestnik).
create function public.collaborator_used_in(p_scope uuid, p_collaborator uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t where t.scope_id = p_scope and t.assignee_id = p_collaborator and t.deleted_at is null)
      or exists (select 1 from public.task_participants p where p.scope_id = p_scope and p.collaborator_id = p_collaborator and p.deleted_at is null);
$$;

-- Kopie wg `workspace_ids`: dodane w przestrzeniach z listy, zdjęte z pozostałych (gdy nieużywane).
create function public.sync_collaborator_spaces(p_collaborator uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.collaborators;
  w uuid;
begin
  select * into c from public.collaborators where id = p_collaborator;
  if c.id is null then
    return;
  end if;
  if c.deleted_at is null and jsonb_typeof(c.workspace_ids) = 'array' then
    for w in
      select x::uuid from jsonb_array_elements_text(c.workspace_ids) x
       where exists (select 1 from public.scope_members m where m.scope_id = x::uuid and m.user_id = c.scope_id)
    loop
      perform public.mirror_collaborator(w, c.id);
    end loop;
  end if;
  update public.scope_collaborators sc
     set deleted_at = now()
   where sc.collaborator_id = c.id
     and sc.deleted_at is null
     and not coalesce(jsonb_typeof(c.workspace_ids) = 'array' and c.workspace_ids ? sc.scope_id::text, false)
     and not public.collaborator_used_in(sc.scope_id, c.id);
end $$;

-- Zmiana współpracownika: pola we wszystkich kopiach, potem przestrzenie z `workspace_ids`.
create or replace function public.mirror_collaborator_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and (new.name, new.acronym, new.archived_at, new.deleted_at) is distinct from (old.name, old.acronym, old.archived_at, old.deleted_at) then
    update public.scope_collaborators sc
       set name = new.name, acronym = new.acronym, archived_at = new.archived_at, deleted_at = new.deleted_at
     where sc.collaborator_id = new.id;
  end if;
  if tg_op = 'INSERT' or new.workspace_ids is distinct from old.workspace_ids
     or (new.deleted_at is null and old.deleted_at is not null) then
    perform public.sync_collaborator_spaces(new.id);
  end if;
  return null;
end $$;
drop trigger z_mirror on public.collaborators;
create trigger z_mirror after insert or update on public.collaborators for each row execute function public.mirror_collaborator_change();

revoke execute on function public.collaborator_used_in(uuid, uuid), public.sync_collaborator_spaces(uuid) from anon, authenticated, public;

-- Kopie dla już przypisanych do przestrzeni.
do $$
declare
  r record;
begin
  for r in select id from public.collaborators where deleted_at is null and jsonb_typeof(workspace_ids) = 'array' loop
    perform public.sync_collaborator_spaces(r.id);
  end loop;
end $$;
