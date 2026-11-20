/**
 * Aktualizacja APK z GitHub Releases (aplikacja jest poza Google Play): sprawdzenie listy wydań
 * (publiczne API, bez tokena; najwyżej co `UPDATE_CHECK_INTERVAL_MS`, przycisk w ustawieniach — od razu),
 * pobranie pliku `.apk` do `Paths.cache/updates` z postępem i otwarcie systemowego instalatora
 * (`File.preview` z typem APK → `ACTION_VIEW` przez FileProvider expo-file-system; wymaga uprawnienia
 * `REQUEST_INSTALL_PACKAGES` z `app.json`). Android zawsze pyta użytkownika o instalację — za pierwszym
 * razem także o zgodę „Instaluj nieznane aplikacje” dla Task Plannera.
 *
 * Stan jest wspólny dla banera i ustawień (`useAppUpdate`). Wybór wydania i porównanie wersji: core `app-update.ts`.
 */
import { APK_MIME, availableUpdate, shouldCheckUpdate, type AppRelease } from '@taskplanner/core';
import * as Application from 'expo-application';
import { Directory, File, Paths } from 'expo-file-system';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

import { readJson, writeJson } from './config';
import { reportError } from './error-log';

export const RELEASES_URL = 'https://api.github.com/repos/MichalKlinWedge/TaskPlanner/releases?per_page=20';
const FETCH_TIMEOUT_MS = 15_000;
const KEYS = { last: 'update.last', dismissed: 'update.dismissed' } as const;

/** Wersja zainstalowana (`versionName` z `app.json`). */
export const INSTALLED_VERSION = Application.nativeApplicationVersion;

export type UpdateState =
  | { status: 'idle'; checkedAt: number | null; release: AppRelease | null; error?: string }
  | { status: 'checking'; checkedAt: number | null; release: AppRelease | null }
  | { status: 'downloading'; checkedAt: number | null; release: AppRelease; progress: number | null }
  | { status: 'ready'; checkedAt: number | null; release: AppRelease; error?: string };

interface LastCheck {
  checkedAt: number;
  release: AppRelease | null;
}

const listeners = new Set<() => void>();
let state: UpdateState = initialState();

function initialState(): UpdateState {
  const last = readJson<LastCheck | null>(KEYS.last, null);
  // Zapamiętane wydanie, które jest już zainstalowane (albo starsze), nie jest aktualizacją.
  const release = last?.release && availableUpdate([toApi(last.release)], INSTALLED_VERSION) ? last.release : null;
  // Po instalacji nowej wersji pobrany APK nie jest już potrzebny.
  if (!release) setTimeout(() => cleanDownloads(), 0);
  return { status: 'idle', checkedAt: last?.checkedAt ?? null, release };
}

/** Wydanie z powrotem w kształcie API (do ponownego sprawdzenia zapamiętanego wyniku). */
function toApi(r: AppRelease) {
  return { tag_name: r.tag, name: r.title, body: r.notes, published_at: r.publishedAt, assets: [{ name: r.apk.name, browser_download_url: r.apk.url, size: r.apk.size }] };
}

function setState(next: UpdateState) {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useAppUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function fetchReleases(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: controller.signal });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub chwilowo ogranicza zapytania — spróbuj później');
    if (!res.ok) throw new Error(`GitHub odpowiedział ${res.status}`);
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`GitHub nie odpowiedział w ${FETCH_TIMEOUT_MS / 1000} s (timeout)`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sprawdza nowe wydanie. Bez `force` — tylko gdy minął odstęp od ostatniego sprawdzenia. Zwraca
 * wydanie do zainstalowania albo `null`. Błąd sprawdzenia zostaje w stanie (`error`), nie w dzienniku błędów.
 */
