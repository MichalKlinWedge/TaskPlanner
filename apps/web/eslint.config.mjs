import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Katalogi drugiego serwera dev (scripts/dev-alt.mjs).
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // SQLite WASM kopiowany z node_modules (scripts/copy-sqlite-wasm.mjs).
    "public/sqlite-wasm/**",
  ]),
]);

export default eslintConfig;
