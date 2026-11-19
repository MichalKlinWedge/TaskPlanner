-- PoC-6: odpytywanie kalendarzy (ICS i zapas dla `watch` Google) co 10 min zamiast co 15.
--
-- Pomiar na prawdziwym ICS: Google pokazuje zmianę w pliku ~25 s po zapisie, więc przy 15 min najgorszy
-- przypadek przekraczał kryterium „< 15 min”. Przy 10 min: najwyżej ~10,5 min, średnio ~5,5 min.
-- `cron.schedule` z istniejącą nazwą zmienia harmonogram tego samego zadania.

select cron.schedule('taskplanner-calendar-poll', '*/10 * * * *', $$select public.call_edge_function('calendar-sync/cron/poll')$$);
