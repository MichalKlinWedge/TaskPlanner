/**
 * ICS (RFC 5545) → wydarzenia w oknie synchronizacji. Własny, mały parser: VEVENT z DTSTART/DTEND/DURATION
 * (data, UTC, czas lokalny z TZID albo pływający), SUMMARY, LOCATION, STATUS, RRULE, EXDATE, RECURRENCE-ID.
 * Powtórzenia rozwija `core/recurrence.ts` (ten sam podzbiór RRULE co zadania); reguła spoza podzbioru →
 * tylko pierwsze wystąpienie i ostrzeżenie. VTIMEZONE pomijane — strefa z TZID (IANA albo nazwa Windows).
 */
import { addDays } from '../../../packages/core/src/dates.ts';
import { occurrences } from '../../../packages/core/src/recurrence.ts';

import { contentEtag, overlapsWindow, type EventRow, type SyncWindow } from './calendar.ts';
import { DAY_MS, isValidZone, zonedParts, zonedToInstant } from './time.ts';

export type IcsTime =
  | { kind: 'date'; date: string }
  | { kind: 'utc'; ms: number }
  | { kind: 'local'; date: string; time: string; zone: string | null };

export interface IcsEvent {
  uid: string;
  summary: string;
  location: string | null;
  status: string | null;
  start: IcsTime;
  end: IcsTime | null;
  durationMs: number | null;
  rrule: string | null;
  exdates: IcsTime[];
  recurrenceId: IcsTime | null;
}

export interface IcsCalendar {
  name: string | null;
  zone: string | null;
  events: IcsEvent[];
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

// Najczęstsze nazwy stref z Outlook / Exchange.
const WINDOWS_ZONES: Record<string, string> = {
  'Central European Standard Time': 'Europe/Warsaw',
  'Central Europe Standard Time': 'Europe/Budapest',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'FLE Standard Time': 'Europe/Kiev',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
};

export function resolveZone(tzid: string | undefined | null): string | null {
  if (!tzid) return null;
  const clean = tzid.replace(/^"|"$/g, '').replace(/^\/[^/]*\/[^/]*\//, ''); // „/mozilla.org/20050126_1/Europe/Warsaw”
  const zone = WINDOWS_ZONES[clean] ?? clean;
  return isValidZone(zone) ? zone : null;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line: string): Property | null {
  // Dwukropek w parametrze w cudzysłowie (TZID="…") nie kończy nazwy.
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...rawParams] = head.split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name!.toUpperCase(), params, value };
}

const unescapeText = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

function parseTime(prop: Property, value = prop.value): IcsTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || prop.params.VALUE === 'DATE') return { kind: 'date', date };
  const time = `${m[4]}:${m[5]}:${m[6]}`;
  if (m[7]) return { kind: 'utc', ms: Date.parse(`${date}T${time}Z`) };
  return { kind: 'local', date, time, zone: resolveZone(prop.params.TZID) };
}

function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  const ms = ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

