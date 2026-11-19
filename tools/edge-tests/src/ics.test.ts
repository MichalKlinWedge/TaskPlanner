import { describe, expect, it } from 'vitest';

import { syncWindow } from '../../../supabase/functions/_shared/calendar.ts';
import { expandIcs, parseIcs, resolveZone } from '../../../supabase/functions/_shared/ics.ts';
import { zonedToInstant } from '../../../supabase/functions/_shared/time.ts';

const NOW = Date.parse('2026-11-18T11:00:00Z');
const W = syncWindow(NOW);

const ics = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Praca', 'X-WR-TIMEZONE:Europe/Warsaw', ...events, 'END:VCALENDAR'].join('\r\n');

const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');

const byId = (text: string) => Object.fromEntries(expandIcs(parseIcs(text), W).events.map((e) => [e.external_id, e]));

describe('parseIcs', () => {
  it('składa zawinięte linie, odkodowuje tekst, pomija VALARM i VTIMEZONE', () => {
    const cal = parseIcs(ics(
      'BEGIN:VTIMEZONE', 'TZID:Europe/Warsaw', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'END:STANDARD', 'END:VTIMEZONE',
      vevent('UID:a@google.com', 'DTSTART;TZID=Europe/Warsaw:20261120T100000', 'DTEND;TZID=Europe/Warsaw:20261120T113000',
        'SUMMARY:Przegląd\\, kwartalny\\; ', ' sala 2', 'LOCATION:Warszawa\\nul. Prosta 1',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Nie to', 'END:VALARM'),
    ));
    expect(cal.name).toBe('Praca');
    expect(cal.zone).toBe('Europe/Warsaw');
    expect(cal.events).toHaveLength(1);
    expect(cal.events[0]).toMatchObject({ uid: 'a@google.com', summary: 'Przegląd, kwartalny; sala 2', location: 'Warszawa\nul. Prosta 1' });
  });

  it('strefy: IANA, Windows, prefiks mozilla, nieznana → null', () => {
    expect(resolveZone('Europe/Warsaw')).toBe('Europe/Warsaw');
    expect(resolveZone('Central European Standard Time')).toBe('Europe/Warsaw');
    expect(resolveZone('/mozilla.org/20050126_1/Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveZone('"Europe/Paris"')).toBe('Europe/Paris');
    expect(resolveZone('Mars/Olympus')).toBeNull();
  });
});

describe('expandIcs', () => {
  it('wydarzenie z TZID, UTC i całodniowe', () => {
    const e = byId(ics(
      vevent('UID:tz', 'DTSTART;TZID=Europe/Warsaw:20261120T100000', 'DTEND;TZID=Europe/Warsaw:20261120T113000', 'SUMMARY:Spotkanie'),
      vevent('UID:utc', 'DTSTART:20261121T090000Z', 'DURATION:PT45M', 'SUMMARY:Rozmowa'),
      vevent('UID:day', 'DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261126', 'SUMMARY:Urlop'),
      vevent('UID:win', 'DTSTART;TZID=W. Europe Standard Time:20261120T090000', 'DTEND;TZID=W. Europe Standard Time:20261120T100000', 'SUMMARY:Berlin'),
    ));
    expect(e.tz).toMatchObject({ all_day: false, start_at: '2026-11-20T09:00:00.000Z', end_at: '2026-11-20T10:30:00.000Z', title: 'Spotkanie' });
    expect(e.utc).toMatchObject({ start_at: '2026-11-21T09:00:00.000Z', end_at: '2026-11-21T09:45:00.000Z' });
    expect(e.day).toMatchObject({ all_day: true, start_date: '2026-11-24', end_date: '2026-11-26', start_at: null });
    // Nazwa strefy z Outlooka: 9:00 w Berlinie = 8:00 UTC.
    expect(e.win).toMatchObject({ start_at: '2026-11-20T08:00:00.000Z' });
  });

  it('pomija wydarzenia poza oknem −30…+180 dni i odwołane', () => {
    const e = byId(ics(
      vevent('UID:old', 'DTSTART:20260901T090000Z', 'DTEND:20260901T100000Z'),
      vevent('UID:far', 'DTSTART:20270801T090000Z', 'DTEND:20270801T100000Z'),
      vevent('UID:cancel', 'DTSTART:20261125T090000Z', 'DTEND:20261125T100000Z', 'STATUS:CANCELLED'),
      vevent('UID:ok', 'DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z'),
    ));
    expect(Object.keys(e)).toEqual(['ok']);
  });

  it('seria tygodniowa w strefie: czas ścienny stały przez zmianę czasu, EXDATE, przeniesione i odwołane wystąpienie', () => {
    const e = byId(ics(
      vevent('UID:weekly', 'DTSTART;TZID=Europe/Warsaw:20261012T180000', 'DTEND;TZID=Europe/Warsaw:20261012T183000',
        'RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO;UNTIL=20261207T165959Z', 'EXDATE;TZID=Europe/Warsaw:20261116T180000', 'SUMMARY:Daily'),
      vevent('UID:weekly', 'RECURRENCE-ID;TZID=Europe/Warsaw:20261123T180000', 'DTSTART;TZID=Europe/Warsaw:20261124T120000',
        'DTEND;TZID=Europe/Warsaw:20261124T123000', 'SUMMARY:Daily (wtorek)'),
      vevent('UID:weekly', 'RECURRENCE-ID;TZID=Europe/Warsaw:20261130T180000', 'DTSTART;TZID=Europe/Warsaw:20261130T180000', 'STATUS:CANCELLED'),
    ));
    expect(Object.keys(e).sort()).toEqual([
      'weekly/2026-10-19', 'weekly/2026-10-26', 'weekly/2026-11-02', 'weekly/2026-11-09', 'weekly/2026-11-23', 'weekly/2026-12-07',
    ]);
    expect(e['weekly/2026-10-19']!.start_at).toBe('2026-10-19T16:00:00.000Z'); // CEST
    expect(e['weekly/2026-11-02']!.start_at).toBe('2026-11-02T17:00:00.000Z'); // CET
    expect(e['weekly/2026-11-23']).toMatchObject({ start_at: '2026-11-24T11:00:00.000Z', title: 'Daily (wtorek)' });
  });

  it('seria całodniowa (urodziny co roku) i miesięczna z COUNT', () => {
    const e = byId(ics(
      vevent('UID:bday', 'DTSTART;VALUE=DATE:20200105', 'DTEND;VALUE=DATE:20200106', 'RRULE:FREQ=YEARLY', 'SUMMARY:Urodziny'),
      vevent('UID:monthly', 'DTSTART;TZID=Europe/Warsaw:20261031T180000', 'DTEND;TZID=Europe/Warsaw:20261031T190000', 'RRULE:FREQ=MONTHLY;BYDAY=-1SA;COUNT=3'),
    ));
    expect(e['bday/2027-01-05']).toMatchObject({ all_day: true, start_date: '2027-01-05', end_date: '2027-01-06' });
    expect(Object.keys(e).filter((k) => k.startsWith('monthly/')).sort()).toEqual(['monthly/2026-10-31', 'monthly/2026-11-28', 'monthly/2026-12-26']);
  });

  it('reguła spoza podzbioru → tylko pierwsze wystąpienie z ostrzeżeniem', () => {
    const r = expandIcs(parseIcs(ics(vevent('UID:hourly', 'DTSTART:20261120T090000Z', 'DTEND:20261120T091000Z', 'RRULE:FREQ=HOURLY;COUNT=5'))), W);
    expect(r.events.map((x) => x.external_id)).toEqual(['hourly/2026-11-20']);
    expect(r.warnings[0]).toMatch(/HOURLY/);
  });

  it('etag zmienia się tylko przy zmianie treści', () => {
    const a = byId(ics(vevent('UID:x', 'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', 'SUMMARY:A', 'DTSTAMP:20261118T100000Z'))).x!;
    const b = byId(ics(vevent('UID:x', 'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', 'SUMMARY:A', 'DTSTAMP:20261118T110000Z'))).x!;
    const c = byId(ics(vevent('UID:x', 'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', 'SUMMARY:B'))).x!;
    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(c.etag);
  });

  it('1 000 wydarzeń + 50 serii dziennych w < 200 ms', () => {
    const events = Array.from({ length: 1000 }, (_, i) =>
      vevent(`UID:e${i}`, `DTSTART:202612${String((i % 28) + 1).padStart(2, '0')}T090000Z`, 'DURATION:PT1H', `SUMMARY:Wydarzenie ${i}`));
    const series = Array.from({ length: 50 }, (_, i) =>
      vevent(`UID:s${i}`, 'DTSTART;TZID=Europe/Warsaw:20260101T070000', 'DURATION:PT15M', 'RRULE:FREQ=DAILY'));
    const text = ics(...events, ...series);
    const t = performance.now();
    const r = expandIcs(parseIcs(text), W);
    const ms = performance.now() - t;
    // Seria o 7:00: 20.10.2026 … 17.05.2027 (pierwszy dzień okna zaczyna się o 12:00).
    expect(r.events.length).toBe(1000 + 50 * 210);
    expect(ms).toBeLessThan(200);
  });
});

describe('zonedToInstant', () => {
  it('zwykły czas, luka wiosną, podwójna godzina jesienią', () => {
    expect(new Date(zonedToInstant('2026-11-18', '12:00', 'Europe/Warsaw')).toISOString()).toBe('2026-11-18T11:00:00.000Z');
    expect(new Date(zonedToInstant('2026-03-29', '02:30', 'Europe/Warsaw')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(zonedToInstant('2026-10-25', '02:30', 'Europe/Warsaw')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(new Date(zonedToInstant('2026-11-18', '09:00', 'America/New_York')).toISOString()).toBe('2026-11-18T14:00:00.000Z');
  });
});
