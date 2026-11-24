/**
 * Współdzielenie przestrzeni (v1.x): wywołania RPC (`*_v1x_workspace_sharing.sql`) i token zaproszenia
 * z linku `/?invite=<token>`. Token zapamiętujemy przy wczytaniu modułu (przed logowaniem — powrót
 * z Google / linku e-mail nie zachowuje parametrów), `AppRoot` czyści adres; przyjmuje go `ScopeInvites`
 * po zalogowaniu. Wszystko wymaga sieci — dane przestrzeni przychodzą potem zwykłą synchronizacją.
 */
import { inviteTokenFrom, INVITE_PARAM, type OwnerAfter, type OwnershipOffer, type ScopeRole, type ShareRole, type SpaceMember } from "@taskplanner/core";

import { supabaseBrowser } from "./supabase-browser";

const TOKEN_KEY = "tp-invite-token";

export interface PendingInvite {
  id: string;
  email: string;
  role: ShareRole;
  token: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

/** Propozycja roli właściciela czekająca na odpowiedź (`mine` — wysłana przez zalogowanego). */
export interface PendingOwnerOffer {
  id: string;
  userId: string;
  email: string;
  offeredBy: string;
  mine: boolean;
  after: OwnerAfter | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface WorkspaceSharing {
  role: ScopeRole;
  members: SpaceMember[];
  invites: PendingInvite[];
  offers: PendingOwnerOffer[];
}

export interface MyInvite {
  id: string;
  scopeId: string;
  workspace: string;
  role: ShareRole;
  invitedBy: string | null;
  createdAt: string;
}

function captureToken() {
  if (typeof window === "undefined") return;
  const token = inviteTokenFrom(window.location.href);
  if (!token) return;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Bez localStorage zaproszenie i tak czeka w aplikacji (lista zaproszeń).
  }
}
captureToken();

/** Usuwa token z paska adresu (po hydratacji — wcześniej router Next przywraca adres). */
export function clearInviteParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(INVITE_PARAM)) return;
  url.searchParams.delete(INVITE_PARAM);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

/** Token z linku zaproszenia czekający na zalogowanie (i usunięty z pamięci). */
export function takeInviteToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    return token;
  } catch {
    return null;
  }
}

let linkAccept: Promise<string | null> | null = null;

/**
 * Przyjęcie zaproszenia z linku zapamiętanego przed logowaniem — raz na wczytanie strony (efekt
 * w trybie Strict uruchamia się dwa razy, a token jest jednorazowy). `null` = nie było linku.
 */
export function acceptLinkInvite(): Promise<string | null> {
  if (!linkAccept) {
    const token = takeInviteToken();
    linkAccept = token ? acceptInvite({ token }) : Promise.resolve(null);
  }
  return linkAccept;
}

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  // Nazwy i argumenty z `database.types.ts`; tu luźno, bo odpowiedzi to jsonb.
  const { data, error } = await (supabaseBrowser().rpc as (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>)(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const workspaceSharing = (scope: string) => call<WorkspaceSharing>("workspace_sharing", { p_scope: scope });
export const shareWorkspace = (scope: string, email: string, role: ShareRole) => call<{ id: string; token: string }>("share_workspace", { p_scope: scope, p_email: email, p_role: role });
export const revokeInvite = (id: string) => call<boolean>("revoke_scope_invite", { p_id: id });
export const setMemberRole = (scope: string, user: string, role: ShareRole) => call<void>("set_scope_member_role", { p_scope: scope, p_user: user, p_role: role });
export const removeMember = (scope: string, user: string) => call<void>("remove_scope_member", { p_scope: scope, p_user: user });
export const myInvites = () => call<MyInvite[]>("my_scope_invites");
export const acceptInvite = (by: { id: string } | { token: string }) => call<string>("accept_scope_invite", "id" in by ? { p_id: by.id } : { p_token: by.token });
export const declineInvite = (id: string) => call<boolean>("decline_scope_invite", { p_id: id });
/** Propozycja roli właściciela (`after` `null`) albo przekazania przestrzeni — działa dopiero po zgodzie adresata. */
export const offerOwnership = (scope: string, user: string, after: OwnerAfter | null) => call<string>("offer_workspace_ownership", { p_scope: scope, p_user: user, p_after: after });
export const cancelOwnershipOffer = (id: string) => call<boolean>("cancel_workspace_ownership_offer", { p_id: id });
export const myOwnershipOffers = () => call<OwnershipOffer[]>("my_ownership_offers");
export const answerOwnershipOffer = (id: string, accept: boolean) => call<string>("answer_workspace_ownership_offer", { p_id: id, p_accept: accept });
/** Współwłaściciel (nie główny) rezygnuje z roli bez następcy. */
export const resignOwner = (scope: string, after: OwnerAfter) => call<void>("resign_workspace_owner", { p_scope: scope, p_after: after });
