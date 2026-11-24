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

// ── Właściciele przestrzeni (migracja `*_v1x_workspace_owners.sql`) ────────────────────────────
//
// Właścicieli może być kilku, z tymi samymi uprawnieniami; jeden jest głównym (`primary`). Rolę
// właściciela proponuje się członkowi — zaczyna działać dopiero po jego zgodzie.

/** Co dzieje się z dotychczasowym właścicielem po przejęciu przestrzeni przez inną osobę. */
export type OwnerAfter = ShareRole | 'leave';

export const OWNER_AFTER: Record<OwnerAfter, string> = {
  editor: 'Edytor',
  viewer: 'Podgląd',
  leave: 'Opuść przestrzeń',
};

export const OWNER_OFFER_NOTE =
  'Właściciel może wszystko: zaprasza i usuwa osoby, zmienia role i dostęp do list, archiwizuje i usuwa przestrzeń. Rola zaczyna działać dopiero, gdy ta osoba ją przyjmie (propozycja jest ważna 14 dni).';

export interface SpaceMember {
  userId: string;
  email: string;
  role: ScopeRole;
  me: boolean;
  /** Główny właściciel przestrzeni. */
  primary?: boolean;
}

/** Nazwa roli członka; „Główny właściciel” tylko wtedy, gdy właścicieli jest kilku. */
export function memberRoleLabel(member: Pick<SpaceMember, 'role' | 'primary'>, members: readonly Pick<SpaceMember, 'role'>[]): string {
  return member.primary && members.filter((m) => m.role === 'owner').length > 1 ? 'Główny właściciel' : SCOPE_ROLE[member.role];
}

/** Czy `actor` może zmienić rolę `member` albo usunąć go z przestrzeni (innego właściciela — tylko główny). */
export function canManageMember(actor: SpaceMember | undefined, member: SpaceMember): boolean {
  if (actor?.role !== 'owner' || member.userId === actor.userId) return false;
  return member.role !== 'owner' || !!actor.primary;
}

/** Komu można przekazać przestrzeń (każdy inny członek, też współwłaściciel). */
export const ownershipHeirs = (members: readonly SpaceMember[]): SpaceMember[] => members.filter((m) => !m.me);

/** Pytanie przed wysłaniem propozycji: `after` `null` — kolejny właściciel, inaczej przekazanie przestrzeni. */
export function ownerOfferQuestion(email: string, workspace: string, after: OwnerAfter | null): string {
  if (!after) return `Zaproponować ${email} rolę właściciela przestrzeni „${workspace}”? Po przyjęciu ta osoba będzie mieć te same uprawnienia co Ty — także do usunięcia przestrzeni.`;
  return `Przekazać przestrzeń „${workspace}” osobie ${email}? Gdy ta osoba potwierdzi przejęcie, stracisz rolę właściciela i ${
    after === 'leave' ? 'opuścisz przestrzeń — jej zadania znikną z Twoich urządzeń' : `zostaniesz z rolą ${SCOPE_ROLE[after]}`
  }. Do tego czasu nic się nie zmienia i możesz się wycofać.`;
}

/** Pytanie przed zrzeczeniem się roli współwłaściciela (bez następcy). */
export function ownerResignQuestion(workspace: string, after: OwnerAfter): string {
  return after === 'leave'
    ? `Zrzec się roli właściciela i opuścić przestrzeń „${workspace}”? Jej zadania znikną z Twoich urządzeń; wrócisz tylko z nowym zaproszeniem.`
    : `Zrzec się roli właściciela przestrzeni „${workspace}”? Zostaniesz z rolą ${SCOPE_ROLE[after]}.`;
}

/** Propozycja dla zalogowanego (`my_ownership_offers`). */
export interface OwnershipOffer {
  id: string;
  scopeId: string;
  workspace: string;
  offeredBy: string | null;
  after: OwnerAfter | null;
  /** Po przyjęciu zalogowany zostaje głównym właścicielem. */
  primary: boolean;
  createdAt: string;
  expiresAt: string;
}

/** Treść propozycji dla adresata (pasek u góry aplikacji). */
export function ownershipOfferText(offer: Pick<OwnershipOffer, 'workspace' | 'offeredBy' | 'after'>): string {
  const who = offer.offeredBy ?? 'Właściciel';
  return offer.after
    ? `${who} chce przekazać Ci przestrzeń „${offer.workspace}” — zrzeka się roli właściciela na Twoją rzecz.`
    : `${who} proponuje Ci rolę właściciela przestrzeni „${offer.workspace}”.`;
}

/** Potwierdzenie przejęcia — pokazywane adresatowi przed przyjęciem. */
export function ownershipAcceptQuestion(offer: Pick<OwnershipOffer, 'workspace' | 'offeredBy' | 'after' | 'primary'>): string {
  const rights = `${offer.primary ? 'Zostaniesz głównym właścicielem' : 'Zostaniesz właścicielem'} przestrzeni „${offer.workspace}” ze wszystkimi uprawnieniami: osoby i role, dostęp do list, archiwizacja i usunięcie przestrzeni.`;
  if (!offer.after) return rights;
  const who = offer.offeredBy ?? 'Dotychczasowy właściciel';
  return `${rights} ${who} ${offer.after === 'leave' ? 'opuści przestrzeń' : `straci rolę właściciela (zostanie z rolą ${SCOPE_ROLE[offer.after]})`}. Cofnąć to można tylko kolejnym przekazaniem.`;
}

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
  'Dostęp do listy dotyczy wszystkich osób, którym udostępniono przestrzeń (właściciele zawsze mają pełny). Liczy się słabsze z dwóch: rola osoby i ustawienie listy.';

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
