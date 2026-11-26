import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NextConfig } from "next";

/** Numer wersji webu `x.y.w.z` — liczy go `scripts/web-version.mjs` z historii gita (Vercel klonuje płytko);
 * Next zawsze uruchamia się w `apps/web` (workspace npm, Root Directory na Vercelu). */
const VERSION: string = JSON.parse(readFileSync(join(process.cwd(), "version.json"), "utf8")).version;

const nextConfig: NextConfig = {
  // Drugi `next dev` w tym samym katalogu (np. równoległa sesja na innym porcie) potrzebuje
  // własnego katalogu wyników — `.next/dev/lock` blokuje współdzielenie.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Pakiety z monorepo są publikowane jako źródła TypeScript — Next musi je skompilować sam.
  transpilePackages: ["@taskplanner/core", "@taskplanner/sync", "@taskplanner/db"],
  // Ustawienia → „Wersja aplikacji”: numer, chwila zbudowania i (na Vercelu) commit.
  env: { NEXT_PUBLIC_APP_VERSION: VERSION, NEXT_PUBLIC_BUILD_TIME: new Date().toISOString() },
  // Service Worker zawsze świeży (inaczej przeglądarka trzyma starą wersję do 24 h).
  async headers() {
    return [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] }];
  },
  // Link zaproszenia do przestrzeni (`INVITE_PATH` w core): na telefonie otwiera aplikację (App Links,
  // `public/.well-known/assetlinks.json`), w przeglądarce — stronę główną z tym samym `?invite=<token>`.
  async redirects() {
    return [{ source: "/invite", destination: "/", permanent: false }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
