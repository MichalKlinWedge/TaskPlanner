import { describe, expect, it } from 'vitest';

import {
  canEditList,
  canEditScope,
  canManageMember,
  inviteLink,
  inviteTokenFrom,
  listAccess,
  listShareBadge,
  memberRoleLabel,
  memberSince,
  ownerOfferQuestion,
  ownershipAcceptQuestion,
  ownershipHeirs,
  ownershipOfferText,
  shareEmail,
  type SpaceMember,
} from '../sharing.ts';

describe('współdzielenie przestrzeni', () => {
  it('adres zapraszanej osoby: normalizacja, bez domen', () => {
    expect(shareEmail('  Jan@Example.COM ')).toBe('jan@example.com');
    expect(shareEmail('@firma.pl')).toBeNull();
    expect(shareEmail('jan')).toBeNull();
  });

  it('link zaproszenia i token z adresu', () => {
    const link = inviteLink('https://app.example/', 'abc123def456ghi789jkl012');
    expect(link).toBe('https://app.example/invite?invite=abc123def456ghi789jkl012');
    expect(inviteTokenFrom(link)).toBe('abc123def456ghi789jkl012');
    expect(inviteTokenFrom('https://app.example/?invite=krotki')).toBeNull();
    expect(inviteTokenFrom('https://app.example/?invite=<script>alert(1)</script>xxxxxxxx')).toBeNull();
    expect(inviteTokenFrom('nie-adres')).toBeNull();
  });

  it('podgląd nie zmienia danych', () => {
    expect(canEditScope('viewer')).toBe(false);
    expect(canEditScope('editor')).toBe(true);
    expect(canEditScope(null)).toBe(true);
  });

  it('dostęp do listy = słabsze z roli i ustawienia listy', () => {
    expect(listAccess('owner', 'hidden')).toBe('edit');
    expect(listAccess(null, 'view')).toBe('edit');
    expect(listAccess('editor', 'edit')).toBe('edit');
    expect(listAccess('editor', 'view')).toBe('view');
    expect(listAccess('editor', 'hidden')).toBe('hidden');
    expect(listAccess('viewer', 'edit')).toBe('view');
    expect(listAccess('viewer', 'hidden')).toBe('hidden');
    expect(canEditList('editor', undefined)).toBe(true);
    expect(canEditList('viewer', 'edit')).toBe(false);
  });

  it('ikona przy liście: właściciel udostępnionej przestrzeni — ustawienie listy, gość — jego dostęp', () => {
    expect(listShareBadge('owner', 'edit', 1)).toBeNull();
    expect(listShareBadge(null, 'hidden', undefined)).toBeNull();
    expect(listShareBadge('owner', 'edit', 2)?.icon).toBe('👥');
    expect(listShareBadge('owner', 'view', 3)?.icon).toBe('👁');
    expect(listShareBadge(null, 'hidden', 2)?.icon).toBe('🔒');
    expect(listShareBadge('editor', 'edit', 2)).toEqual({ icon: '✎', label: 'Udostępniona Ci do edycji' });
    expect(listShareBadge('editor', 'view', 2)?.label).toBe('Udostępniona Ci do podglądu');
    expect(listShareBadge('viewer', 'edit', 2)?.icon).toBe('👁');
    expect(listShareBadge('editor', 'hidden', 2)).toBeNull();
  });
});

describe('właściciele przestrzeni', () => {
  const member = (userId: string, role: SpaceMember['role'], extra: Partial<SpaceMember> = {}): SpaceMember => ({ userId, email: `${userId}@x.pl`, role, me: false, primary: false, ...extra });
  const main = member('a', 'owner', { primary: true });
  const second = member('b', 'owner');
  const editor = member('c', 'editor');

  it('rola głównego właściciela nazwana tylko przy kilku właścicielach', () => {
    expect(memberRoleLabel(main, [main, editor])).toBe('Właściciel');
    expect(memberRoleLabel(main, [main, second])).toBe('Główny właściciel');
    expect(memberRoleLabel(second, [main, second])).toBe('Właściciel');
  });

  it('członkami zarządza właściciel, innym właścicielem — tylko główny', () => {
    expect(canManageMember(main, editor)).toBe(true);
    expect(canManageMember(main, second)).toBe(true);
    expect(canManageMember(second, editor)).toBe(true);
    expect(canManageMember(second, main)).toBe(false);
    expect(canManageMember(main, main)).toBe(false);
    expect(canManageMember(editor, member('d', 'viewer'))).toBe(false);
    expect(canManageMember(undefined, editor)).toBe(false);
  });

  it('następcą może być każdy poza mną', () => {
    expect(ownershipHeirs([{ ...main, me: true }, second, editor]).map((m) => m.userId)).toEqual(['b', 'c']);
  });

  it('pytania mówią, co się stanie z obiema stronami', () => {
    expect(ownerOfferQuestion('b@x.pl', 'Firma', null)).toContain('te same uprawnienia');
    expect(ownerOfferQuestion('b@x.pl', 'Firma', 'leave')).toContain('opuścisz przestrzeń');
    expect(ownerOfferQuestion('b@x.pl', 'Firma', 'editor')).toContain('zostaniesz z rolą Edytor');
    const offer = { workspace: 'Firma', offeredBy: 'a@x.pl', after: 'editor', primary: true } as const;
    expect(ownershipOfferText(offer)).toBe('a@x.pl chce przekazać Ci przestrzeń „Firma” — zrzeka się roli właściciela na Twoją rzecz.');
    expect(ownershipAcceptQuestion(offer)).toContain('głównym właścicielem');
    expect(ownershipAcceptQuestion(offer)).toContain('a@x.pl straci rolę właściciela');
    expect(ownershipAcceptQuestion({ ...offer, after: null, primary: false })).not.toContain('straci');
  });

  it('data dołączenia członka: „od …”, brak daty = null', () => {
    expect(memberSince('2026-11-24T12:00:00Z')).toBe('od 24 lis 2026');
    expect(memberSince(null)).toBeNull();
    expect(memberSince(undefined)).toBeNull();
    expect(memberSince('zła data')).toBeNull();
  });
});
