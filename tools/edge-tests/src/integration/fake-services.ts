/**
 * Fałszywe usługi zewnętrzne dla testów integracyjnych, osiągalne z kontenera Edge Runtime pod
 * `http://host.docker.internal:54590` (`.env.test`): Google OAuth + Calendar API v3 (calendarList,
 * events.list z `syncToken` i stronicowaniem, watch, channels.stop; Etap 12: calendars.insert, events
 * insert/get/patch/delete z `If-Match` → 412, zajęty id → 409, usunięte → 410), plik ICS z ETag, usługa Web Push,
 * odbiorca webhooków pluginów (`/hooks/<nazwa>`, M21), GitLab REST API v4 pod `/gitlab/api/v4/…` (plugin I3),
 * Gemini API pod `/gemini/v1beta/…` (asystent AI: klucz w `x-goog-api-key`, zły klucz → 400 `INVALID_ARGUMENT`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { FAKE_PORT } from '../setup.ts';

export interface FakeEvent {
  id: string;
  summary?: string;
  status?: 'confirmed' | 'cancelled';
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  description?: string;
  extendedProperties?: { private?: Record<string, string> };
  reminders?: unknown;
}

export interface StoredEvent extends FakeEvent {
  etag: string;
  version: number;
  updated: string;
}

/** Zapis przez API (Etap 12) — do sprawdzania, ile i czego aplikacja wysłała. */
export interface ApiWrite {
  method: 'insert' | 'patch' | 'delete';
  calendarId: string;
  eventId: string;
  ifMatch?: string;
  status: number;
}

interface FakeCalendar {
  entry: { id: string; summary: string; primary?: boolean; selected?: boolean; backgroundColor?: string; description?: string; timeZone?: string; accessRole?: string };
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

export interface HookRequest {
  name: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  status: number;
  at: number;
}

/** Issue fałszywego GitLaba (plugin I3). */
export interface FakeIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  labels: string[];
  due_date: string | null;
  assignee_ids: number[];
  state: 'opened' | 'closed';
  web_url: string;
  notes: string[];
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
  counts = { refresh: 0, exchange: 0, list: 0, watch: 0, stop: 0, revoke: 0, createCalendar: 0 };
  writes: ApiWrite[] = [];
  /** Zmiana „w Google” tuż przed zapisem aplikacji (wyścig: zapis z `If-Match` dostaje 412). */
  beforeWrite = new Map<string, () => void>();
  icsFiles = new Map<string, { text: string; etag: string }>();
  icsRequests: { name: string; ifNoneMatch?: string; status: number }[] = [];
  push: PushRequest[] = [];
  pushStatus = new Map<string, number>();
  email = 'tester@gmail.com';
  /** Odbiorca webhooków (pluginy, M21): `/hooks/<nazwa>` — zapisuje każde żądanie; odpowiedź z `hookReplies` (domyślnie 200). */
  hooks: HookRequest[] = [];
  hookReplies = new Map<string, { status: number; headers?: Record<string, string>; delayMs?: number; body?: string; location?: string }>();
  /** Strony dla `link-preview` (Etap 10): `/pages/<nazwa>`; `delayMs` — odpowiedź po czasie. */
  pages = new Map<string, { status?: number; headers?: Record<string, string>; body?: string | Buffer; delayMs?: number }>();
  /** GitLab (plugin I3): jeden projekt `grupa/projekt` (id 77), token `glpat-test-token`; `gitlabStatus` — wymuszona odpowiedź. */
  gitlab = {
    projectId: 77,
    path: 'grupa/projekt',
    token: 'glpat-test-token',
    users: [{ id: 501, username: 'jan.kowalski' }],
    issues: [] as FakeIssue[],
    requests: [] as { method: string; path: string }[],
    status: null as number | null,
  };

