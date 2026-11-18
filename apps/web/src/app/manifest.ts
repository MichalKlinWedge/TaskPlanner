import type { MetadataRoute } from "next";

/** Manifest PWA (instalacja na pulpicie / ekranie głównym). Ikony generuje `scripts/brand.mjs`. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TaskPlanner",
    short_name: "TaskPlanner",
    description: "Zadania codzienne: listy, kanban, kalendarz i oś czasu",
    lang: "pl",
    start_url: "/",
    display: "standalone",
    background_color: "#FAFAFA",
    theme_color: "#4F46E5",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
