/**
 * Numer wersji webu `x.y.w.z` i chwila zbudowania (`env` w `next.config.ts`; numer liczy
 * `scripts/web-version.mjs`). Pokazywany przy nazwie aplikacji w nagłówku i w Ustawieniach.
 */
export const APP_NUMBER: string | null = process.env.NEXT_PUBLIC_APP_VERSION ?? null;

export const BUILD_TIME: string | null = process.env.NEXT_PUBLIC_BUILD_TIME ?? null;

/** Pozycje numeru (`kind` wpisu historii zmian). */
export const CHANGE_KIND: Record<"x" | "y" | "w" | "z", string> = {
  x: "Całkowita zmiana",
  y: "Duża zmiana",
  w: "Mała zmiana",
  z: "Kosmetyka",
};

export type ChangelogEntry = { version: string; kind: keyof typeof CHANGE_KIND; date: string; title: string };