export async function checkForUpdate({ force = false }: { force?: boolean } = {}): Promise<AppRelease | null> {
  if (state.status === 'checking' || state.status === 'downloading') return state.release;
  if (!force && !shouldCheckUpdate(state.checkedAt, Date.now())) return state.release;
  if (!INSTALLED_VERSION) return null;
  const before = state;
  setState({ status: 'checking', checkedAt: before.checkedAt, release: before.release });
  try {
    const release = availableUpdate(await fetchReleases(), INSTALLED_VERSION);
    const checkedAt = Date.now();
    writeJson(KEYS.last, { checkedAt, release } satisfies LastCheck);
    if (!release) cleanDownloads();
    // Plik tej wersji już pobrany — od razu „Zainstaluj”.
    const file = release ? downloadedFile(release) : null;
    setState(release && file ? { status: 'ready', checkedAt, release } : { status: 'idle', checkedAt, release });
    return release;
  } catch (error) {
    // Brak sieci, limit GitHuba — nie błąd aplikacji, tylko komunikat w ustawieniach.
    setState({ status: 'idle', checkedAt: before.checkedAt, release: before.release, error: message(error) });
    return before.release;
  }
}

const updatesDir = () => new Directory(Paths.cache, 'updates');
const fileFor = (release: AppRelease) => new File(updatesDir(), release.apk.name);

/** Pobrany w całości plik wydania albo `null`. */
function downloadedFile(release: AppRelease): File | null {
  const file = fileFor(release);
  return file.exists && file.size === release.apk.size ? file : null;
}

/** Usuwa pobrane APK (po instalacji nowej wersji albo gdy nie ma aktualizacji). */
export function cleanDownloads(except?: string) {
  try {
    const dir = updatesDir();
    if (!dir.exists) return;
    for (const item of dir.list()) if (item.name !== except) item.delete();
  } catch {
    // Pamięć podręczna — system i tak ją czyści.
  }
}

/** Pobiera APK wydania (z postępem w stanie) i od razu otwiera instalator. */
export async function downloadAndInstall(release: AppRelease): Promise<void> {
  if (state.status === 'downloading') return;
  const { checkedAt } = state;
  let file = downloadedFile(release);
  if (!file) {
    setState({ status: 'downloading', checkedAt, release, progress: 0 });
    try {
      const dir = updatesDir();
      if (!dir.exists) dir.create({ intermediates: true });
      cleanDownloads();
      const target = fileFor(release);
      let lastShown = 0;
      const task = File.createDownloadTask(release.apk.url, target, {
        onProgress: ({ bytesWritten, totalBytes }) => {
          const total = totalBytes > 0 ? totalBytes : release.apk.size;
          const progress = total > 0 ? Math.min(1, bytesWritten / total) : null;
          // Bez przerysowania przy każdym kawałku — co 1 %.
          if (progress === null || progress - lastShown >= 0.01 || progress === 1) {
            lastShown = progress ?? 0;
            setState({ status: 'downloading', checkedAt, release, progress });
          }
        },
      });
      const done = await task.downloadAsync();
      if (!done) throw new Error('Pobieranie przerwane');
      file = downloadedFile(release);
      if (!file) {
        target.delete();
        throw new Error('Pobrany plik ma zły rozmiar — spróbuj jeszcze raz');
      }
    } catch (error) {
      reportError('error', error, { where: 'app-update/download', version: release.version });
      setState({ status: 'idle', checkedAt, release, error: `Nie udało się pobrać: ${message(error)}` });
      return;
    }
  }
  setState({ status: 'ready', checkedAt, release });
  await install(release);
}

/** Otwiera instalator dla pobranego pliku (Android pyta o zgodę). */
export async function install(release: AppRelease): Promise<void> {
  const file = downloadedFile(release);
  if (!file) {
    setState({ status: 'idle', checkedAt: state.checkedAt, release, error: 'Plik aktualizacji zniknął — pobierz go ponownie' });
    return;
  }
  try {
    await file.preview({ mimeType: APK_MIME });
  } catch (error) {
    reportError('error', error, { where: 'app-update/install', version: release.version });
    setState({ status: 'ready', checkedAt: state.checkedAt, release, error: `Nie udało się otworzyć instalatora: ${message(error)}` });
  }
}

/** Baner tej wersji schowany („Później”); ustawienia nadal ją pokazują. */
export function dismissedVersion(): string | null {
  return Storage.getItemSync(KEYS.dismissed);
}

export function dismissUpdate(release: AppRelease) {
  Storage.setItemSync(KEYS.dismissed, release.version);
  setState({ ...state });
}
