import { describe, expect, it } from 'vitest';

import { capitalized, dayChip, dayLabel, dayMonth, formatMinutes, plural, pluralForm, shortDate } from '../format.ts';
import { PRIORITY, TASK_STATUS } from '../labels.ts';
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
