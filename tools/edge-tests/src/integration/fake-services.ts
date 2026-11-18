/**
 * Fałszywe usługi zewnętrzne dla testów integracyjnych, osiągalne z kontenera Edge Runtime pod
 * `http://host.docker.internal:54590` (`.env.test`): Google OAuth + Calendar API v3 (calendarList,
 * events.list z `syncToken` i stronicowaniem, watch, channels.stop), plik ICS z ETag, usługa Web Push.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { FAKE_PORT } from '../setup.ts';

export interface FakeEvent {
  id: string;
  summary?: string;
  status?: 'confirmed' | 'cancelled';
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
}

interface StoredEvent extends FakeEvent {
  etag: string;
  version: number;
}

interface FakeCalendar {
  entry: { id: string; summary: string; primary?: boolean; selected?: boolean; backgroundColor?: string };
  events: Map<string, StoredEvent>;
  /** Tokeny synchronizacji starsze niż ta wersja → 410 Gone. */
  invalidBefore: number;
}

export interface FakeChannel {
  id: string;
  calendarId: string;
  address: string;
  token: string;
  resourceId: string;
  expiration: number;
  stopped: boolean;
}

export interface PushRequest {
  id: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  at: number;
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
};

const overlaps = (ev: FakeEvent, min: number, max: number) => {
  const s = Date.parse(ev.start.dateTime ?? `${ev.start.date}T00:00:00Z`);
  const e = Date.parse(ev.end.dateTime ?? `${ev.end.date}T00:00:00Z`);
  return e > min && s < max;
};

