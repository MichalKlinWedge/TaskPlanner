/** Dowolny kolor (#RRGGBB) obok palety `COLORS`: zapis szesnastkowy, szersza paleta, czytelność tekstu. */
import { COLORS } from './labels.ts';

export type Rgb = [number, number, number];

/** `#RGB` / `#RRGGBB` (także bez `#`) → składowe 0–255; co innego → `null`. */
export function rgbOf(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

const hexOf = (rgb: Rgb): string => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** Wpisany kolor (`4f46e5`, `#4F46E5`, `#abc`) → `#RRGGBB` wielkimi literami, jak w `COLORS`; zły zapis → `null`. */
export function parseHexColor(text: string): string | null {
  const rgb = rgbOf(text);
  return rgb && hexOf(rgb);
}

export const isPaletteColor = (color: string): boolean => COLORS.some((c) => c.value === color.toUpperCase());

/** Barwa 0–360, nasycenie i jasność 0–100 → `#RRGGBB`. */
export function hslHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return hexOf([channel(0), channel(8), channel(4)]);
}

const GRID_HUES = [0, 24, 42, 54, 90, 142, 174, 199, 221, 262, 326];
const GRID_LIGHTNESS = [88, 74, 62, 50, 38, 26];
const GRID_GREYS = [95, 78, 62, 46, 30, 12];

/** Szersza paleta: wiersze od jasnych do ciemnych, w wierszu szary i kolejne barwy. */
export const COLOR_GRID: readonly (readonly string[])[] = GRID_LIGHTNESS.map((l, row) => [hslHex(0, 0, GRID_GREYS[row]!), ...GRID_HUES.map((h) => hslHex(h, 80, l))]);

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Kontrast WCAG (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(rgbOf(a) ?? [0, 0, 0]), luminance(rgbOf(b) ?? [0, 0, 0])];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Najmniejszy kontrast tekstu w dowolnym kolorze z tłem. */
const MIN_CONTRAST = 3;

/**
 * Kolor tekstu w kolorze użytkownika (np. nazwa tagu): za jasny / za ciemny na tle `background` jest
 * przybliżany do `text`, aż da się go przeczytać. Kolory z `COLORS` i zły zapis zostają bez zmian.
 */
export function readableColor(color: string, background: string, text: string): string {
  const rgb = rgbOf(color);
  const target = rgbOf(text);
  if (!rgb || !target || isPaletteColor(color)) return color;
  for (let share = 0; share < 1; share += 0.1) {
    const mixed = hexOf(rgb.map((v, i) => v * (1 - share) + target[i]! * share) as Rgb);
    if (contrastRatio(mixed, background) >= MIN_CONTRAST) return mixed;
  }
  return text;
}