export function parseIcs(text: string): IcsCalendar {
  const cal: IcsCalendar = { name: null, zone: null, events: [] };
  const stack: string[] = [];
  let ev: Partial<IcsEvent> | null = null;
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      stack.push(prop.value.toUpperCase());
      if (prop.value.toUpperCase() === 'VEVENT' && stack.length === 2) ev = { exdates: [], rrule: null, recurrenceId: null, end: null, durationMs: null };
      continue;
    }
    if (prop.name === 'END') {
      const closed = stack.pop();
      if (closed === 'VEVENT' && ev && stack.length === 1) {
        if (ev.uid && ev.start) {
          cal.events.push({
            uid: ev.uid,
            summary: ev.summary ?? '',
            location: ev.location ?? null,
            status: ev.status ?? null,
            start: ev.start,
            end: ev.end ?? null,
            durationMs: ev.durationMs ?? null,
            rrule: ev.rrule ?? null,
            exdates: ev.exdates ?? [],
            recurrenceId: ev.recurrenceId ?? null,
          });
        }
        ev = null;
      }
      continue;
    }
    const where = stack.at(-1);
    if (where === 'VCALENDAR') {
      if (prop.name === 'X-WR-CALNAME') cal.name = unescapeText(prop.value);
      if (prop.name === 'X-WR-TIMEZONE') cal.zone = resolveZone(prop.value);
      continue;
    }
    if (where !== 'VEVENT' || !ev) continue;
    switch (prop.name) {
      case 'UID': ev.uid = prop.value.trim(); break;
      case 'SUMMARY': ev.summary = unescapeText(prop.value); break;
      case 'LOCATION': ev.location = unescapeText(prop.value) || null; break;
      case 'STATUS': ev.status = prop.value.trim().toUpperCase(); break;
      case 'DTSTART': ev.start = parseTime(prop) ?? undefined; break;
      case 'DTEND': ev.end = parseTime(prop); break;
      case 'DURATION': ev.durationMs = parseDuration(prop.value); break;
      case 'RRULE': ev.rrule = prop.value.trim(); break;
      case 'RECURRENCE-ID': ev.recurrenceId = parseTime(prop); break;
      case 'EXDATE':
        for (const v of prop.value.split(',')) {
          const t = parseTime(prop, v);
          if (t) ev.exdates!.push(t);
        }
        break;
    }
  }
  return cal;
}

// ── Rozwinięcie do wierszy ───────────────────────────────────────────────────────────────────

export interface ExpandResult {
  events: EventRow[];
  warnings: string[];
}

/** Data lokalna i godzina wydarzenia w jego strefie (pływające i UTC — w strefie domyślnej). */
function localOf(t: IcsTime, zone: string): { date: string; time: string } {
  if (t.kind === 'date') return { date: t.date, time: '00:00:00' };
  if (t.kind === 'local') return { date: t.date, time: t.time };
  const p = zonedParts(t.ms, zone);
  return { date: p.date, time: `${p.time}:${String(p.second).padStart(2, '0')}` };
}

function instantOf(t: IcsTime, defaultZone: string): number {
  if (t.kind === 'utc') return t.ms;
  if (t.kind === 'date') return zonedToInstant(t.date, '00:00', defaultZone);
  return zonedToInstant(t.date, t.time, t.zone ?? defaultZone);
}

/** Strefa, w której liczy się powtarzanie (czas ścienny wystąpień). */
const eventZone = (ev: IcsEvent, defaultZone: string) => (ev.start.kind === 'local' && ev.start.zone) || defaultZone;

function row(ev: IcsEvent, externalId: string, start: IcsTime, defaultZone: string, lengthMs: number, lengthDays: number): EventRow {
  const base = {
    external_id: externalId,
    title: ev.summary,
    location: ev.location,
  };
  let out: Omit<EventRow, 'etag'>;
  if (start.kind === 'date') {
    out = { ...base, all_day: true, start_at: null, end_at: null, start_date: start.date, end_date: addDays(start.date, Math.max(1, lengthDays)) };
  } else {
    const startMs = instantOf(start, defaultZone);
    out = { ...base, all_day: false, start_at: new Date(startMs).toISOString(), end_at: new Date(startMs + Math.max(0, lengthMs)).toISOString(), start_date: null, end_date: null };
  }
  return { ...out, etag: contentEtag(out) };
}

function length(ev: IcsEvent, defaultZone: string): { ms: number; days: number } {
  if (ev.start.kind === 'date') {
    if (ev.end?.kind === 'date') return { ms: 0, days: Math.round((Date.parse(ev.end.date) - Date.parse(ev.start.date)) / DAY_MS) };
    if (ev.durationMs != null) return { ms: 0, days: Math.max(1, Math.round(ev.durationMs / DAY_MS)) };
    return { ms: 0, days: 1 };
  }
  if (ev.end) return { ms: instantOf(ev.end, defaultZone) - instantOf(ev.start, defaultZone), days: 0 };
  return { ms: ev.durationMs ?? 0, days: 0 };
}

