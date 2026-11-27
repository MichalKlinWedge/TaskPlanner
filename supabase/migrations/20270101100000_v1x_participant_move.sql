-- Przeniesienie zadania z uczestnikiem wpisanym przez innego członka przestrzeni (v1.x).
--
-- `derive_task_participant` sprawdzał `can_use_collaborator` przy każdym zapisie uczestnika, także
-- gdy `tasks_cascade` przepisywał tylko `scope_id` po przeniesieniu zadania do innej przestrzeni.
-- Osoba z kopii w przestrzeni źródłowej nie ma kopii w docelowej, więc całe przeniesienie wracało
-- z TP003 („Brak dostępu do współpracownika”) — nawet dla usuniętych uczestników.
--
-- Teraz tak jak tagi (`derive_task_tag`) i odpowiedzialny (`check_task_assignee`): prawo do osoby
-- sprawdzamy tylko przy wskazaniu — nowy uczestnik, inna osoba albo przywrócenie usuniętego.
-- Przeniesienie i usunięcie przechodzą; `mirror_task_participant` zakłada kopię osoby w przestrzeni
-- docelowej (jak dla odpowiedzialnego), a `prune_collaborator_copy` sprząta źródłową.

create or replace function public.derive_task_participant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  if new.deleted_at is null
     and (tg_op = 'INSERT' or new.collaborator_id is distinct from old.collaborator_id or old.deleted_at is not null) then
    if not exists (select 1 from public.collaborators c where c.id = new.collaborator_id) then
      raise exception using errcode = '23503', message = 'Brak współpracownika';
    end if;
    if auth.uid() is not null and not public.can_use_collaborator(new.collaborator_id, new.scope_id) then
      raise exception using errcode = 'TP003', message = 'Brak dostępu do współpracownika';
    end if;
  end if;
  return new;
end $$;
