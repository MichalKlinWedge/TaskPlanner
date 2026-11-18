// Domyślna konfiguracja Expo (monorepo wykrywane automatycznie) + korpus `fixtures/*.jsonl`
// jako moduł — ekran samosprawdzenia liczy go w Hermes tak jak Vitest w Node.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.sourceExts.push('jsonl');
config.transformer.babelTransformerPath = require.resolve('./metro/jsonl-transformer.js');

module.exports = config;
