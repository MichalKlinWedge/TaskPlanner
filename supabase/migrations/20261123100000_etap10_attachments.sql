-- Etap 10: pliki załączników (M5) w prywatnym buckecie `attachments` Supabase Storage.
--
-- Ścieżka pliku: `{user_id}/{task_id}/{attachment_id}-{nazwa}` (SPECYFIKACJA M5). Plik jest
-- niezmienny — klient tylko go wysyła (bez nadpisywania i usuwania); metadane to wiersz
-- `attachments` (synchronizowany jak inne), który klient dopisuje do outboxu dopiero po udanej
-- wysyłce (kolejka plików w `packages/sync/src/files.ts`). Usunięcie załącznika = `deleted_at`
-- wiersza; sprzątanie osieroconych plików — później (po 90 dniach, razem z usuniętymi wierszami).
--
-- Dostęp:
--   * wysłać może zalogowany do własnego folderu i tylko do zadania, które może edytować;
--   * czytać może autor (od razu, zanim wiersz dotrze na serwer) oraz każdy członek zakresu
--     wiersza `attachments` z tą ścieżką (wspólna przestrzeń).

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Czy ścieżka wskazuje własny folder i zadanie z prawem zapisu (`{uid}/{task}/{plik}`).
create function public.can_upload_attachment(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  parts text[] := string_to_array(p_name, '/');
  task uuid;
begin
  if auth.uid() is null or array_length(parts, 1) <> 3 or parts[1] <> auth.uid()::text or coalesce(parts[3], '') = '' then
    return false;
  end if;
  begin
    task := parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (select 1 from public.tasks t where t.id = task and t.deleted_at is null and public.can_write_scope(t.scope_id));
end $$;

-- Czy plik należy do załącznika w zakresie, do którego użytkownik ma dostęp.
create function public.can_read_attachment(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.attachments a where a.storage_path = p_name and public.has_scope_access(a.scope_id));
$$;

revoke execute on function public.can_upload_attachment(text), public.can_read_attachment(text) from anon, public;
grant execute on function public.can_upload_attachment(text), public.can_read_attachment(text) to authenticated;

create policy attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.can_upload_attachment(name));

create policy attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (owner_id = auth.uid()::text or public.can_read_attachment(name)));
