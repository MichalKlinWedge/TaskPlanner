#!/usr/bin/env node
/**
 * Numer wersji webu `x.y.w.z` liczony z historii gita (`main`, pierwszy rodzic — scalenie gałęzi
 * liczy się jako jedna zmiana) i zapisywany w `apps/web/version.json`, który czyta `next.config.ts`.
 * Obok zapisuje historię zmian `apps/web/src/lib/changelog.json` (ekran `#/changelog`, od najnowszej).
 *
 *   x — całkowita zmiana: ustawiana ręcznie (`--major`), liczenie y.w.z zaczyna się wtedy od nowa,
 *   y — duża zmiana: commit dodaje migrację (`supabase/migrations/*.sql`); zeruje w i z,
 *   w — mała zmiana: ≥ SMALL_LINES zmienionych linii kodu webu / wspólnych pakietów; zeruje z,
 *   z — kosmetyka: mniejsza zmiana tego kodu.
 * Commity bez zmian w tym kodzie (sam telefon, dokumentacja, testy) nie zmieniają numeru.
 * Niezatwierdzone zmiany liczą się jako jeszcze jeden commit, więc skrypt uruchamia się przed
 * commitem, który ma wejść na `main` (`-m` = tytuł tego commita), i oba pliki idą w tym samym commicie.
 *
 *   node scripts/web-version.mjs -m "…"   przelicz i zapisz
 *   node scripts/web-version.mjs --check  tylko wypisz (kod 1, gdy pliki są nieaktualne)
 *   node scripts/web-version.mjs --major  x + 1, liczenie od bieżącego HEAD
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "apps/web/version.json");
const HISTORY = join(ROOT, "apps/web/src/lib/changelog.json");
/** Pliki pisane przez ten skrypt — nie liczą się jako zmiana. */
const GENERATED = ["apps/web/version.json", "apps/web/src/lib/changelog.json"];
const SMALL_LINES = 30;

/** Kod, który trafia do webu. */
const CODE = [/^apps\/web\//, /^packages\/(core|sync|db|ai)\/src\//, /^supabase\/(migrations|functions)\//];
const SKIP = [/__tests__\//, /\.test\.tsx?$/, /\.md$/, /^apps\/web\/public\/sqlite-wasm\//];
const MIGRATION = /^supabase\/migrations\/[^/]+\.sql$/;

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
  console.error("Płytki klon — historii nie da się policzyć; zostaje numer z apps/web/version.json.");
  process.exit(0);
}

const stored = JSON.parse(readFileSync(FILE, "utf8"));
const args = process.argv.slice(2);
let major = stored.major ?? 0;
let base = stored.base ?? null;
if (args.includes("--major")) {
  major += 1;
  base = git("rev-parse", "HEAD").trim();
}

const counted = (path) => Boolean(path) && !GENERATED.includes(path) && CODE.some((re) => re.test(path)) && !SKIP.some((re) => re.test(path));

/** Rodzaj zmiany z `--numstat` i listy dodanych plików; `null` = nie dotyczy webu. */
function kind(numstat, added) {
  if (added.some((path) => MIGRATION.test(path))) return "y";
  let lines = 0;
  for (const line of numstat.split("\n")) {
    const [add, del, path] = line.split("\t");
    if (!counted(path)) continue;
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  if (lines === 0) return null;
  return lines >= SMALL_LINES ? "w" : "z";
}

/** Dodane pliki z `--summary` („ create mode 100644 ścieżka”). */
const created = (text) => [...text.matchAll(/^ create mode \d+ (.+)$/gm)].map((m) => m[1]);

// Jedno wywołanie: każdy commit = blok „@@<sha> TAB <data> TAB <tytuł>” + numstat + summary;
// scalenie = różnica do 1. rodzica.
const range = base ? [`${base}..HEAD`] : ["HEAD"];
const log = git("log", "--first-parent", "--diff-merges=first-parent", "--reverse", "--numstat", "--summary", "--format=@@%H%x09%cs%x09%s", ...range, "--");
const changes = `\n${log}`
  .split("\n@@")
  .filter((block) => block.trim())
  .map((block) => {
    const end = block.indexOf("\n");
    const head = end < 0 ? block : block.slice(0, end);
    const body = end < 0 ? "" : block.slice(end + 1);
    const [sha, date, title] = head.split("\t");
    return { kind: kind(body.trim(), created(body)), sha, date, title };
  });

// Niezatwierdzone zmiany (bez plików tego skryptu) = jeszcze jeden commit; nowe pliki liczą się całe.
const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(counted);
const pendingStat = git("diff", "--numstat", "HEAD", "--").trim();
const untrackedStat = untracked.map((path) => `${readFileSync(join(ROOT, path), "utf8").split("\n").length}\t0\t${path}`).join("\n");
const pendingKind = kind(`${pendingStat}\n${untrackedStat}`, [...created(git("diff", "--summary", "HEAD", "--")), ...untracked]);
if (pendingKind) {
  const at = args.indexOf("-m");
  const title = at >= 0 ? (args[at + 1] ?? "").trim() : "";
  if (!title && !args.includes("--check")) {
    console.error('Niezatwierdzone zmiany kodu webu liczą się jako nowa wersja — podaj tytuł commita: npm run web:version -- -m "…"');
    process.exit(2);
  }
  changes.push({ kind: pendingKind, sha: null, date: new Date().toLocaleDateString("sv-SE"), title });
}

let [y, w, z] = [0, 0, 0];
const entries = [];
for (const change of changes) {
  if (!change.kind) continue;
  if (change.kind === "y") [y, w, z] = [y + 1, 0, 0];
  else if (change.kind === "w") [w, z] = [w + 1, 0];
  else z += 1;
  entries.push({ version: `${major}.${y}.${w}.${z}`, kind: change.kind, date: change.date, title: change.title });
}

const version = `${major}.${y}.${w}.${z}`;
const text = `${JSON.stringify({ version, major, base }, null, 2)}\n`;
// Od najnowszej, jeden wpis na linię — diff pliku pokazuje tylko nowe wpisy.
const history = `[\n${entries
  .reverse()
  .map((entry) => `  ${JSON.stringify(entry)}`)
  .join(",\n")}\n]\n`;

if (args.includes("--check")) {
  console.log(version);
  const same = readFileSync(FILE, "utf8") === text && readFileSync(HISTORY, "utf8") === history;
  process.exit(same ? 0 : 1);
}
writeFileSync(FILE, text);
writeFileSync(HISTORY, history);
console.log(version);
