import { describe, expect, it } from 'vitest';

import { inviteMatches, invitePattern, isDomainInvite } from '../invites.ts';

describe('zaproszenia', () => {
  it('adres i domena — normalizacja', () => {
    expect(invitePattern('  Jan@Example.COM ')).toBe('jan@example.com');
    expect(invitePattern('@Firma.pl')).toBe('@firma.pl');
  });
  it('złe wzorce', () => {
    for (const bad of ['', 'jan', 'jan@', '@firma', 'jan@@firma.pl', 'jan kowalski@firma.pl', 'jan@firma.pl@x.pl']) expect(invitePattern(bad), bad).toBeNull();
  });
  it('dopasowanie jak hook', () => {
    expect(isDomainInvite('@firma.pl')).toBe(true);
    expect(inviteMatches('@firma.pl', 'Ktos@Firma.pl')).toBe(true);
    expect(inviteMatches('@firma.pl', 'ktos@nie-firma.pl')).toBe(false);
    expect(inviteMatches('@firma.pl', 'ktos@dzial.firma.pl')).toBe(false);
    expect(inviteMatches('jan@example.com', 'JAN@example.com')).toBe(true);
    expect(inviteMatches('jan@example.com', 'anna@example.com')).toBe(false);
  });
});
