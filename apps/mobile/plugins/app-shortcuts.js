/**
 * Skróty aplikacji na Androidzie (przytrzymanie ikony): „Szybkie dodawanie”, „Dziś”, „Szukaj”.
 * Statyczne `res/xml/shortcuts.xml` z intencjami `taskplanner://…` do `MainActivity` — Expo Router
 * otwiera z nich trasy (`/quick-add`, `/`, `/search`). Plugin dla `npx expo prebuild`.
 */
const { AndroidConfig, withAndroidManifest, withDangerousMod, withStringsXml } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SHORTCUTS = [
  { id: 'quick_add', label: 'Szybkie dodawanie', long: 'Dodaj zadanie', url: 'taskplanner://quick-add' },
  { id: 'today', label: 'Dziś', long: 'Zadania na dziś', url: 'taskplanner:///today' },
  { id: 'search', label: 'Szukaj', long: 'Szukaj zadań', url: 'taskplanner://search' },
];

const xml = (pkg) =>
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">',
    ...SHORTCUTS.map((s) =>
      [
        `  <shortcut android:shortcutId="${s.id}" android:enabled="true" android:icon="@mipmap/ic_launcher"`,
        `      android:shortcutShortLabel="@string/shortcut_${s.id}" android:shortcutLongLabel="@string/shortcut_${s.id}_long">`,
        `    <intent android:action="android.intent.action.VIEW" android:data="${s.url}"`,
        `        android:targetPackage="${pkg}" android:targetClass="${pkg}.MainActivity" />`,
        '  </shortcut>',
      ].join('\n'),
    ),
    '</shortcuts>',
    '',
  ].join('\n');

module.exports = function withAppShortcuts(config) {
  const pkg = config.android?.package;
  if (!pkg) throw new Error('app-shortcuts: brak android.package');

  config = withStringsXml(config, (c) => {
    for (const s of SHORTCUTS) {
      c.modResults = AndroidConfig.Strings.setStringItem(
        [
          { $: { name: `shortcut_${s.id}`, translatable: 'false' }, _: s.label },
          { $: { name: `shortcut_${s.id}_long`, translatable: 'false' }, _: s.long },
        ],
        c.modResults,
      );
    }
    return c;
  });

  config = withAndroidManifest(config, (c) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults);
    activity['meta-data'] = (activity['meta-data'] ?? []).filter((m) => m.$['android:name'] !== 'android.app.shortcuts');
    activity['meta-data'].push({ $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/shortcuts' } });
    return c;
  });

  return withDangerousMod(config, [
    'android',
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'shortcuts.xml'), xml(pkg));
      return c;
    },
  ]);
};
