-- Usunięcie konta, którego tag albo współpracownik jest użyty w cudzej przestrzeni (v1.x).
--
-- Tag i współpracownik należą do zakresu osobistego autora, ale od `*_v1x_scope_tags.sql`
-- i `*_v1x_scope_collaborators*.sql` członkowie przestrzeni przypinają cudze tagi i osoby. Usunięcie
-- konta (`account-delete` → `auth.admin.deleteUser` → kaskada z `sync_scopes`) kasuje `tags`
-- i `collaborators` autora, a klucze obce bez akcji (`task_tags.tag_id`,
-- `task_participants.collaborator_id`, `tasks.assignee_id`) blokowały to błędem 23503.
--
--   * Przed twardym usunięciem tagu / współpracownika wyzwalacz `before delete` sprząta w zakresach,
--     które zostają (cudze przestrzenie): przypięcia tagu i uczestnicy dostają `deleted_at`,
--     odpowiedzialny na zadaniu — `null` (zadanie wraca do twórcy), kopie w `scope_tags` /
--     `scope_collaborators` — `deleted_at`. Zwykłe aktualizacje: `stamp_row` podbija wersję zakresu,
--     więc pozostali członkowie dostają zmiany w `pull_changes`; HLC serwera w `field_clock`.
--     Wiersze w zakresach usuwanych razem z kontem pomija (ich `sync_scopes` już nie ma).
--   * Klucze obce z tych tabel do `tags` / `collaborators` zdjęte: przypięcie i kopia zostają
--     jako nagrobek ze wskazaniem na nieistniejący wiersz (kaskada `on delete cascade` kopii
--     skasowałaby nagrobek, zanim dotrze do klientów). Istnienie tagu / osoby przy przypięciu,
--     zmianie i przywróceniu sprawdzają wyzwalacze `a_derive` / `a_assignee` (ten sam kod 23503).
--
-- Migracja da się uruchomić ponownie (`if exists`, `create or replace`).

-- ── Klucze obce ──────────────────────────────────────────────────────────────────────────────

alter table public.task_tags drop constraint if exists task_tags_tag_id_fkey;
alter table public.task_participants drop constraint if exists task_participants_collaborator_id_fkey;
alter table public.tasks drop constraint if exists tasks_assignee_id_fkey;
alter table public.scope_tags drop constraint if exists scope_tags_tag_id_fkey;
alter table public.scope_collaborators drop constraint if exists scope_collaborators_collaborator_id_fkey;

-- ── Sprzątanie w zakresach, które zostają ────────────────────────────────────────────────────

create or replace function public.release_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  stamp text := public.server_hlc();
begin
  update public.task_tags tt
     set deleted_at = now(), field_clock = tt.field_clock || jsonb_build_object('deleted_at', stamp)
   where tt.tag_id = old.id and tt.deleted_at is null
     and exists (select 1 from public.sync_scopes s where s.id = tt.scope_id);
  update public.scope_tags st
     set deleted_at = now()
   where st.tag_id = old.id and st.deleted_at is null
     and exists (select 1 from public.sync_scopes s where s.id = st.scope_id);
  return old;
end $$;
drop trigger if exists a_release on public.tags;
create trigger a_release before delete on public.tags for each row execute function public.release_tag();

create or replace function public.release_collaborator() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  stamp text := public.server_hlc();
begin
  update public.tasks t
     set assignee_id = null, field_clock = t.field_clock || jsonb_build_object('assignee_id', stamp)
   where t.assignee_id = old.id
     and exists (select 1 from public.sync_scopes s where s.id = t.scope_id);
  update public.task_participants p
     set deleted_at = now(), field_clock = p.field_clock || jsonb_build_object('deleted_at', stamp)
   where p.collaborator_id = old.id and p.deleted_at is null
     and exists (select 1 from public.sync_scopes s where s.id = p.scope_id);
  update public.scope_collaborators sc
     set deleted_at = now()
   where sc.collaborator_id = old.id and sc.deleted_at is null
     and exists (select 1 from public.sync_scopes s where s.id = sc.scope_id);
  return old;
end $$;
drop trigger if exists a_release on public.collaborators;
create trigger a_release before delete on public.collaborators for each row execute function public.release_collaborator();

revoke execute on function public.release_tag(), public.release_collaborator() from anon, authenticated, public;

-- ── Istnienie tagu / osoby zamiast kluczy obcych ─────────────────────────────────────────────

-- Jak w `*_v1x_scope_tags.sql`, z kontrolą istnienia tagu przy przypięciu (nowe, inny tag, przywrócenie).
create or replace function public.derive_task_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  if new.deleted_at is null
     and (tg_op = 'INSERT' or new.tag_id is distinct from old.tag_id or old.deleted_at is not null) then
    if not exists (select 1 from public.tags g where g.id = new.tag_id) then
      raise exception using errcode = '23503', message = 'Brak tagu';
    end if;
    if auth.uid() is not null and not public.can_use_tag(new.tag_id, new.scope_id) then
      raise exception using errcode = 'TP003', message = 'Brak dostępu do tagu';
    end if;
  end if;
  return new;
end $$;

-- Jak w `*_v1x_scope_collaborators.sql`, z kontrolą istnienia osoby przy wskazaniu (nowe, inna osoba, przywrócenie).
create or replace function public.derive_task_participant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  if new.deleted_at is null
     and (tg_op = 'INSERT' or new.collaborator_id is distinct from old.collaborator_id or old.deleted_at is not null)
     and not exists (select 1 from public.collaborators c where c.id = new.collaborator_id) then
    raise exception using errcode = '23503', message = 'Brak współpracownika';
  end if;
  if auth.uid() is not null and not public.can_use_collaborator(new.collaborator_id, new.scope_id) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do współpracownika';
  end if;
  return new;
end $$;

create or replace function public.check_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    if not exists (select 1 from public.collaborators c where c.id = new.assignee_id) then
      raise exception using errcode = '23503', message = 'Brak współpracownika';
    end if;
    if auth.uid() is not null
       and not public.can_use_collaborator(new.assignee_id, (select l.scope_id from public.lists l where l.id = new.list_id)) then
      raise exception using errcode = 'TP003', message = 'Brak dostępu do współpracownika';
    end if;
  end if;
  return new;
end $$;
