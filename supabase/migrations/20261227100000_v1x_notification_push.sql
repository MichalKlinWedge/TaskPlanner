-- Centrum powiadomień, etap N2 (Web Push; PLAN_ETAPOWY.md → „Centrum powiadomień (web)”). Migracja addytywna.
--
-- Powiadomienia z kanałem `push` (`profiles.settings.notifications`) wysyła `reminders-push` co minutę na te same
-- urządzenia co przypomnienia; wysyłki trafiają do dziennika `reminder_deliveries` (`fire_key` = core
-- `notificationFireKey`, `task_id` null — zadanie mogło już zniknąć). Akcja „Oznacz jako przeczytane” w
-- powiadomieniu systemowym działa bez otwierania karty: Service Worker wysyła id z podpisem (HMAC z sekretu
-- funkcji), a funkcja zapisuje `read_at` tym RPC z serwerowym HLC — zmiana dochodzi na urządzenia zwykłą synchronizacją.

create function public.mark_notification_read(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.notifications
     set read_at = now(), field_clock = field_clock || jsonb_build_object('read_at', public.server_hlc())
   where id = p_id and read_at is null and deleted_at is null;
  return found;
end $$;
revoke execute on function public.mark_notification_read(uuid) from public, anon, authenticated;
grant execute on function public.mark_notification_read(uuid) to service_role;
