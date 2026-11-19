-- MVP-4: przypomnienia Web Push liczone z `core/reminders.ts` (SPECYFIKACJA M8 web).
--
-- Zastępuje tymczasowe tabele PoC-6: subskrypcja przeglądarki to `devices.push_subscription` (wiersz
-- synchronizowany, zapisuje go klient przez `push_changes`), a zamiast kolejki `push_queue` funkcja
-- `reminders-push` co minutę liczy należne przypomnienia (`reminderFireTimes`) i zapisuje każdą wysyłkę
-- w dzienniku `reminder_deliveries` — jeden wiersz na urządzenie i wystąpienie przypomnienia, więc
-- dwa równoległe uruchomienia ani ponowne wyliczenie nie wyślą tego samego drugi raz. Przypomnienie
-- dostają tylko urządzenia z `reminder_channel = 'enabled'` (wybór w ustawieniach, M8).

drop function public.claim_push_queue(int);
drop function public.save_push_subscription(jsonb, text);
drop function public.delete_push_subscription(text);
drop table public.push_queue;
drop table public.push_subscriptions;

create table public.reminder_deliveries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  -- `ReminderFire.key` z core: `<id przypomnienia>:<dzień wystąpienia>`.
  fire_key text not null,
  task_id uuid not null references public.tasks (id) on delete cascade,
  fire_at timestamptz not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed', 'skipped')),
  attempts integer not null default 1,
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  unique (device_id, fire_key)
);
create index reminder_deliveries_user on public.reminder_deliveries (user_id, fire_at desc);

alter table public.reminder_deliveries enable row level security;
create policy own on public.reminder_deliveries for select to authenticated using (user_id = auth.uid());
revoke all on public.reminder_deliveries from anon, authenticated;
grant select on public.reminder_deliveries to authenticated;
-- Projekt w chmurze nie nadaje ról API do nowych tabel (PoC-6) — jawnie.
grant select, insert, update, delete on public.reminder_deliveries to service_role;

-- Zajęcie wysyłek przez `reminders-push`: nowy wiersz albo ponowienie po błędzie przejściowym
-- (najwyżej 5 prób). Zwraca tylko wiersze zajęte w tym wywołaniu — drugie równoległe dostaje konflikt.
-- `p_items`: [{user_id, device_id, fire_key, task_id, fire_at}].
create function public.claim_reminder_deliveries(p_items jsonb) returns setof public.reminder_deliveries
language sql security definer set search_path = '' as $$
  insert into public.reminder_deliveries as d (user_id, device_id, fire_key, task_id, fire_at)
  select (i ->> 'user_id')::uuid, (i ->> 'device_id')::uuid, i ->> 'fire_key', (i ->> 'task_id')::uuid, (i ->> 'fire_at')::timestamptz
    from jsonb_array_elements(coalesce(p_items, '[]')) i
  on conflict (device_id, fire_key) do update
     set status = 'claimed', attempts = d.attempts + 1, claimed_at = now(), error = null
   where d.status = 'failed' and d.attempts < 5
  returning d.*;
$$;

-- Subskrypcja wygasła (404/410): serwer czyści `devices.push_subscription` z HLC serwera — klienci
-- scalają to jak zmianę z innego urządzenia, a przeglądarka zapisze nową przy następnym włączeniu.
create function public.clear_push_subscription(p_device uuid, p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  update public.devices
     set push_subscription = null,
         field_clock = field_clock || jsonb_build_object('push_subscription', public.server_hlc())
   where id = p_device and push_subscription ->> 'endpoint' = p_endpoint;
$$;

revoke all on function public.claim_reminder_deliveries(jsonb), public.clear_push_subscription(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_reminder_deliveries(jsonb), public.clear_push_subscription(uuid, text) to service_role;
