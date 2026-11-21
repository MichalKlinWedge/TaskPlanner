import { describe, expect, it } from 'vitest';

import { authErrorMessage, capitalized, compareCode, compareText, dayChip, dayLabel, dayMonth, formatMinutes, monthLabel, plural, pluralForm, quickAddChip, relativeDay, reminderOffset, shortDate } from '../format.ts';
import { parseQuickAdd } from '../quick-add.ts';
import { AUTH_ERROR, PRIORITY, REMINDER_KIND, TASK_STATUS, WEEKDAY } from '../labels.ts';
import { LocalTime, Priority } from '../schemas/primitives.ts';

describe('odmiana po liczbie', () => {
  const zadania = ['zadanie', 'zadania', 'zadań'] as const;
  it.each([
    [0, '0 zadań'],
    [1, '1 zadanie'],
    [2, '2 zadania'],
    [4, '4 zadania'],
    [5, '5 zadań'],
    [12, '12 zadań'],
    [14, '14 zadań'],
    [22, '22 zadania'],
    [25, '25 zadań'],
    [112, '112 zadań'],
    [122, '122 zadania'],
  ] as const)('%i', (count, text) => {
    expect(plural(count, zadania)).toBe(text);
  });
  it('sama forma bez liczby', () => expect(pluralForm(3, ['dzień', 'dni', 'dni'])).toBe('dni'));
});

describe('czas trwania', () => {
  it('minuty', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(84)).toBe('1 h 24 min');
  });
  it('zaokrąglenie nie daje 60 minut', () => expect(formatMinutes(119.7)).toBe('2 h'));
});

describe('daty pływające', () => {
  it('etykiety', () => {
    expect(dayLabel('2026-12-05')).toBe('sobota, 5 grudnia');
    expect(capitalized(dayLabel('2026-12-05'))).toBe('Sobota, 5 grudnia');
    expect(dayChip('2026-12-05')).toBe('sob., 5.12');
    expect(dayMonth('2026-12-05')).toBe('5 grudnia');
    expect(shortDate('2026-12-05')).toBe('5 gru');
  });
});

describe('schematy i etykiety', () => {
  it('godzina GG:MM', () => {
    expect(LocalTime.safeParse('09:30').success).toBe(true);
    expect(LocalTime.safeParse('24:00').success).toBe(false);
    expect(LocalTime.safeParse('9:30').success).toBe(false);
  });
  it('priorytet 1–4 z etykietą', () => {
    expect(Priority.safeParse(5).success).toBe(false);
    expect(PRIORITY[1].label).toBe('Krytyczny');
    expect(TASK_STATUS.waiting).toBe('Oczekuje');
  });
});

describe('dzień względny (dziś = śr 18.11.2026)', () => {
  const today = '2026-11-18';
  it.each([
    ['2026-11-18', 'dziś', 'dziś'],
    ['2026-11-19', 'jutro', 'jutro'],
    ['2026-11-17', 'wczoraj', 'wczoraj'],
    ['2026-11-20', 'pt 20 lis', 'za 2 dni'],
    ['2026-11-21', 'sob 21 lis', 'za 3 dni'],
    ['2026-11-16', 'pon 16 lis', '2 dni temu'],
    ['2026-12-01', 'wt 1 gru', 'za 13 dni'],
    ['2026-12-02', 'śr 2 gru', 'za 2 tygodnie'],
    ['2026-10-14', 'śr 14 paź', '5 tygodni temu'],
    ['2027-02-15', 'pon 15 lut 2027', 'za 2 miesiące'],
    ['2028-01-10', 'pon 10 sty 2028', 'za rok'],
    ['2021-11-18', 'czw 18 lis 2021', '5 lat temu'],
  ] as const)('%s', (date, chip, distance) => {
    expect(relativeDay(date, today)).toBe(chip);
    expect(relativeDay(date, today, 'distance')).toBe(distance);
  });

  it('etykiety przypomnień i dni tygodnia', () => {
    expect(REMINDER_KIND.relative).toBe('Przed terminem');
    expect(Object.keys(WEEKDAY)).toHaveLength(7);
    expect(WEEKDAY[7].label).toBe('niedziela');
  });
});