/**
 * RRULE z ICS → podzbiór `core`: UNTIL z godziną → data lokalna w strefie wydarzenia, WKST tylko dla
 * INTERVAL > 1 (przy 1 nie ma znaczenia).
 */
function normalizeRrule(rrule: string, zone: string): string {
  const parts = rrule.split(';').filter(Boolean);
  const interval = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1);
  return parts
    .map((p) => {
      const [k, v = ''] = p.split('=');
      if (k === 'UNTIL') {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
        if (m) return `UNTIL=${zonedParts(Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`), zone).date.replaceAll('-', '')}`;
      }
      if (k === 'WKST' && interval === 1) return null;
      return p;
    })
    .filter((p): p is string => p !== null)
    .join(';');
}

export function expandIcs(cal: IcsCalendar, window: SyncWindow, fallbackZone = 'Europe/Warsaw'): ExpandResult {
  const defaultZone = cal.zone ?? fallbackZone;
  const warnings: string[] = [];
  const out = new Map<string, EventRow>();
  const masters = cal.events.filter((e) => !e.recurrenceId);
  const overrides = new Map<string, IcsEvent[]>();
  for (const e of cal.events.filter((e) => e.recurrenceId)) {
    overrides.set(e.uid, [...(overrides.get(e.uid) ?? []), e]);
  }
  const push = (r: EventRow) => {
    if (overlapsWindow(r, window)) out.set(r.external_id, r);
  };

  for (const ev of masters) {
    if (ev.status === 'CANCELLED') continue;
    const len = length(ev, defaultZone);
    if (!ev.rrule) {
      push(row(ev, ev.uid, ev.start, defaultZone, len.ms, len.days));
      continue;
    }
    const zone = eventZone(ev, defaultZone);
    const anchor = localOf(ev.start, zone);
    const excluded = new Set(ev.exdates.map((t) => localOf(t, zone).date));
    const replaced = new Map<string, IcsEvent>();
    for (const o of overrides.get(ev.uid) ?? []) replaced.set(localOf(o.recurrenceId!, zone).date, o);

    let dates: string[];
    try {
      const from = zonedParts(window.fromMs - Math.max(len.ms, len.days * DAY_MS) - DAY_MS, zone).date;
      const to = zonedParts(window.toMs, zone).date;
      dates = occurrences({ mode: 'schedule', rrule: normalizeRrule(ev.rrule, zone), anchor: anchor.date }, { from, to, limit: 2000 });
      // RFC 5545: DTSTART jest zawsze pierwszym wystąpieniem (core pomija kotwicę spoza reguły).
      if (anchor.date >= from && anchor.date <= to && !dates.includes(anchor.date)) dates.unshift(anchor.date);
    } catch (error) {
      warnings.push(`${ev.uid}: ${(error as Error).message} — tylko pierwsze wystąpienie`);
      dates = [anchor.date];
    }
    for (const date of dates) {
      if (excluded.has(date)) continue;
      const id = `${ev.uid}/${date}`;
      const o = replaced.get(date);
      if (o) {
        if (o.status === 'CANCELLED') continue;
        const ol = length(o, defaultZone);
        push(row(o, id, o.start, defaultZone, ol.ms, ol.days));
        continue;
      }
      const start: IcsTime =
        ev.start.kind === 'date'
          ? { kind: 'date', date }
          : { kind: 'local', date, time: anchor.time, zone };
      push(row(ev, id, start, defaultZone, len.ms, len.days));
    }
  }
  // Zmienione wystąpienie bez serii w pliku (np. zaproszenie na jedno wystąpienie).
  for (const [uid, list] of overrides) {
    if (masters.some((m) => m.uid === uid)) continue;
    for (const o of list) {
      if (o.status === 'CANCELLED') continue;
      const ol = length(o, defaultZone);
      push(row(o, `${uid}/${localOf(o.recurrenceId!, eventZone(o, defaultZone)).date}`, o.start, defaultZone, ol.ms, ol.days));
    }
  }
  return { events: [...out.values()], warnings };
}
