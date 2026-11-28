"use client";

/**
 * Ustawienia → „Integracje” → „Token API” (v1.x): token, którym inna aplikacja (Expedition Plan) zakłada
 * i aktualizuje zadania na wybranej liście (Edge Function `inbound-api`). Jawny token widać raz, zaraz po
 * utworzeniu (z kopiowaniem); potem tylko jego końcówkę. Odwołanie działa od razu. Zmiany — online.
 */
import { INBOUND_RATE_PER_MINUTE, MAX_API_TOKENS, type ApiToken } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useRef, useState } from "react";

import { listEditable } from "@/lib/app-data";
import { createApiToken, inboundApiUrl, revokeApiToken, useApiTokens } from "@/lib/api-tokens";

import { useAppEnv } from "./app-env";
import { Button, Field, Input, Notice, Select } from "./ui";

type Message = { tone: "error" | "ok"; text: string } | null;

const dateTime = (iso: string) => new Date(iso).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Świeżo utworzony token (pokazywany raz) w pamięci modułu: przetrwa wyjście z „Ustawień” w tej karcie,
 * aż do „Gotowe”; zamknięcie karty z niezatwierdzonym tokenem pyta (`beforeunload`).
 */
let pendingToken: { label: string; token: string } | null = null;

export function ApiTokensSection({ store }: { store: TabStore }) {
  const { data } = useAppEnv();
  const tokens = useApiTokens(store);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [created, setCreatedState] = useState<{ label: string; token: string } | null>(() => pendingToken);
  const setCreated = (value: { label: string; token: string } | null) => {
    pendingToken = value;
    setCreatedState(value);
  };
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!created) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [created]);
  const copyToken = (token: string) =>
    void copy(token).then((ok) => {
      setCopied(ok);
      if (ok) return;
      // Schowek niedostępny (uprawnienia, http) — zaznaczony tekst do skopiowania ręcznie.
      setMessage({ tone: "error", text: "Nie udało się skopiować — token jest zaznaczony, skopiuj go ręcznie (Ctrl+C)." });
      const node = codeRef.current;
      if (node) window.getSelection()?.selectAllChildren(node);
    });
  const [copied, setCopied] = useState(false);
  /** Formularz nowego tokenu pokazuje się dopiero po „+ Nowy token”. */
  const [adding, setAdding] = useState(false);

  /** Listy z prawem zapisu jako „Przestrzeń / Lista”. */
  const lists = useMemo(
    () =>
      data.lists
        .filter((l) => listEditable(data, l.id))
        .map((l) => ({ id: l.id, name: `${data.workspaces.find((w) => w.id === l.workspaceId)?.name ?? "?"} / ${l.name}` }))
        .sort((a, b) => a.name.localeCompare(b.name, "pl")),
    [data],
  );
  const listName = (id: string) => lists.find((l) => l.id === id)?.name ?? "lista niedostępna";

  const run = async (work: () => Promise<Message>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await work();
      await store.sync().catch(() => undefined);
      setMessage(result);
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="api-tokens">
      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Token API</h3>
      <p className="mb-2 text-xs text-[var(--muted)]">
        Token pozwala innej aplikacji (np. Expedition Plan) zakładać i aktualizować zadania na wybranej liście. Widzi tylko zadania, które sama założyła, a zmian, które zrobisz
        w Task Plannerze, nie nadpisuje. Zamknięcie zadania odeślesz regułą zdarzeniową Webhook („Zadanie ukończone”). Najwyżej {INBOUND_RATE_PER_MINUTE} zapytań na minutę.
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {created ? (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950" data-testid="api-token-created">
          <p className="mb-2 font-medium">Token „{created.label}” — skopiuj go teraz. Później zobaczysz tylko jego końcówkę.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code ref={codeRef} className="break-all rounded bg-[var(--surface)] px-2 py-1 text-xs" data-testid="api-token-value">
              {created.token}
            </code>
            <Button onClick={() => copyToken(created.token)}>{copied ? "Skopiowano" : "Kopiuj"}</Button>
            <Button
              kind="ghost"
              onClick={() => {
                setCreated(null);
                setCopied(false);
              }}
            >
              Gotowe
            </Button>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Adres API: <code className="break-all">{inboundApiUrl()}</code>
          </p>
        </div>
      ) : null}

      {tokens.length ? (
        <ul className="mb-3 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
          {tokens.map((t) => (
            <TokenItem key={t.id} token={t} listName={listName(t.listId)} busy={busy} onRevoke={() => run(async () => (await revokeApiToken(t.id), { tone: "ok", text: `Token „${t.label}” odwołany.` }))} />
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-[var(--muted)]">Brak tokenów.</p>
      )}

      {tokens.length < MAX_API_TOKENS ? (
        adding ? (
          <NewToken
            lists={lists}
            busy={busy}
            onCancel={() => setAdding(false)}
            onCreate={(label, listId) =>
              run(async () => {
                const r = await createApiToken({ label, listId });
                setCreated({ label, token: r.token });
                setCopied(false);
                setAdding(false);
                return null;
              })
            }
          />
        ) : (
          <Button
            onClick={() => {
              setAdding(true);
              setMessage(null);
            }}
          >
            + Nowy token
          </Button>
        )
      ) : (
        <p className="text-xs text-[var(--muted)]">Masz już {MAX_API_TOKENS} tokenów — odwołaj nieużywany, żeby dodać nowy.</p>
      )}
    </div>
  );
}

function TokenItem({ token: t, listName, busy, onRevoke }: { token: ApiToken; listName: string; busy: boolean; onRevoke: () => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
      <span>
        <span className="font-medium">{t.label}</span>
        <span className="text-xs text-[var(--muted)]">
          {" "}
          · {listName}
          {t.tokenHint ? ` · ${t.tokenHint}` : ""}
          {t.lastUsedAt ? ` · ostatnio ${dateTime(t.lastUsedAt)}` : " · jeszcze nieużyty"}
        </span>
      </span>
      <Button
        kind="ghost"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Odwołać token „${t.label}”? Aplikacja, która go używa, straci dostęp od razu. Założone zadania zostaną.`)) onRevoke();
        }}
      >
        Odwołaj
      </Button>
    </li>
  );
}

function NewToken({
  lists,
  busy,
  onCreate,
  onCancel,
}: {
  lists: { id: string; name: string }[];
  busy: boolean;
  onCreate: (label: string, listId: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("Expedition Plan");
  const [listId, setListId] = useState("");
  const chosen = listId || lists[0]?.id || "";
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-dashed border-[var(--line)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim() && chosen) onCreate(label.trim(), chosen);
      }}
    >
      <Field label="Nazwa tokenu" hint="Żeby wiedzieć, która aplikacja go używa.">
        <Input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} aria-label="Nazwa tokenu" />
      </Field>
      <Field label="Lista na nowe zadania" hint="Zadania możesz potem przenosić — aplikacja nadal je aktualizuje.">
        <Select value={chosen} onChange={(e) => setListId(e.target.value)} aria-label="Lista na nowe zadania">
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button type="submit" kind="primary" disabled={busy || !label.trim() || !chosen}>
          {busy ? "Tworzenie…" : "Utwórz token"}
        </Button>
        <Button kind="ghost" disabled={busy} onClick={onCancel}>
          Anuluj
        </Button>
      </div>
    </form>
  );
}
