// Worker lokalnej bazy (SQLite WASM, OPFS) — działa tylko w karcie-liderze (`connectTabs`).
// Moduł SQLite z plików statycznych (`public/sqlite-wasm`, scripts/copy-sqlite-wasm.mjs), bez bundlera.
import { startSqliteWorker, type SqliteInit } from "@taskplanner/sync/wasm-worker";

startSqliteWorker(() =>
  import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "/sqlite-wasm/index.mjs" as string).then(
    (module: { default: SqliteInit }) => module.default,
  ),
);
