import type { MetadataRoute } from "next";

const shortcutIcon = (name: string) => ({ src: `/icons/shortcut-${name}.png`, sizes: "96x96", type: "image/png" });

/** Manifest PWA (instalacja na pulpicie / ekranie głównym). Ikony generuje `scripts/brand.mjs`. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Task Planner",
    short_name: "Task Planner",
    description: "Zadania codzienne: listy, kanban, kalendarz i oś czasu",
    lang: "pl",
    start_url: "/",
    display: "standalone",
    background_color: "#FAFAFA",
    theme_color: "#4F46E5",
    id: "/",
    scope: "/",
    // Udostępnianie z innych aplikacji (Android, zainstalowana PWA) → szybkie dodawanie z linkiem (Etap 10).
    share_target: {
      action: "/",
      method: "GET",
      params: { title: "share_title", text: "share_text", url: "share_url" },
    },
    // Skróty z ikony zainstalowanej aplikacji (M20); `?quick=1` otwiera dialog dodawania (`shell.tsx`).
    shortcuts: [
      { name: "Szybkie dodawanie", short_name: "Dodaj", url: "/?quick=1", icons: [shortcutIcon("add")] },
      { name: "Dziś", url: "/#/today", icons: [shortcutIcon("today")] },
      { name: "Kalendarz", url: "/#/calendar", icons: [shortcutIcon("calendar")] },
    ],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
