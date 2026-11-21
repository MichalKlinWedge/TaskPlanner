-- v1.x: limit miejsca na załączniki na konto (Storage Free = 1 GB na cały projekt).
--
-- Wysyłka przechodzi, dopóki pliki w folderze konta (`attachments/{user_id}/…`) zajmują mniej niż
-- limit — ostatni plik może go przekroczyć najwyżej o swój rozmiar (≤ 25 MB, `file_size_limit`
-- kubełka). Odmowa = zwykłe 403 RLS; klient (`packages/sync` `supabaseUploader`) pyta wtedy
-- `attachment_usage()` i przy pełnym limicie kończy wysyłkę bez ponawiania z komunikatem z core
-- (`ATTACHMENT_QUOTA_BYTES` musi się zgadzać z `attachment_quota_bytes()`).

create function public.attachment_quota_bytes() returns bigint
language sql immutable set search_path = '' as $$
  select 262144000::bigint  -- 250 MB
$$;

-- Zajęte miejsce zalogowanego konta i limit (do komunikatu w aplikacji).
create function public.attachment_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'used', coalesce(sum((o.metadata->>'size')::bigint), 0),
    'quota', public.attachment_quota_bytes())
  from storage.objects o
  where o.bucket_id = 'attachments' and auth.uid() is not null and (storage.foldername(o.name))[1] = auth.uid()::text
$$;

-- Jak w `*_etap10_attachments.sql` + warunek limitu.
create or replace function public.can_upload_attachment(p_name text) returns boolean
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
  if (public.attachment_usage()->>'used')::bigint >= public.attachment_quota_bytes() then
    return false;
  end if;
  return exists (select 1 from public.tasks t where t.id = task and t.deleted_at is null and public.can_write_scope(t.scope_id));
end $$;

revoke execute on function public.attachment_quota_bytes(), public.attachment_usage() from public, anon;
grant execute on function public.attachment_quota_bytes(), public.attachment_usage() to authenticated, service_role;
