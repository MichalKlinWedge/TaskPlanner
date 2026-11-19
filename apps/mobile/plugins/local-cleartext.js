/**
 * Nieszyfrowane HTTP w buildzie release tylko do `127.0.0.1` / `localhost` — lokalny Supabase przez
 * `adb reverse` (testy release APK na lokalnym stosie, `docs/MVP3_TELEFON.md` T9). Wszystko inne
 * tylko po https, jak domyślnie. Buildy debug dostają własny plik z HTTP wszędzie (Metro w sieci
 * lokalnej) — zasób z `src/debug` zastępuje ten z `src/main`. Plugin dla `npx expo prebuild`.
 */
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const FILE = 'network_security_config.xml';

const RELEASE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<network-security-config>',
  '  <base-config cleartextTrafficPermitted="false" />',
  '  <domain-config cleartextTrafficPermitted="true">',
  '    <domain includeSubdomains="false">127.0.0.1</domain>',
  '    <domain includeSubdomains="false">localhost</domain>',
  '  </domain-config>',
  '</network-security-config>',
  '',
].join('\n');

const DEBUG = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<network-security-config>',
  '  <base-config cleartextTrafficPermitted="true" />',
  '</network-security-config>',
  '',
].join('\n');

const write = (root, variant, content) => {
  const dir = path.join(root, 'app', 'src', variant, 'res', 'xml');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), content);
};

module.exports = function withLocalCleartext(config) {
  config = withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return c;
  });

  return withDangerousMod(config, [
    'android',
    async (c) => {
      const root = c.modRequest.platformProjectRoot;
      write(root, 'main', RELEASE);
      for (const variant of ['debug', 'debugOptimized']) write(root, variant, DEBUG);
      return c;
    },
  ]);
};
