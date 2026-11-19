-- PoC-6: jawne uprawnienia `service_role` do tabel integracji.
--
-- Nowe projekty Supabase w chmurze nie nadają ról API (`anon`, `authenticated`, `service_role`) do tabel
-- tworzonych w migracjach; lokalny stack nadaje (`auto_expose_new_tables` domyślnie włączone). Bez tego
-- Edge Functions w chmurze dostają „permission denied for table calendar_accounts”. `service_role` omija
-- RLS, ale nie uprawnienia tabel. Klienci (`authenticated`) mają tylko granty z migracji PoC-6.

grant select, insert, update, delete on
  public.calendar_accounts, public.calendars, public.calendar_events, public.oauth_states,
  public.inbound_addresses, public.inbound_messages, public.push_subscriptions, public.push_queue
  to service_role;

-- `reminders-push` sprawdza status zadania w chwili wysyłki.
grant select on public.tasks to service_role;
