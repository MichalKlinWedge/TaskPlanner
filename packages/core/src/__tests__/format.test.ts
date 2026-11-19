import { describe, expect, it } from 'vitest';

import { capitalized, dayChip, dayLabel, dayMonth, formatMinutes, plural, pluralForm, relativeDay, shortDate } from '../format.ts';
import { PRIORITY, REMINDER_KIND, TASK_STATUS, WEEKDAY } from '../labels.ts';
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
