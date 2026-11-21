import { describe, expect, it } from 'vitest';

import { canEditScope, inviteLink, inviteTokenFrom, shareEmail } from '../sharing.ts';

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
});
