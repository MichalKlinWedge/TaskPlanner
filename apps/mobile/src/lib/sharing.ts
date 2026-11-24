/**
 * Współdzielenie przestrzeni (v1.x) na telefonie: RPC z `*_v1x_workspace_sharing.sql` (wymagają sieci)
 * i wspólna lista zaproszeń do zalogowanego (`useScopeInvites` — jedno zapytanie na minutę dla wszystkich
 * ekranów z paskiem). Token z linku zaproszenia (`app/invite.tsx`, udostępniony tekst) czeka w pamięci na
 * zalogowanie (`rememberInviteToken` → `acceptLinkInvite`). Po przyjęciu / opuszczeniu przestrzeni `syncNow()` pobiera albo usuwa jej dane.
 * Odpowiednik webowego `lib/sharing.ts`.
 */
import { isTransientError, type ScopeRole, type ShareRole } from '@taskplanner/core';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { sessionUser } from './config';
import { supabaseClient, syncNow } from './sync';

export interface ScopeMember {
  userId: string;
  email: string;
  role: ScopeRole;
  me: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: ShareRole;
  token: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface WorkspaceSharing {
  role: ScopeRole;
  members: ScopeMember[];
  invites: PendingInvite[];
}

export interface MyInvite {
  id: string;
  scopeId: string;
  workspace: string;
  role: ShareRole;
  invitedBy: string | null;
  createdAt: string;
}

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const rpc = supabaseClient().rpc as (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const workspaceSharing = (scope: string) => call<WorkspaceSharing>('workspace_sharing', { p_scope: scope });
export const shareWorkspace = (scope: string, email: string, role: ShareRole) => call<{ id: string; token: string }>('share_workspace', { p_scope: scope, p_email: email, p_role: role });
export const revokeInvite = (id: string) => call<boolean>('revoke_scope_invite', { p_id: id });
export const setMemberRole = (scope: string, user: string, role: ShareRole) => call<void>('set_scope_member_role', { p_scope: scope, p_user: user, p_role: role });

export async function removeMember(scope: string, user: string, self = false) {
  await call<void>('remove_scope_member', { p_scope: scope, p_user: user });
  if (self) await syncNow().catch(() => undefined);
}

let invites: MyInvite[] = [];
let loadedAt = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Odświeża listę zaproszeń (najwyżej raz na minutę, chyba że `force`). */
export async function refreshScopeInvites(force = false) {
  if (!sessionUser().online || (!force && Date.now() - loadedAt < 60_000)) return;
  loadedAt = Date.now();
  try {
    invites = await call<MyInvite[]>('my_scope_invites');
    emit();
  } catch {
    loadedAt = 0; // offline albo chwilowy błąd — następna próba przy kolejnym ekranie
  }
}

export async function answerScopeInvite(invite: MyInvite, accept: boolean) {
  if (accept) await call<string>('accept_scope_invite', { p_id: invite.id });
  else await call<boolean>('decline_scope_invite', { p_id: invite.id });
  invites = invites.filter((i) => i.id !== invite.id);
  emit();
  if (accept) await syncNow().catch(() => undefined);
  void refreshScopeInvites(true);
}

const TOKEN_KEY = 'invite.token';
let accepting: Promise<boolean> | null = null;

/** Token z linku — do przyjęcia teraz albo po zalogowaniu. */
export const rememberInviteToken = (token: string) => Storage.setItemSync(TOKEN_KEY, token);
export const pendingInviteToken = (): string | null => Storage.getItemSync(TOKEN_KEY);

/**
 * Przyjmuje zapamiętane zaproszenie z linku; `false` = nie ma czego albo nikt nie jest zalogowany. Token znika
 * po odpowiedzi serwera (jest jednorazowy); bez połączenia zostaje do następnej próby.
 */
export function acceptLinkInvite(): Promise<boolean> {
  const token = pendingInviteToken();
  // Trwające przyjmowanie (ekran linku i `InviteLink` naraz) — jedno zapytanie, token jest jednorazowy.
  if (!accepting && (!token || !sessionUser().online)) return Promise.resolve(false);
  accepting ??= (async () => {
    try {
      await call<string>('accept_scope_invite', { p_token: token });
    } catch (error) {
      if (!isTransientError(error)) Storage.removeItemSync(TOKEN_KEY);
      throw error;
    }
    Storage.removeItemSync(TOKEN_KEY);
    await syncNow().catch(() => undefined);
    void refreshScopeInvites(true);
    return true;
  })().finally(() => {
    accepting = null;
  });
  return accepting;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Zaproszenia do zalogowanego; odświeżane przy montowaniu i powrocie aplikacji na pierwszy plan. */
export function useScopeInvites(): MyInvite[] {
  useEffect(() => {
    void refreshScopeInvites();
    const sub = AppState.addEventListener('change', (state) => state === 'active' && void refreshScopeInvites());
    return () => sub.remove();
  }, []);
  return useSyncExternalStore(subscribe, () => invites);
}
