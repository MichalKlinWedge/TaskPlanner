/**
 * Znak marki TaskPlanner: jedyne źródło logo. Rysuje SVG w `brand/` i z nich ikony aplikacji
 * (web: favicon, apple-icon, PWA; Android: ikona, adaptive icon, monochrome, splash).
 *
 *   node scripts/brand.mjs
 *
 * PNG renderuje `sharp` (zależność Next.js — jest w node_modules po `npm install`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const COLORS = {
  indigo: "#4F46E5",
  indigoLight: "#6366F1",
  indigoDark: "#3730A3",
  amber: "#FBBF24",
  ink: "#18181B",
  paper: "#FAFAFA",
  night: "#09090B",
};

/** Zaznaczenie + kropka („teraz / przypomnienie”) na siatce 1024. */
const glyph = (check = "#FFFFFF", dot = COLORS.amber) => `
  <path d="M238 572 L386 720 L678 416" fill="none" stroke="${check}" stroke-width="104" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="790" cy="300" r="60" fill="${dot}"/>`;

const scaled = (content, k) => `<g transform="translate(512 512) scale(${k}) translate(-512 -512)">${content}</g>`;

const gradient = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${COLORS.indigoLight}"/>
      <stop offset="1" stop-color="${COLORS.indigoDark}"/>
    </linearGradient>
  </defs>`;

const svg = (body, w = 1024, h = 1024) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}\n</svg>\n`;

/** Znak w zaokrąglonym kwadracie — favicon, ikona, splash. */
const mark = svg(`${gradient}
  <rect width="1024" height="1024" rx="232" fill="url(#bg)"/>${glyph()}`);

/** Pełne tło bez zaokrągleń (iOS/Android same przycinają) — znak pomniejszony do strefy bezpiecznej. */
const fullBleed = (k) => svg(`${gradient}
  <rect width="1024" height="1024" fill="url(#bg)"/>${scaled(glyph(), k)}`);

/** Android adaptive icon: przezroczysty pierwszy plan; strefa bezpieczna = koło 66/108 szerokości. */
const foreground = svg(scaled(glyph(), 0.68));
const monochrome = svg(scaled(glyph("#FFFFFF", "#FFFFFF"), 0.68));
const markMono = (color) => svg(`
  <rect width="1024" height="1024" rx="232" fill="${color}"/>${glyph(color === COLORS.ink ? COLORS.paper : COLORS.ink, COLORS.amber)}`);

/** Logo poziome: znak + nazwa. Napis jest tekstem (Geist → systemowe), do druku zamień na krzywe. */
const logo = (text) =>
  svg(
    `
  <svg width="240" height="240" viewBox="0 0 1024 1024">${gradient}
    <rect width="1024" height="1024" rx="232" fill="url(#bg)"/>${glyph()}
  </svg>
  <text x="290" y="160" font-family="Geist, 'Segoe UI', Inter, system-ui, sans-serif" font-size="128" letter-spacing="-3" fill="${text}"><tspan font-weight="700">Task</tspan><tspan font-weight="400">Planner</tspan></text>`,
    1100,
    240,
  );

const out = (path, content) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const png = async (source, path, size) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  await sharp(Buffer.from(source)).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
};

out("brand/mark.svg", mark);
out("brand/mark-ink.svg", markMono(COLORS.ink));
out("brand/mark-paper.svg", markMono(COLORS.paper));
out("brand/logo.svg", logo(COLORS.ink));
out("brand/logo-dark.svg", logo("#F4F4F5"));

// Web (Next.js app/: icon.svg → <link rel=icon>, apple-icon.png → apple-touch-icon; public/icons → manifest).
out("apps/web/src/app/icon.svg", mark);
await png(fullBleed(0.8), "apps/web/src/app/apple-icon.png", 180);
await png(mark, "apps/web/public/icons/icon-192.png", 192);
await png(mark, "apps/web/public/icons/icon-512.png", 512);
await png(fullBleed(0.72), "apps/web/public/icons/maskable-512.png", 512);

// Android (Expo app.json).
await png(fullBleed(0.8), "apps/mobile/assets/images/icon.png", 1024);
await png(foreground, "apps/mobile/assets/images/adaptive-icon.png", 1024);
await png(monochrome, "apps/mobile/assets/images/adaptive-icon-monochrome.png", 1024);
await png(mark, "apps/mobile/assets/images/splash-icon.png", 1024);

console.log("brand: SVG w brand/, ikony web i Android wygenerowane");