describe('błędy logowania po polsku', () => {
  it('po kodzie GoTrue i `error_code` z adresu powrotu', () => {
    expect(authErrorMessage({ code: 'otp_expired', message: 'Email link is invalid or has expired' })).toBe(AUTH_ERROR.otp_expired);
    expect(authErrorMessage({ code: 'pkce_code_verifier_not_found', message: 'PKCE code verifier not found in storage.' })).toBe(AUTH_ERROR.pkce_code_verifier_not_found);
    expect(authErrorMessage({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' })).toBe(AUTH_ERROR.over_email_send_rate_limit);
  });
  it('bez kodu — po treści (sieć, dostawca, wygasły link)', () => {
    expect(authErrorMessage({ name: 'AuthRetryableFetchError', message: 'Network request failed', status: 0 })).toBe(AUTH_ERROR.network);
    expect(authErrorMessage({ code: 'validation_failed', message: 'Unsupported provider: provider is not enabled' })).toBe(AUTH_ERROR.provider_disabled);
    expect(authErrorMessage('Email link is invalid or has expired')).toBe(AUTH_ERROR.otp_expired);
  });
  it('rejestracja spoza zaproszeń — po treści, przed kodem', () => {
    // Hook „Before User Created”: znacznik w komunikacie, kod ogólny (mail i powrót z Google).
    expect(authErrorMessage({ code: 'unexpected_failure', message: 'signup_not_invited: adres spoza listy' })).toBe(AUTH_ERROR.signup_not_invited);
    expect(authErrorMessage({ code: 'server_error', message: 'signup_not_invited: adres spoza listy' })).toBe(AUTH_ERROR.signup_not_invited);
    // Wyłączona rejestracja: link z maila dla nowego adresu daje `otp_disabled`, nie „logowanie wyłączone”.
    expect(authErrorMessage({ code: 'otp_disabled', message: 'Signups not allowed for otp' })).toBe(AUTH_ERROR.signup_disabled);
    expect(authErrorMessage({ code: 'signup_disabled', message: 'Signups not allowed for this instance' })).toBe(AUTH_ERROR.signup_disabled);
    expect(authErrorMessage({ code: 'otp_disabled', message: 'OTP is disabled' })).toBe(AUTH_ERROR.otp_disabled);
  });
  it('nieznany błąd — komunikat serwera, pusty — ogólny', () => {
    expect(authErrorMessage({ code: 'hook_timeout', message: 'Hook timed out' })).toBe('Hook timed out');
    expect(authErrorMessage(null)).toBe('Nie udało się zalogować.');
  });
});

describe('chipy szybkiego dodawania', () => {
  it('wartości z pól wyniku', () => {
    const text = 'Zapłacić rachunek jutro o 10 ~90m #dom !wysoki @telefon co tydzień ^15m';
    const result = parseQuickAdd(text, { now: '2026-11-18T12:00', workspaces: ['Dom'], lists: [], tags: ['telefon'] });
    expect(result.tokens.map((t) => quickAddChip(t, result, '2026-11-18'))).toEqual([
      'Termin: jutro',
      'Godzina: 10:00',
      'Czas: 1 h 30 min',
      'Lista: Dom (Inbox)',
      'Priorytet: Wysoki',
      'Tag: telefon',
      'Powtarzanie: w każdy czwartek',
      'Przypomnienie: ^15m',
    ]);
  });
});

describe('przypomnienia', () => {
  it('wyprzedzenie po polsku', () => {
    expect([0, 15, 90, 1440, 2880].map(reminderOffset)).toEqual(['w chwili terminu', '15 min przed', '1 h 30 min przed', '1 dzień przed', '2 dni przed']);
  });
});

describe('miesiąc', () => {
  it('nazwa miesiąca z rokiem', () => {
    expect(monthLabel('2026-11-18')).toBe('listopad 2026');
    expect(monthLabel('2027-01-01')).toBe('styczeń 2027');
  });
});

describe('porównanie napisów', () => {
  it('compareText — kolejność polska, compareCode — kolejność znaków', () => {
    expect(['Żaba', 'ala', 'Łódź', 'Ćma', 'Cyna', 'lato'].sort(compareText)).toEqual(['ala', 'Cyna', 'Ćma', 'lato', 'Łódź', 'Żaba']);
    expect(['2026-11-20T10:00', '2026-11-20', '2026-11-19T23:00'].sort(compareCode)).toEqual(['2026-11-19T23:00', '2026-11-20', '2026-11-20T10:00']);
    expect(compareCode('a', 'a')).toBe(0);
  });
});