export class FakeServices {
  private server: Server | null = null;
  version = 0;
  calendars = new Map<string, FakeCalendar>();
  channels = new Map<string, FakeChannel>();
  accessTokens = new Set<string>();
  refreshTokenRevoked = false;
  expiresIn = 3600;
  pageSize = 3;
  counts = { refresh: 0, exchange: 0, list: 0, watch: 0, stop: 0, revoke: 0 };
  icsFiles = new Map<string, { text: string; etag: string }>();
  icsRequests: { name: string; ifNoneMatch?: string; status: number }[] = [];
  push: PushRequest[] = [];
  pushStatus = new Map<string, number>();
  email = 'tester@gmail.com';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => send(res, 500, { error: String(e) }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(FAKE_PORT, '0.0.0.0', () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Adres usługi push widziany z kontenera funkcji. */
  pushEndpoint(id: string) {
    return `http://host.docker.internal:${FAKE_PORT}/push/${id}`;
  }

  icsUrl(name: string) {
    return `http://host.docker.internal:${FAKE_PORT}/ics/${name}.ics`;
  }

  setIcs(name: string, text: string) {
    this.icsFiles.set(name, { text, etag: `"${Date.now()}-${Math.random().toString(36).slice(2)}"` });
  }

  addCalendar(entry: FakeCalendar['entry'], events: FakeEvent[] = []) {
    const cal: FakeCalendar = { entry, events: new Map(), invalidBefore: 0 };
    this.calendars.set(entry.id, cal);
    for (const e of events) this.upsertEvent(entry.id, e);
  }

  upsertEvent(calendarId: string, ev: FakeEvent) {
    const v = ++this.version;
    this.calendars.get(calendarId)!.events.set(ev.id, { status: 'confirmed', ...ev, etag: `"e${v}"`, version: v });
  }

  deleteEvent(calendarId: string, id: string) {
    const cal = this.calendars.get(calendarId)!;
    const ev = cal.events.get(id)!;
    const v = ++this.version;
    cal.events.set(id, { ...ev, status: 'cancelled', etag: `"e${v}"`, version: v });
  }

  /** Wszystkie dotychczasowe `syncToken` tego kalendarza wygasają (410). */
  invalidateSyncTokens(calendarId: string) {
    this.calendars.get(calendarId)!.invalidBefore = ++this.version;
  }

  activeChannels(calendarId?: string) {
    return [...this.channels.values()].filter((c) => !c.stopped && (!calendarId || c.calendarId === calendarId));
  }

  /** Powiadomienie `watch` tak, jak wysyła je Google (nagłówki X-Goog-*). */
  async notify(calendarId: string, state = 'exists'): Promise<number[]> {
    const out: number[] = [];
    for (const ch of this.activeChannels(calendarId)) {
      const res = await fetch(ch.address, {
        method: 'POST',
        headers: {
          'x-goog-channel-id': ch.id,
          'x-goog-channel-token': ch.token,
          'x-goog-resource-id': ch.resourceId,
          'x-goog-resource-state': state,
          'x-goog-message-number': String(++this.version),
          'x-goog-channel-expiration': new Date(ch.expiration).toUTCString(),
        },
      });
      out.push(res.status);
    }
    return out;
  }

  private authorized(req: IncomingMessage) {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    return !!token && this.accessTokens.has(token);
  }

  private issueAccessToken() {
    const t = `at-${++this.version}`;
    this.accessTokens.add(t);
    return t;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, `http://localhost:${FAKE_PORT}`);
    const path = url.pathname;
    const body = await readBody(req);

    if (path.startsWith('/push/')) {
      const id = path.slice('/push/'.length);
      this.push.push({ id, headers: req.headers, body, at: Date.now() });
      return send(res, this.pushStatus.get(id) ?? 201);
    }

    if (path.startsWith('/ics/')) {
      const name = path.slice('/ics/'.length).replace(/\.ics$/, '');
      const file = this.icsFiles.get(name);
      const inm = req.headers['if-none-match'] as string | undefined;
      if (!file) {
        this.icsRequests.push({ name, ifNoneMatch: inm, status: 404 });
        return send(res, 404, 'brak');
      }
      if (inm && inm === file.etag) {
        this.icsRequests.push({ name, ifNoneMatch: inm, status: 304 });
        res.writeHead(304, { etag: file.etag });
        return res.end();
      }
      this.icsRequests.push({ name, ifNoneMatch: inm, status: 200 });
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', etag: file.etag });
      return res.end(file.text);
    }

    if (path === '/token') {
      const p = new URLSearchParams(body.toString());
      if (p.get('client_id') !== 'fake-client-id' || p.get('client_secret') !== 'fake-client-secret') return send(res, 401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') {
        this.counts.exchange++;
        const code = p.get('code');
        if (code !== 'good-code' && code !== 'no-calendar-scope') return send(res, 400, { error: 'invalid_grant' });
        const idPayload = Buffer.from(JSON.stringify({ email: this.email })).toString('base64url');
        return send(res, 200, {
          access_token: this.issueAccessToken(),
          expires_in: this.expiresIn,
          refresh_token: 'rt-1',
          id_token: `eyJhbGciOiJub25lIn0.${idPayload}.sig`,
          scope: code === 'good-code'
            ? 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly'
            : 'openid https://www.googleapis.com/auth/userinfo.email',
          token_type: 'Bearer',
        });
      }
      if (p.get('grant_type') === 'refresh_token') {
        this.counts.refresh++;
        if (this.refreshTokenRevoked || p.get('refresh_token') !== 'rt-1') return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return send(res, 200, { access_token: this.issueAccessToken(), expires_in: this.expiresIn, token_type: 'Bearer' });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (path === '/revoke') {
      this.counts.revoke++;
      this.refreshTokenRevoked = true;
      return send(res, 200, {});
    }

    if (!path.startsWith('/calendar/v3/')) return send(res, 404, { error: 'nie ma' });
    if (!this.authorized(req)) return send(res, 401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
    const api = path.slice('/calendar/v3'.length);

    if (api === '/users/me/calendarList') {
      return send(res, 200, { items: [...this.calendars.values()].map((c) => c.entry) });
    }
    if (api === '/channels/stop') {
      this.counts.stop++;
      const { id, resourceId } = JSON.parse(body.toString());
      const ch = this.channels.get(id);
      if (!ch || ch.resourceId !== resourceId) return send(res, 404, { error: { code: 404, message: 'Channel not found', errors: [{ reason: 'notFound' }] } });
      ch.stopped = true;
      res.writeHead(204);
      return res.end();
    }
    const m = /^\/calendars\/([^/]+)\/events(\/watch)?$/.exec(api);
    const cal = m && this.calendars.get(decodeURIComponent(m[1]!));
    if (!m || !cal) return send(res, 404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });

    if (m[2]) {
      this.counts.watch++;
      const b = JSON.parse(body.toString());
      const ch: FakeChannel = {
        id: b.id,
        calendarId: cal.entry.id,
        address: b.address,
        token: b.token,
        resourceId: `res-${++this.version}`,
        expiration: Date.now() + Number(b.params?.ttl ?? 604800) * 1000,
        stopped: false,
      };
      this.channels.set(ch.id, ch);
      return send(res, 200, { kind: 'api#channel', id: ch.id, resourceId: ch.resourceId, resourceUri: '…', expiration: String(ch.expiration) });
    }

    this.counts.list++;
    const syncToken = url.searchParams.get('syncToken');
    const pageSize = Math.min(Number(url.searchParams.get('maxResults') ?? 250), this.pageSize);
    const offset = Number(url.searchParams.get('pageToken') ?? 0);
    let items: StoredEvent[];
    if (syncToken) {
      if (url.searchParams.has('timeMin')) return send(res, 400, { error: { code: 400, message: 'timeMin z syncToken' } });
      const [calId, v] = syncToken.split(':');
      if (calId !== cal.entry.id || Number(v) < cal.invalidBefore) {
        return send(res, 410, { error: { code: 410, message: 'Sync token is no longer valid', errors: [{ reason: 'fullSyncRequired' }] } });
      }
      items = [...cal.events.values()].filter((e) => e.version > Number(v));
    } else {
      const min = Date.parse(url.searchParams.get('timeMin')!);
      const max = Date.parse(url.searchParams.get('timeMax')!);
      items = [...cal.events.values()].filter((e) => e.status !== 'cancelled' && overlaps(e, min, max));
    }
    items.sort((a, b) => a.version - b.version);
    const page = items.slice(offset, offset + pageSize);
    const more = offset + pageSize < items.length;
    const out: Record<string, unknown> = { kind: 'calendar#events', items: page.map(({ version: _v, ...e }) => e) };
    if (more) out.nextPageToken = String(offset + pageSize);
    else out.nextSyncToken = `${cal.entry.id}:${this.version}`;
    return send(res, 200, out);
  }
}
