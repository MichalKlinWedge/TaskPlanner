"use client";

/**
 * Ekran `#/changelog` („Historia zmian”, klik w numer wersji przy nazwie aplikacji): wpisy z
 * `lib/changelog.json` (pisze go `scripts/web-version.mjs`, od najnowszej) — numer, rodzaj zmiany,
 * data i tytuł commita. Plik wczytywany dopiero tu (osobny fragment kodu, działa offline po pierwszym otwarciu).
 */
import { dayMonth } from "@taskplanner/core";
import { useEffect, useMemo, useState } from "react";

import { APP_NUMBER, CHANGE_KIND, type ChangelogEntry } from "@/lib/version";

import { Input } from "./ui";

/** Ile wpisów naraz (reszta po „Pokaż więcej”). */
const PAGE = 100;

const KIND_STYLE: Record<ChangelogEntry["kind"], string> = {
  x: "bg-[var(--danger)] text-white",
  y: "bg-[var(--accent)] text-white",
  w: "border border-[var(--accent)] text-[var(--accent)]",
  z: "border border-[var(--line)] text-[var(--muted)]",
};

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function ChangelogScreen() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    let live = true;
    import("@/lib/changelog.json")
      .then((mod) => live && setEntries(mod.default as ChangelogEntry[]))
      .catch(() => live && setProblem("Nie udało się wczytać historii zmian — odśwież stronę z dostępem do sieci."));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const needle = fold(query.trim());
    return needle ? (entries ?? []).filter((e) => fold(`${e.version} ${e.title}`).includes(needle)) : (entries ?? []);
  }, [entries, query]);

  return (
    <div className="mx-auto max-w-3xl" data-testid="changelog">
      <h1 className="mb-1 text-xl font-semibold">Historia zmian</h1>
      <p className="mb-3 text-sm text-[var(--muted)]">
        Wersja {APP_NUMBER ?? "—"}. Numer: całkowita zmiana . duża zmiana . mała zmiana . kosmetyka — duża = zmiana bazy danych, mała = większa zmiana kodu, kosmetyka = drobna poprawka.
      </p>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Szukaj w historii…" aria-label="Szukaj w historii zmian" className="mb-3" />
      {problem ? <p className="text-sm text-[var(--danger)]">{problem}</p> : null}
      {!entries && !problem ? <p className="text-sm text-[var(--muted)]">Wczytywanie…</p> : null}
      <ol className="flex flex-col divide-y divide-[var(--line)]">
        {shown.slice(0, limit).map((entry) => (
          <li key={entry.version} className="flex items-start gap-3 py-2 text-sm" aria-current={entry.version === APP_NUMBER ? "true" : undefined}>
            <span className="w-24 shrink-0 font-mono text-xs leading-5">
              {entry.version}
              {entry.version === APP_NUMBER ? <span className="block text-[10px] text-[var(--accent)]">ta wersja</span> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block">{entry.title}</span>
              <span className="mt-0.5 flex items-center gap-2 text-xs text-[var(--muted)]">
                <span className={`rounded px-1.5 py-px text-[10px] font-medium ${KIND_STYLE[entry.kind]}`}>{CHANGE_KIND[entry.kind]}</span>
                {dayMonth(entry.date)} {entry.date.slice(0, 4)}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {shown.length > limit ? (
        <button type="button" className="mt-3 text-sm text-[var(--accent)] underline" onClick={() => setLimit((n) => n + PAGE)}>
          Pokaż więcej ({shown.length - limit})
        </button>
      ) : null}
      {entries && !shown.length ? <p className="text-sm text-[var(--muted)]">Nic nie pasuje.</p> : null}
    </div>
  );
}
