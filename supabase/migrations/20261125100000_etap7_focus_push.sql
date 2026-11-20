-- Etap 7: koniec etapu skupienia jako Web Push z `reminders-push` (także przy zamkniętej karcie).
--
-- Wysyłki trafiają do tego samego dziennika `reminder_deliveries` (jedno urządzenie i odcinek raz;
-- `fire_key` = `<id wpisu time_entries>:focus`), ale etap może nie mieć zadania — `task_id` bez `not null`.

alter table public.reminder_deliveries alter column task_id drop not null;
comment on column public.reminder_deliveries.task_id is 'Zadanie przypomnienia; null — koniec etapu skupienia bez zadania (Etap 7).';
