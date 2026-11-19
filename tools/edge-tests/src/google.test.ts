import { describe, expect, it } from 'vitest';

import { syncWindow } from '../../../supabase/functions/_shared/calendar.ts';
import { authorizationUrl, CALENDAR_SCOPE, CALENDAR_WRITE_SCOPE, ensureAccessToken, GOOGLE_DEFAULTS, idTokenEmail, mapGoogleEvent } from '../../../supabase/functions/_shared/google.ts';

const W = syncWindow(Date.parse('2026-11-18T11:00:00Z'));
const cfg = { clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://x.supabase.co/functions/v1/calendar-sync/google/callback', ...GOOGLE_DEFAULTS };

describe('Google', () => {
  it('adres zgody: offline, prompt=consent, odczyt + zapis tylko w kalendarzach aplikacji', () => {
    const u = new URL(authorizationUrl(cfg, 'st4te'));
    expect(u.origin + u.pathname).toBe(GOOGLE_DEFAULTS.authUrl);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('state')).toBe('st4te');
    expect(u.searchParams.get('scope')!.split(' ')).toContain(CALENDAR_SCOPE);
    expect(u.searchParams.get('scope')!.split(' ')).toContain(CALENDAR_WRITE_SCOPE);
    expect(u.searchParams.get('scope')).not.toMatch(/auth\/calendar(\s|$)/);
  });

  it('e-mail z id_token', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'ja@gmail.com' })).toString('base64url');
    expect(idTokenEmail(`h.${payload}.s`)).toBe('ja@gmail.com');
    expect(idTokenEmail('zly')).toBeNull();
  });

  it('wydarzenia: z godziną, całodniowe, odwołane, poza oknem', () => {
    expect(mapGoogleEvent({ id: 'a', etag: '"1"', summary: 'S', start: { dateTime: '2026-11-20T10:00:00+01:00' }, end: { dateTime: '2026-11-20T11:00:00+01:00' } }, W))
      .toMatchObject({ external_id: 'a', all_day: false, start_at: '2026-11-20T09:00:00.000Z', end_at: '2026-11-20T10:00:00.000Z', etag: '"1"' });
    expect(mapGoogleEvent({ id: 'b', start: { date: '2026-11-24' }, end: { date: '2026-11-25' } }, W))
      .toMatchObject({ all_day: true, start_date: '2026-11-24', end_date: '2026-11-25', title: '' });
    expect(mapGoogleEvent({ id: 'c', status: 'cancelled' }, W)).toBeNull();
    expect(mapGoogleEvent({ id: 'd', start: { dateTime: '2028-01-01T10:00:00Z' }, end: { dateTime: '2028-01-01T11:00:00Z' } }, W)).toBeNull();
  });

  it('token dostępu: ważny bez odświeżania', async () => {
    const now = Date.now();
    const r = await ensureAccessToken(cfg, { refreshToken: 'r', accessToken: 'a', expiresAt: now + 3600_000 }, now);
    expect(r).toMatchObject({ token: 'a', changed: false });
  });
});