  /**
   * Gemini (asystent AI, v1.x): klucz `gemini.key` (format nowych auth keys, zmyślony) w nagłówku `x-goog-api-key`;
   * inny klucz → 400 `INVALID_ARGUMENT` „API key not valid” jak u Google; klucz w adresie (`?key=`) → 400 i wpis
   * w `requests` (test pilnuje, że go tam nie ma); `status` — wymuszona odpowiedź (np. 503 przeciążenie).
   */
  gemini = {
    key: `AQ.${'FakeGeminiKey0'.repeat(3)}fakeGemi`,
    models: [
      { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-3.5-flash-lite-preview', displayName: 'Gemini 3.5 Flash-Lite Preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', displayName: 'Gemini Embedding', supportedGenerationMethods: ['embedContent'] },
    ],
    requests: [] as { method: string; path: string; search: string; key: string | null }[],
    /** Treści zapytań `generateContent` i kolejne odpowiedzi modelu (bez wpisu — `{"ok":true}`). */
    prompts: [] as { model: string; system: string; text: string }[],
    answers: [] as string[],
    status: null as number | null,
  };

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

  /** Adres odbiorcy webhooków widziany z kontenera funkcji. */
  hookUrl(name: string) {
    return `http://host.docker.internal:${FAKE_PORT}/hooks/${name}`;
  }

  hooksFor(name: string) {
    return this.hooks.filter((h) => h.name === name);
  }

  /** Adres fałszywego GitLaba widziany z kontenera funkcji. */
  gitlabUrl() {
    return `http://host.docker.internal:${FAKE_PORT}/gitlab`;
  }

  /** Adres strony testowej widziany z kontenera funkcji. */
  pageUrl(name: string) {
    return `http://host.docker.internal:${FAKE_PORT}/pages/${name}`;
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
    this.calendars.get(calendarId)!.events.set(ev.id, { status: 'confirmed', ...ev, etag: `"e${v}"`, version: v, updated: new Date().toISOString() });
  }

  /** Zmiana w interfejsie Google: pozostałe pola (także `extendedProperties`) zostają. */
  editEvent(calendarId: string, id: string, patch: Partial<FakeEvent>) {
    const cal = this.calendars.get(calendarId)!;
    const ev = cal.events.get(id)!;
    this.upsertEvent(calendarId, { ...ev, ...patch, id });
  }

  deleteEvent(calendarId: string, id: string) {
    const cal = this.calendars.get(calendarId)!;
    const ev = cal.events.get(id)!;
    const v = ++this.version;
    cal.events.set(id, { ...ev, status: 'cancelled', etag: `"e${v}"`, version: v, updated: new Date().toISOString() });
  }

  /** Kalendarz po nazwie (np. „Task Planner” utworzony przez aplikację). */
  calendarByName(summary: string) {
    return [...this.calendars.values()].find((c) => c.entry.summary === summary);
  }

  liveEvents(calendarId: string) {
    return [...(this.calendars.get(calendarId)?.events.values() ?? [])].filter((e) => e.status !== 'cancelled');
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

  private gitlabApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL, raw: Buffer) {
    const g = this.gitlab;
    const method = req.method ?? 'GET';
    g.requests.push({ method, path });
    if (req.headers['private-token'] !== g.token) return send(res, 401, { message: '401 Unauthorized' });
    if (g.status) return send(res, g.status, { message: `${g.status} wymuszone` });
    const body = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
    if (path === '/users') return send(res, 200, g.users.filter((u) => u.username === url.searchParams.get('username')));
    const m = /^\/projects\/([^/]+)(\/issues(?:\/(\d+)(\/notes)?)?)?$/.exec(path);
    const ref = m ? decodeURIComponent(m[1]!) : '';
    if (!m || (ref !== g.path && ref !== String(g.projectId))) return send(res, 404, { message: '404 Project Not Found' });
    if (!m[2]) return send(res, 200, { id: g.projectId, path_with_namespace: g.path, web_url: `https://gitlab.test/${g.path}` });
    if (!m[3]) {
      if (method === 'GET') {
        const q = url.searchParams.get('search') ?? '';
        return send(res, 200, g.issues.filter((i) => i.description.includes(q)));
      }
      const iid = g.issues.length + 1;
      const issue: FakeIssue = {
        id: 1000 + iid,
        iid,
        project_id: g.projectId,
        title: String(body.title ?? ''),
        description: String(body.description ?? ''),
        labels: String(body.labels ?? '').split(',').filter(Boolean),
        due_date: (body.due_date as string | undefined) ?? null,
        assignee_ids: (body.assignee_ids as number[] | undefined) ?? [],
        state: 'opened',
        web_url: `https://gitlab.test/${g.path}/-/issues/${iid}`,
        notes: [],
      };
      g.issues.push(issue);
      return send(res, 201, issue);
    }
    const issue = g.issues.find((i) => i.iid === Number(m[3]));
    if (!issue) return send(res, 404, { message: '404 Not found' });
    if (m[4]) {
      issue.notes.push(String(body.body ?? ''));
      return send(res, 201, { id: issue.notes.length, body: body.body });
    }
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.description === 'string') issue.description = body.description;
    if (typeof body.labels === 'string') issue.labels = body.labels.split(',').filter(Boolean);
    if ('due_date' in body) issue.due_date = (body.due_date as string | null) ?? null;
    if (Array.isArray(body.assignee_ids)) issue.assignee_ids = body.assignee_ids as number[];
    if (body.state_event === 'close') issue.state = 'closed';
    if (body.state_event === 'reopen') issue.state = 'opened';
    return send(res, 200, issue);
  }

