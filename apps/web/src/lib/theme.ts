"use client";

/**
 * Motyw z `profiles.settings.theme`: `system` idzie za ustawieniem systemu (także po zmianie w trakcie).
 * Wybór jest kopiowany do `localStorage`, żeby skrypt z `theme-script.ts` ustawił go przed pierwszym
 * malowaniem (bez mignięcia jasnego tła po starcie offline).
 */
import { useEffect } from "react";

import { THEME_KEY } from "./theme-script";

export type Theme = "system" | "light" | "dark";

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function useTheme(theme: Theme) {
  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Prywatne okno — motyw i tak działa, tylko start może mignąć.
    }
    applyTheme(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
}
