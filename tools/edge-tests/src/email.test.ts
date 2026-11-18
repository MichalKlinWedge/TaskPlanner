import { describe, expect, it } from 'vitest';

import {
  authenticationFailure,
  buildInboundTask,
  cleanBody,
  cleanSubject,
  htmlToText,
  recipientToken,
  senderAllowed,
  type InboundContext,
} from '../../../supabase/functions/_shared/email.ts';

describe('adres i nadawca', () => {
  it('token z plus-adresu', () => {
    expect(recipientToken('zadania+abcdefgh12345678@example.com')).toBe('abcdefgh12345678');
    expect(recipientToken('<Zadania+ABCDEFGH12345678@Example.com>')).toBe('abcdefgh12345678');
    expect(recipientToken('zadania@example.com')).toBeNull();
    expect(recipientToken('zadania+krotki@example.com')).toBeNull();
  });

  it('lista nadawców: adres albo @domena, bez wielkości liter', () => {
    const list = ['Ja@Example.com', '@firma.pl'];
    expect(senderAllowed('ja@example.com', list)).toBe(true);
    expect(senderAllowed('szef@firma.pl', list)).toBe(true);
    expect(senderAllowed('ktos@podfirma.pl', list)).toBe(false);
    expect(senderAllowed('obcy@example.com', list)).toBe(false);
    expect(senderAllowed(null, list)).toBe(false);
    expect(senderAllowed('ja@example.com', [])).toBe(false);
  });

  it('DMARC fail z nagłówka Authentication-Results', () => {
    expect(authenticationFailure(['mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass; dmarc=pass'])).toBeNull();
    expect(authenticationFailure(['mx.cloudflare.net; spf=fail; dmarc=fail (p=REJECT) header.from=bank.pl'])).toBe('dmarc_fail');
    expect(authenticationFailure([])).toBeNull();
  });
});

describe('temat i treść', () => {
  it('przedrostki odpowiedzi i przekazania (także zagnieżdżone, polskie)', () => {
    expect(cleanSubject('Fwd: Re: PD: Odp: Faktura za prąd')).toBe('Faktura za prąd');
    expect(cleanSubject('RE[2]: FW: Umowa')).toBe('Umowa');
    expect(cleanSubject('[EXT] Re: Oferta')).toBe('Oferta');
    expect(cleanSubject('Rezerwacja: hotel')).toBe('Rezerwacja: hotel');
    expect(cleanSubject(null)).toBe('');
  });

  it('bez cytatu odpowiedzi, stopki i „Wysłane z”, przekazana treść zostaje', () => {
    const body = [
      'Zapłacić do piątku.',
      '',
      '---------- Forwarded message ---------',
      'Od: Energa <faktury@energa.pl>',
      'Kwota: 123,45 zł',
      '',
      'Wysłane z iPhone’a',
      '-- ',
      'Jan Kowalski',
      'tel. 600 000 000',
    ].join('\r\n');
    expect(cleanBody(body)).toBe('Zapłacić do piątku.\n\n---------- Forwarded message ---------\nOd: Energa <faktury@energa.pl>\nKwota: 123,45 zł');
    expect(cleanBody('Tak, zrobię.\n\nW dniu 18.11.2026 o 10:00 Anna <anna@x.pl> napisała:\n> Zrobisz?\n')).toBe('Tak, zrobię.');
    expect(cleanBody('Ok\nOn Wed, Nov 18, 2026 at 10:00 AM Anna <anna@x.pl> wrote:\n> ?')).toBe('Ok');
  });

  it('HTML → tekst', () => {
    expect(htmlToText('<p>Linia&nbsp;1</p><div>Linia 2<br>Linia 3</div><ul><li>a &amp; b</li></ul><style>x{}</style>').trim())
      .toBe('Linia 1\nLinia 2\nLinia 3\n- a & b');
  });
});

describe('buildInboundTask', () => {
  const ctx: InboundContext = {
    workspaces: [{ id: 'w-osob', name: 'Osobiste' }, { id: 'w-dom', name: 'Dom' }],
    lists: [
      { id: 'l-osob-inbox', name: 'Inbox', kind: 'inbox', workspaceId: 'w-osob' },
      { id: 'l-dom-inbox', name: 'Inbox', kind: 'inbox', workspaceId: 'w-dom' },
      { id: 'l-remont', name: 'Remont kuchni', kind: 'project', workspaceId: 'w-dom' },
    ],
    tags: [{ id: '0190a0a0-0000-7000-8000-000000000001', name: 'pilne' }],
  };
  const mail = (subject: string, text = 'Treść') => ({ subject, text, html: null, from: 'ja@example.com', messageId: '<m1@example.com>', receivedAt: '2026-11-18T11:00:00Z' });
  // 18.11.2026 12:00 w Warszawie.
  const opts = { zone: 'Europe/Warsaw', nowMs: Date.parse('2026-11-18T11:00:00Z') };

  it('przykład ze specyfikacji: „Faktura za prąd jutro #dom !2”', () => {
    const r = buildInboundTask(mail('Fwd: Faktura za prąd jutro #dom !2'), ctx, opts)!;
    expect(r.task).toMatchObject({
      list_id: 'l-dom-inbox',
      title: 'Faktura za prąd',
      due_date: '2026-11-19',
      priority: 2,
      description_md: 'Treść',
      source: { kind: 'email', from: 'ja@example.com', messageId: '<m1@example.com>' },
    });
    expect(r.task.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('bez wskazania listy → Inbox pierwszej przestrzeni albo lista domyślna; lista projektu z `#`', () => {
    expect(buildInboundTask(mail('Oddzwonić do banku'), ctx, opts)!.task.list_id).toBe('l-osob-inbox');
    expect(buildInboundTask(mail('Oddzwonić'), ctx, { ...opts, defaultListId: 'l-remont' })!.task.list_id).toBe('l-remont');
    expect(buildInboundTask(mail('Kupić płytki #remont w piątek o 10'), ctx, opts)!.task).toMatchObject({ list_id: 'l-remont', title: 'Kupić płytki', due_date: '2026-11-20', due_time: '10:00' });
  });

  it('istniejący tag (z deterministycznym id), nieznany pomijany; pusty temat', () => {
    const r = buildInboundTask(mail('Przelew @pilne @nowy'), ctx, opts)!;
    expect(r.tags).toEqual([{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), tagId: '0190a0a0-0000-7000-8000-000000000001' }]);
    expect(buildInboundTask(mail(''), ctx, opts)!.task.title).toBe('(bez tematu)');
  });

  it('brak list → null', () => {
    expect(buildInboundTask(mail('x'), { workspaces: [], lists: [], tags: [] }, opts)).toBeNull();
  });
});