  private geminiApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL, body: Buffer) {
    const g = this.gemini;
    const header = req.headers['x-goog-api-key'];
    const key = typeof header === 'string' ? header : null;
    g.requests.push({ method: req.method ?? '', path, search: url.search, key });
    if (url.searchParams.has('key')) return send(res, 400, { error: { code: 400, message: 'Klucz w adresie — fałszywy Gemini go nie przyjmuje.', status: 'INVALID_ARGUMENT' } });
    if (key !== g.key) {
      return send(res, 400, {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
        },
      });
    }
    if (g.status) return send(res, g.status, { error: { code: g.status, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } });
    if (req.method === 'GET' && path === '/models') return send(res, 200, { models: g.models });
    const ask = /^\/models\/([^/:]+):generateContent$/.exec(path);
    if (req.method === 'POST' && ask) {
      if (!g.models.some((m) => m.name === `models/${ask[1]}`)) return send(res, 404, { error: { code: 404, message: `models/${ask[1]} is not found for API version v1beta`, status: 'NOT_FOUND' } });
      const asked = JSON.parse(body.toString('utf8')) as { systemInstruction?: { parts: { text: string }[] }; contents: { parts: { text?: string }[] }[] };
      g.prompts.push({ model: ask[1]!, system: asked.systemInstruction?.parts[0]?.text ?? '', text: asked.contents[0]?.parts.map((p) => p.text ?? '').join('') ?? '' });
      return send(res, 200, { candidates: [{ content: { parts: [{ text: g.answers.shift() ?? '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } });
    }
    return send(res, 404, { error: { code: 404, message: 'nie ma', status: 'NOT_FOUND' } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, `http://localhost:${FAKE_PORT}`);
    const path = url.pathname;
    const body = await readBody(req);

    if (path.startsWith('/hooks/')) {
      const name = path.slice('/hooks/'.length);
      const reply = this.hookReplies.get(name) ?? { status: 200 };
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      this.hooks.push({ name, method: req.method ?? '', headers: req.headers, body: body.toString('utf8'), status: reply.status, at: Date.now() });
      return send(res, reply.status, reply.body ?? { ok: reply.status < 300 }, { ...(reply.location && { location: reply.location }), ...reply.headers });
    }

    if (path.startsWith('/gemini/v1beta/')) return this.geminiApi(req, res, path.slice('/gemini/v1beta'.length), url, body);

    if (path.startsWith('/gitlab/api/v4/')) return this.gitlabApi(req, res, path.slice('/gitlab/api/v4'.length), url, body);

    if (path.startsWith('/push/')) {
      const id = path.slice('/push/'.length);
      this.push.push({ id, headers: req.headers, body, at: Date.now() });
      return send(res, this.pushStatus.get(id) ?? 201);
    }

    if (path.startsWith('/pages/')) {
      const page = this.pages.get(path.slice('/pages/'.length));
      if (!page) return send(res, 404, 'nie ma', { 'content-type': 'text/plain' });
      if (page.delayMs) await new Promise((r) => setTimeout(r, page.delayMs));
      if (res.destroyed) return;
      res.writeHead(page.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...page.headers });
      return res.end(page.body ?? '');
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
        if (code !== 'good-code' && code !== 'no-calendar-scope' && code !== 'read-only-code') return send(res, 400, { error: 'invalid_grant' });
        const idPayload = Buffer.from(JSON.stringify({ email: this.email })).toString('base64url');
        return send(res, 200, {
          access_token: this.issueAccessToken(),
          expires_in: this.expiresIn,
          refresh_token: 'rt-1',
          id_token: `eyJhbGciOiJub25lIn0.${idPayload}.sig`,
          scope: code === 'good-code'
            ? 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.app.created'
            : code === 'read-only-code'
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
    if (api === '/calendars' && req.method === 'POST') {
      this.counts.createCalendar++;
      const b = JSON.parse(body.toString());
      const id = `tp${++this.version}@group.calendar.google.com`;
      this.addCalendar({ id, summary: b.summary, description: b.description, timeZone: b.timeZone, accessRole: 'owner', selected: true });
      return send(res, 200, { kind: 'calendar#calendar', id, summary: b.summary, description: b.description, timeZone: b.timeZone });
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
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(api);
    const cal = m && this.calendars.get(decodeURIComponent(m[1]!));
    if (!m || !cal) return send(res, 404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });

    const eventId = m[2] && m[2] !== 'watch' ? decodeURIComponent(m[2]) : null;
    if (eventId || (req.method === 'POST' && !m[2])) return this.eventWrite(req, res, cal, eventId, body);

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
    const cancelledMinimal = (e: StoredEvent) => (e.status === 'cancelled' ? ({ id: e.id, status: e.status, etag: e.etag, version: e.version } as StoredEvent) : e);
    if (syncToken) {
      if (url.searchParams.has('timeMin')) return send(res, 400, { error: { code: 400, message: 'timeMin z syncToken' } });
      const [calId, v] = syncToken.split(':');
      if (calId !== cal.entry.id || Number(v) < cal.invalidBefore) {
        return send(res, 410, { error: { code: 410, message: 'Sync token is no longer valid', errors: [{ reason: 'fullSyncRequired' }] } });
      }
      // Jak Google: usunięte w przyroście to sam identyfikator i status.
      items = [...cal.events.values()].filter((e) => e.version > Number(v)).map(cancelledMinimal);
    } else if (url.searchParams.has('timeMin')) {
      const min = Date.parse(url.searchParams.get('timeMin')!);
      const max = Date.parse(url.searchParams.get('timeMax')!);
      items = [...cal.events.values()].filter((e) => e.status !== 'cancelled' && overlaps(e, min, max));
    } else {
      items = [...cal.events.values()].filter((e) => e.status !== 'cancelled');
    }
    items.sort((a, b) => a.version - b.version);
    const page = items.slice(offset, offset + pageSize);
    const more = offset + pageSize < items.length;
    const out: Record<string, unknown> = { kind: 'calendar#events', items: page.map(({ version: _v, ...e }) => e) };
    if (more) out.nextPageToken = String(offset + pageSize);
    else out.nextSyncToken = `${cal.entry.id}:${this.version}`;
    return send(res, 200, out);
  }

  /** events.insert / get / patch / delete jak w Calendar API v3 (ETag, If-Match, 409, 410). */
  private eventWrite(req: IncomingMessage, res: ServerResponse, cal: FakeCalendar, eventId: string | null, body: Buffer) {
    const err = (code: number, message: string, reason: string) => send(res, code, { error: { code, message, errors: [{ reason }] } });
    const ifMatch = req.headers['if-match'] as string | undefined;
    const out = ({ version: _v, ...e }: StoredEvent) => e;
    const log = (method: ApiWrite['method'], id: string, status: number) => this.writes.push({ method, calendarId: cal.entry.id, eventId: id, ifMatch, status });
    if (req.method === 'POST') {
      const b = JSON.parse(body.toString()) as FakeEvent;
      const id = b.id ?? `g${++this.version}`;
      if (!/^[a-v0-9]{5,1024}$/.test(id)) {
        log('insert', id, 400);
        return err(400, 'Invalid resource id value.', 'invalid');
      }
      if (cal.events.has(id)) {
        log('insert', id, 409);
        return err(409, 'The requested identifier already exists.', 'duplicate');
      }
      this.upsertEvent(cal.entry.id, { ...b, id });
      log('insert', id, 200);
      return send(res, 200, out(cal.events.get(id)!));
    }
    const hook = req.method !== 'GET' ? this.beforeWrite.get(eventId!) : undefined;
    if (hook) {
      this.beforeWrite.delete(eventId!);
      hook();
    }
    const ev = cal.events.get(eventId!);
    if (req.method === 'GET') return ev ? send(res, 200, out(ev)) : err(404, 'Not Found', 'notFound');
    const method = req.method === 'DELETE' ? 'delete' : 'patch';
    if (!ev) {
      log(method, eventId!, 404);
      return err(404, 'Not Found', 'notFound');
    }
    if (ifMatch && ifMatch !== ev.etag) {
      log(method, eventId!, 412);
      return err(412, 'Precondition Failed', 'conditionNotMet');
    }
    if (req.method === 'DELETE') {
      if (ev.status === 'cancelled') {
        log('delete', eventId!, 410);
        return err(410, 'Resource has been deleted', 'deleted');
      }
      this.deleteEvent(cal.entry.id, eventId!);
      log('delete', eventId!, 204);
      res.writeHead(204, { 'content-length': '0' });
      return res.end();
    }
    if (req.method === 'PATCH') {
      const b = JSON.parse(body.toString()) as Partial<FakeEvent>;
      this.upsertEvent(cal.entry.id, { ...ev, ...b, id: ev.id, extendedProperties: b.extendedProperties ?? ev.extendedProperties });
      log('patch', eventId!, 200);
      return send(res, 200, out(cal.events.get(eventId!)!));
    }
    return err(405, 'Method not allowed', 'notAllowed');
  }
}
