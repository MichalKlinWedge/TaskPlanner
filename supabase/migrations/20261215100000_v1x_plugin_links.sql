-- v1.x: integracje wychodzące, etap I3 (SPECYFIKACJA M21) — powiązanie zadania z obiektem w systemie zewnętrznym.
--
-- Plugin natywny (GitLab) przy pierwszej wysyłce zadania tworzy obiekt (issue), a kolejne wysyłki tego zadania
-- przez to samo połączenie zmieniają ten obiekt (zamknięcie, termin, etykiety, notatka). Historia wysyłek
-- (`plugin_deliveries`) ma retencję 30 dni, więc powiązanie trzyma osobna tabela, bez retencji. Pisze tylko
-- Edge Function `plugins` (`service_role`); klient może czytać własne wiersze (link przy zadaniu — później).
-- Migracja addytywna.

create table public.plugin_links (
  connection_id uuid not null references public.plugin_connections (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Id obiektu u dostawcy (GitLab: `<id projektu>:<iid>`) i link do niego.
  external_id text not null,
  external_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, task_id)
);
create index plugin_links_task on public.plugin_links (task_id);
create index plugin_links_user on public.plugin_links (user_id);

alter table public.plugin_links enable row level security;
revoke all on public.plugin_links from anon, authenticated;
grant all on public.plugin_links to service_role;
create policy own on public.plugin_links for select to authenticated using (user_id = auth.uid());
grant select on public.plugin_links to authenticated;
