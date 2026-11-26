/** Aktualizacje APK: wybór wydania z GitHub Releases i porównanie wersji. */
import { describe, expect, it } from 'vitest';

import { APP_RELEASES_API_URL, APP_RELEASES_PAGE_URL, availableUpdate, compareVersions, latestAppRelease, parseVersion, shouldCheckUpdate, UPDATE_CHECK_INTERVAL_MS } from '../app-update.ts';

const asset = (name: string, size = 100) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/x/${name}`, size });
const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Task Planner Android ${tag}`,
  body: 'APK z przebiegu 1.',
  draft: false,
  prerelease: true,
  published_at: '2026-11-20T17:00:00Z',
  assets: [asset(`taskplanner-${tag.slice(9)}.apk`)],
  ...over,
});

describe('wersje', () => {
  it('parsowanie i porównanie członami liczbowymi', () => {
    expect(parseVersion('0.1.2')).toEqual([0, 1, 2]);
    expect(parseVersion('v1.0')).toEqual([1, 0]);
    expect(parseVersion('0.1.2-beta')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.2', '0.2')).toBe(-1);
    expect(compareVersions('zła', '0.0.1')).toBe(-1);
  });
});

describe('wydania', () => {
  const list = [
    release('android-v0.1.1'),
    release('android-v0.1.10', { draft: true }),
    release('android-v0.1.3'),
    release('android-v0.1.4', { assets: [asset('notatki.txt')] }),
    release('android-build-7'),
    release('android-vx'),
    { tag_name: 'android-v9.9.9' },
    'śmieci',
    release('android-v0.1.2'),
  ];

  it('najnowsze nie-szkicowe android-v* z plikiem .apk (pre-release się liczy)', () => {
    expect(latestAppRelease(list)).toEqual({
      tag: 'android-v0.1.3',
      version: '0.1.3',
      title: 'Task Planner Android android-v0.1.3',
      notes: 'APK z przebiegu 1.',
      publishedAt: '2026-11-20T17:00:00Z',
      apk: { name: 'taskplanner-0.1.3.apk', url: 'https://github.com/o/r/releases/download/x/taskplanner-0.1.3.apk', size: 100 },
    });
    expect(latestAppRelease({ message: 'API rate limit exceeded' })).toBeNull();
    expect(latestAppRelease([])).toBeNull();
  });

  it('aktualizacja tylko gdy nowsza od zainstalowanej i wersja zainstalowana jest znana', () => {
    expect(availableUpdate(list, '0.1.2')?.version).toBe('0.1.3');
    expect(availableUpdate(list, '0.1.3')).toBeNull();
    expect(availableUpdate(list, '0.2.0')).toBeNull();
    expect(availableUpdate(list, null)).toBeNull();
  });

  it('odstęp między sprawdzeniami', () => {
    const now = 1_000_000_000;
    expect(shouldCheckUpdate(null, now)).toBe(true);
    expect(shouldCheckUpdate(now - 1000, now)).toBe(false);
    expect(shouldCheckUpdate(now - UPDATE_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(shouldCheckUpdate(now + 60_000, now)).toBe(true);
  });
});

describe('adresy wydań', () => {
  it('API i strona wskazują to samo repozytorium, strona zawężona do wydań Androida', () => {
    const repo = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\?/.exec(APP_RELEASES_API_URL)?.[1];
    expect(repo).toBeTruthy();
    const page = new URL(APP_RELEASES_PAGE_URL);
    expect(page.origin + page.pathname).toBe(`https://github.com/${repo}/releases`);
    expect(page.searchParams.get('q')).toBe('android-v');
  });
});
