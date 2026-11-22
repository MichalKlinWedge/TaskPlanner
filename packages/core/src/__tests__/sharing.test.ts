import { describe, expect, it } from 'vitest';

import { canEditList, canEditScope, inviteLink, inviteTokenFrom, listAccess, listShareBadge, shareEmail } from '../sharing.ts';

describe('współdzielenie przestrzeni', () => {
  it('adres zapraszanej osoby: normalizacja, bez domen', () => {
    expect(shareEmail('  Jan@Example.COM ')).toBe('jan@example.com');
    expect(shareEmail('@firma.pl')).toBeNull();
    expect(shareEmail('jan')).toBeNull();
  });

  it('link zaproszenia i token z adresu', () => {
    const link = inviteLink('https://app.example/', 'abc123def456ghi789jkl012');
    expect(link).toBe('https://app.example/?invite=abc123def456ghi789jkl012');
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
