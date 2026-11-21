/**
 * Lista zaproszonych (v1.x, Ustawienia → „Zaproszenia”): wzorzec to dokładny adres e-mail albo cała
 * domena („@firma.pl”). Te same reguły co `check` tabeli `allowed_emails` i hook
 * `hook_before_user_created` (migracje `*_v1x_signup_allowlist.sql`, `*_v1x_invites_admin.sql`).
 */

const PATTERN = /^[^@\s]*@[^@\s]+\.[^@\s]+$/;

/** Wzorzec po normalizacji (małe litery, bez spacji) albo `null`, gdy nie jest adresem ani domeną. */
export function invitePattern(input: string): string | null {
  const pattern = input.trim().toLowerCase();
  return PATTERN.test(pattern) ? pattern : null;
}

/** Czy wzorzec obejmuje całą domenę. */
export const isDomainInvite = (pattern: string): boolean => pattern.startsWith('@');

/** Czy adres pasuje do wzorca (jak hook: dokładny adres albo koniec adresu = „@domena”). */
export function inviteMatches(pattern: string, email: string): boolean {
  const address = email.trim().toLowerCase();
  return isDomainInvite(pattern) ? address.endsWith(pattern) : address === pattern;
}
