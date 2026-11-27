-- Osoby po autorze, który opuścił przestrzeń (v1.x). Współpracownik należy do książki adresowej osoby,
-- która go dodała; w przestrzeni widać jego kopię (`scope_collaborators`, tylko do odczytu). Gdy autor
-- odchodzi (np. przekazał przestrzeń i wyszedł), nikt już nie może tej osoby zmienić, a kopia zostaje
-- na zawsze. Klient „Przejmuje” taką osobę: zakłada własny wpis (albo łączy z własnym o tej nazwie)
-- i przepina na niego zadania przestrzeni (`takeOverCollaboratorOps` w core).
--
--   * `prune_collaborator_copy` — kopia osoby, której autor nie jest już członkiem przestrzeni, znika
--     (`deleted_at`), gdy nikt jej tam nie używa (odpowiedzialny / uczestnik). Kopie osób autorów, którzy
--     są członkami, zachowują się jak dotąd (zostają po użyciu).
--   * Wywołania: zmiana odpowiedzialnego, usunięcie / zmiana uczestnika, odejście członka; raz dla
--     istniejących kopii.

create function public.prune_collaborator_copy(p_scope uuid, p_collaborator uuid) returns void
language sql security definer set search_path = '' as $$
  update public.scope_collaborators sc
     set deleted_at = now()
   where sc.scope_id = p_scope
     and sc.collaborator_id = p_collaborator
     and sc.deleted_at is null
     and exists (select 1 from public.sync_scopes s where s.id = p_scope)
     and not exists (select 1 from public.collaborators c
                       join public.scope_members m on m.scope_id = p_scope and m.user_id = c.scope_id
                      where c.id = p_collaborator)
     and not public.collaborator_used_in(p_scope, p_collaborator)
$$;

-- Jak w `*_v1x_scope_collaborators.sql`, z porządkiem po poprzednim odpowiedzialnym.
create or replace function public.mirror_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id or new.scope_id is distinct from old.scope_id) then
    perform public.mirror_collaborator(new.scope_id, new.assignee_id);
  end if;
  if tg_op = 'UPDATE' and old.assignee_id is not null
     and (new.assignee_id is distinct from old.assignee_id or new.scope_id is distinct from old.scope_id) then
    perform public.prune_collaborator_copy(old.scope_id, old.assignee_id);
  end if;
  return null;
end $$;

-- Jak w `*_v1x_scope_collaborators.sql`, z porządkiem po usuniętym / zmienionym uczestniku.
create or replace function public.mirror_task_participant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is null
     and (tg_op = 'INSERT' or new.collaborator_id is distinct from old.collaborator_id
          or new.scope_id is distinct from old.scope_id or old.deleted_at is not null) then
    perform public.mirror_collaborator(new.scope_id, new.collaborator_id);
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null
     and (new.deleted_at is not null or new.collaborator_id is distinct from old.collaborator_id
          or new.scope_id is distinct from old.scope_id) then
    perform public.prune_collaborator_copy(old.scope_id, old.collaborator_id);
  end if;
  return null;
end $$;

-- Członek odchodzi: jego nieużywane osoby znikają z przestrzeni.
create function public.prune_member_collaborators() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  for r in
    select sc.collaborator_id from public.scope_collaborators sc
      join public.collaborators c on c.id = sc.collaborator_id
     where sc.scope_id = old.scope_id and c.scope_id = old.user_id and sc.deleted_at is null
  loop
    perform public.prune_collaborator_copy(old.scope_id, r.collaborator_id);
  end loop;
  return null;
end $$;
create trigger z_prune_collaborators after delete on public.scope_members
  for each row execute function public.prune_member_collaborators();

revoke execute on function public.prune_collaborator_copy(uuid, uuid), public.prune_member_collaborators(),
  public.mirror_task_assignee(), public.mirror_task_participant() from anon, authenticated, public;

-- Istniejące kopie osób po autorach spoza przestrzeni.
do $$
declare
  r record;
begin
  for r in select scope_id, collaborator_id from public.scope_collaborators where deleted_at is null loop
    perform public.prune_collaborator_copy(r.scope_id, r.collaborator_id);
  end loop;
end $$;
