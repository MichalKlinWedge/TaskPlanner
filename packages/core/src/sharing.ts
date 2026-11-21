/**
 * Współdzielenie przestrzeni (v1.x, migracja `*_v1x_workspace_sharing.sql`): role członków, link
 * zaproszenia i adres osoby zapraszanej. Zaproszenie trafia tylko do istniejącego konta albo adresu
 * z listy zaproszonych do aplikacji (`allowed_emails`) — udostępnienie nie wpuszcza nowych kont.
 */
import { invitePattern, isDomainInvite } from './invites.ts';

export type ScopeRole = 'owner' | 'editor' | 'viewer';
export type ShareRole = Exclude<ScopeRole, 'owner'>;

export const SCOPE_ROLE: Record<ScopeRole, string> = {
  owner: 'Właściciel',
  editor: 'Edytor',
  viewer: 'Podgląd',
};

export const SCOPE_ROLE_HINT: Record<ShareRole, string> = {
  editor: 'dodaje i zmienia zadania, listy i projekty',
  viewer: 'tylko czyta',
};

/** Parametr adresu z tokenem zaproszenia (`/?invite=<token>`). */
export const INVITE_PARAM = 'invite';

export const WORKSPACE_SHARE_NOTE =
  'Zaprosić można osobę, która ma już konto w Task Plannerze albo jest na liście zaproszonych do aplikacji. Zobaczy zaproszenie po zalogowaniu; możesz też wysłać jej link. Przypomnienia o zadaniach dostaje tylko ten, kto je ustawił.';

/** Adres zapraszanej osoby po normalizacji albo `null` (sama domena się nie liczy). */
export function shareEmail(input: string): string | null {
  const pattern = invitePattern(input);
  return pattern && !isDomainInvite(pattern) ? pattern : null;
}

/** Link zaproszenia do wysłania osobie zapraszanej. */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/?${INVITE_PARAM}=${encodeURIComponent(token)}`;
}

/** Token z adresu (`?invite=…`) albo `null`. */
export function inviteTokenFrom(url: string): string | null {
  try {
    const token = new URL(url).searchParams.get(INVITE_PARAM)?.trim();
    return token && /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Czy rola pozwala zmieniać dane przestrzeni (`null` = brak informacji z serwera — jak właściciel). */
export const canEditScope = (role: ScopeRole | null | undefined): boolean => role !== 'viewer';
