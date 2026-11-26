-- v1.x: data dołączenia członka do przestrzeni (`scope_members.joined_at`), pokazywana na listach
-- osób („Osoby” przestrzeni, „Współpracownicy” → „Osoby w udostępnionych przestrzeniach”).
--
-- Nowe wiersze dostają `now()` (przyjęcie zaproszenia, założenie przestrzeni, zakres osobisty).
-- Dla istniejących członków data nie była zapisywana: główny właściciel dostaje datę założenia
-- zakresu (`sync_scopes.created_at`), pozostali zostają z `null` (UI pokazuje wtedy brak daty).

alter table public.scope_members add column joined_at timestamptz;

update public.scope_members m
   set joined_at = s.created_at
  from public.sync_scopes s
 where s.id = m.scope_id and s.owner_id = m.user_id;

alter table public.scope_members alter column joined_at set default now();

-- Jak w `*_v1x_workspace_owners.sql` + `joinedAt` członka (`null` — sprzed tej migracji).
create or replace function public.workspace_sharing(p_scope uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := public.scope_role(p_scope);
begin
  if v_role is null then
    raise exception 'Brak dostępu do przestrzeni' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'role', v_role,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'email', lower(u.email), 'role', m.role, 'me', m.user_id = auth.uid(),
                    'primary', m.user_id = s.owner_id, 'joinedAt', m.joined_at)
                  order by (m.user_id = s.owner_id) desc, case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, lower(u.email)), '[]')
                  from public.scope_members m
                  join public.sync_scopes s on s.id = m.scope_id
                  join auth.users u on u.id = m.user_id
                 where m.scope_id = p_scope),
    'offers', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'userId', o.user_id, 'email', lower(t.email), 'offeredBy', lower(b.email),
                    'mine', o.offered_by = auth.uid(), 'after', o.after_role, 'createdAt', o.created_at, 'expiresAt', o.expires_at,
                    'expired', o.expires_at < now()) order by o.created_at desc), '[]')
                 from public.scope_owner_offers o
                 join auth.users t on t.id = o.user_id
                 join auth.users b on b.id = o.offered_by
                where o.scope_id = p_scope and (v_role = 'owner' or o.user_id = auth.uid())),
    'invites', case when v_role = 'owner' then
                 (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'token', i.token,
                    'createdAt', i.created_at, 'expiresAt', i.expires_at, 'expired', i.expires_at < now()) order by i.created_at desc), '[]')
                    from public.scope_invites i where i.scope_id = p_scope)
               else '[]'::jsonb end);
end $$;
