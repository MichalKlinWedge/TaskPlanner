/**
 * Aktualizacje APK poza Google Play: wybór najnowszego wydania z listy GitHub Releases
 * (`GET /repos/{owner}/{repo}/releases`, tagi `android-v<wersja>`, plik `.apk` w zasobach)
 * i porównanie z wersją zainstalowaną. Pobranie i instalacja są w aplikacji (`apps/mobile/src/lib/app-update.ts`).
 */
import { z } from 'zod';

export const APP_RELEASE_TAG_PREFIX = 'android-v';
export const APK_MIME = 'application/vnd.android.package-archive';
/** Repozytorium z wydaniami APK (publiczne GitHub Releases). */
export const APP_RELEASES_REPO = 'MichalKlinWedge/TaskPlanner';
/** Lista wydań w API GitHuba (bez tokenu; `latestAppRelease` wybiera z niej wydanie Androida). */
export const APP_RELEASES_API_URL = `https://api.github.com/repos/${APP_RELEASES_REPO}/releases?per_page=20`;
/** Strona wydań dla ludzi — zawężona do wydań Androida (`android-v…`). */
export const APP_RELEASES_PAGE_URL = `https://github.com/${APP_RELEASES_REPO}/releases?q=${APP_RELEASE_TAG_PREFIX}&expanded=true`;
/** Jak często sprawdzać same (przycisk „Sprawdź” w ustawieniach pomija ten odstęp). */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AppRelease {
  tag: string;
  /** Wersja z tagu, np. `0.1.3`. */
  version: string;
  title: string;
  /** Opis wydania (Markdown z GitHuba). */
  notes: string;
  /** ISO. */
  publishedAt: string | null;
  apk: { name: string; url: string; size: number };
}

const Asset = z.object({ name: z.string(), browser_download_url: z.string().url(), size: z.number().int().nonnegative() });
const Release = z.object({
  tag_name: z.string(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  draft: z.boolean().optional(),
  published_at: z.string().nullish(),
  assets: z.array(Asset).default([]),
});

/** `0.1.2` → `[0, 1, 2]`; inne formaty (z sufiksem, pustym członem) → `null`. */
export function parseVersion(version: string): number[] | null {
  const v = version.trim().replace(/^v/, '');
  if (!/^\d+(\.\d+){0,3}$/.test(v)) return null;
  return v.split('.').map(Number);
}

/** Porównanie wersji członami liczbowymi (`0.1.10` > `0.1.9`, `1.0` = `1.0.0`). Niepoprawna wersja jest najmniejsza. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Najnowsze wydanie aplikacji z odpowiedzi API: tag `android-v<wersja>`, nie szkic, z plikiem `.apk`
 * (wydania „pre-release” się liczą — tak publikuje je workflow). Wpisy w innym kształcie są pomijane.
 */
export function latestAppRelease(releases: unknown, prefix = APP_RELEASE_TAG_PREFIX): AppRelease | null {
  if (!Array.isArray(releases)) return null;
  let best: AppRelease | null = null;
  for (const raw of releases) {
    const parsed = Release.safeParse(raw);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (r.draft || !r.tag_name.startsWith(prefix)) continue;
    const version = r.tag_name.slice(prefix.length);
    if (!parseVersion(version)) continue;
    const apk = r.assets.find((a) => a.name.toLowerCase().endsWith('.apk'));
    if (!apk) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = {
      tag: r.tag_name,
      version,
      title: r.name?.trim() || `Task Planner ${version}`,
      notes: r.body?.trim() ?? '',
      publishedAt: r.published_at ?? null,
      apk: { name: apk.name, url: apk.browser_download_url, size: apk.size },
    };
  }
  return best;
}

/** Wydanie nowsze od zainstalowanego albo `null`. Bez znanej wersji zainstalowanej (np. dev build) — `null`. */
export function availableUpdate(releases: unknown, installed: string | null): AppRelease | null {
  if (!installed || !parseVersion(installed)) return null;
  const latest = latestAppRelease(releases);
  return latest && compareVersions(latest.version, installed) > 0 ? latest : null;
}

/** Czy pora sprawdzić (ostatnie sprawdzenie dawniej niż `interval` albo zegar cofnięty). */
export function shouldCheckUpdate(lastCheckedAt: number | null, now: number, interval = UPDATE_CHECK_INTERVAL_MS): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= interval || now < lastCheckedAt;
}
