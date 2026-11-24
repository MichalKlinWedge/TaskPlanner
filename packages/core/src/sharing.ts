/**
 * Współdzielenie przestrzeni (v1.x, migracja `*_v1x_workspace_sharing.sql`): role członków, link
 * zaproszenia i adres osoby zapraszanej. Zaproszenie trafia tylko do istniejącego konta albo adresu
 * z listy zaproszonych do aplikacji (`allowed_emails`) — udostępnienie nie wpuszcza nowych kont.
 */
import { invitePattern, isDomainInvite } from './invites.ts';
import type { GuestAccess } from './schemas/primitives.ts';

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

/** Parametr adresu z tokenem zaproszenia (`/invite?invite=<token>`, starsze linki `/?invite=<token>`). */
export const INVITE_PARAM = 'invite';

/** Ścieżka linku zaproszenia: na telefonie otwiera aplikację (App Links), web przekierowuje ją na stronę główną. */
export const INVITE_PATH = '/invite';

export const WORKSPACE_SHARE_NOTE =
  'Zaprosić można osobę, która ma już konto w Task Plannerze albo jest na liście zaproszonych do aplikacji. Zobaczy zaproszenie po zalogowaniu; możesz też wysłać jej link. Przypomnienia o zadaniach dostaje tylko ten, kto je ustawił.';

/** Adres zapraszanej osoby po normalizacji albo `null` (sama domena się nie liczy). */
export function shareEmail(input: string): string | null {
  const pattern = invitePattern(input);
  return pattern && !isDomainInvite(pattern) ? pattern : null;
}

/** Link zaproszenia do wysłania osobie zapraszanej. */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${INVITE_PATH}?${INVITE_PARAM}=${encodeURIComponent(token)}`;
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

// ── Dostęp gości do list (migracja `*_v1x_list_guest_access.sql`) ──────────────────────────────

export const GUEST_ACCESS: Record<GuestAccess, string> = {
  hidden: 'Ukryta',
  view: 'Podgląd',
  edit: 'Edycja',
};

export const GUEST_ACCESS_HINT: Record<GuestAccess, string> = {
  hidden: 'osoby, którym udostępniono przestrzeń, nie widzą listy ani jej zadań',
  view: 'osoby, którym udostępniono przestrzeń, tylko czytają',
  edit: 'edytorzy zmieniają zadania, rola Podgląd tylko czyta',
};

export const GUEST_ACCESS_NOTE =
  'Dostęp do listy dotyczy wszystkich osób, którym udostępniono przestrzeń (Ty jako właściciel zawsze masz pełny). Liczy się słabsze z dwóch: rola osoby i ustawienie listy.';

export const READONLY_LIST_NOTE = 'Ta lista jest udostępniona Ci tylko do podglądu — zadań nie da się zmienić.';

/**
 * Co użytkownik może z listą: właściciel (i brak roli — dane własne) zawsze `edit`, gość — słabsze
 * z roli w przestrzeni i ustawienia listy (`viewer` nigdy nie edytuje). Ta sama reguła co
 * `public.list_access` w bazie.
 */
export function listAccess(role: ScopeRole | null | undefined, guestAccess: GuestAccess | null | undefined): GuestAccess {
  if (!role || role === 'owner') return 'edit';
  if (guestAccess === 'hidden') return 'hidden';
  if (role === 'viewer' || guestAccess === 'view') return 'view';
  return 'edit';
}

/** Czy użytkownik może zmieniać listę i jej zadania. */
export const canEditList = (role: ScopeRole | null | undefined, guestAccess: GuestAccess | null | undefined): boolean =>
  listAccess(role, guestAccess) === 'edit';

export interface ListShareBadge {
  icon: string;
  /** Podpowiedź / tekst dla czytnika ekranu. */
  label: string;
}

/**
 * Ikona udostępnienia przy nazwie listy. Właściciel (i brak roli — dane własne) udostępnionej
 * przestrzeni (`members` > 1) widzi ustawienie listy dla gości; gość — swój dostęp do listy. Lista
 * w przestrzeni nikomu nieudostępnionej — bez ikony.
 */
export function listShareBadge(role: ScopeRole | null | undefined, guestAccess: GuestAccess | null | undefined, members: number | null | undefined): ListShareBadge | null {
  if (!role || role === 'owner') {
    if ((members ?? 1) <= 1) return null;
    if (guestAccess === 'hidden') return { icon: '🔒', label: 'Ukryta przed osobami, którym udostępniono przestrzeń' };
    if (guestAccess === 'view') return { icon: '👁', label: 'Udostępniona do podglądu' };
    return { icon: '👥', label: 'Udostępniona do edycji (rola Podgląd tylko czyta)' };
  }
  const access = listAccess(role, guestAccess);
  if (access === 'hidden') return null;
  return access === 'view' ? { icon: '👁', label: 'Udostępniona Ci do podglądu' } : { icon: '✎', label: 'Udostępniona Ci do edycji' };
}
