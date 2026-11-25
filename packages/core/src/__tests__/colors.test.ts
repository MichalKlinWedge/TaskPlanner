import { describe, expect, it } from 'vitest';

import { COLOR_GRID, contrastRatio, hslHex, isPaletteColor, parseHexColor, readableColor } from '../colors.ts';
import { COLORS } from '../labels.ts';
import { Color } from '../schemas/model.ts';

describe('parseHexColor', () => {
  it.each([
    ['#4f46e5', '#4F46E5'],
    ['4F46E5', '#4F46E5'],
    ['  #abc ', '#AABBCC'],
    ['000', '#000000'],
  ])('%s → %s', (text, value) => expect(parseHexColor(text)).toBe(value));

  it.each(['', '#', '#12', '#1234', '#12345g', '#4F46E5FF', 'red', '##123456'])('„%s” odrzucone', (text) => expect(parseHexColor(text)).toBeNull());
});

describe('paleta', () => {
  it('szersza paleta: same poprawne, różne kolory, równe wiersze', () => {
    const all = COLOR_GRID.flat();
    for (const c of all) expect(Color.safeParse(c).success).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(COLOR_GRID.map((row) => row.length)).size).toBe(1);
  });

  it('hslHex', () => {
    expect(hslHex(0, 100, 50)).toBe('#FF0000');
    expect(hslHex(120, 100, 50)).toBe('#00FF00');
    expect(hslHex(240, 100, 50)).toBe('#0000FF');
    expect(hslHex(0, 0, 100)).toBe('#FFFFFF');
  });

  it('isPaletteColor bez rozróżniania wielkości liter', () => {
    expect(isPaletteColor('#4f46e5')).toBe(true);
    expect(isPaletteColor('#4F46E6')).toBe(false);
  });
});

describe('readableColor', () => {
  it('kolory z domyślnej palety bez zmian', () => {
    for (const c of COLORS) {
      expect(readableColor(c.value, '#FFFFFF', '#171717')).toBe(c.value);
      expect(readableColor(c.value, '#18181B', '#FAFAFA')).toBe(c.value);
    }
  });

  it('każdy kolor szerszej palety i skrajne da się przeczytać w obu motywach', () => {
    for (const c of [...COLOR_GRID.flat(), '#FFFFFF', '#000000', '#FFFF00']) {
      expect(contrastRatio(readableColor(c, '#FFFFFF', '#171717'), '#FFFFFF')).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(readableColor(c, '#18181B', '#FAFAFA'), '#18181B')).toBeGreaterThanOrEqual(3);
    }
  });

  it('czytelny kolor zostaje', () => expect(readableColor('#0F766E', '#FFFFFF', '#171717')).toBe('#0F766E'));
});
