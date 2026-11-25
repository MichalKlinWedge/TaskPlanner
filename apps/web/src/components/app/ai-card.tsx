"use client";

/**
 * Ustawienia → „Asystent AI” (v1.x): własne konto AI użytkownika (BYOK, na start Gemini). Wklejony klucz idzie
 * do Edge Function `ai` (Vault) i nie wraca; konto, lista modeli i stan przychodzą synchronizacją (`ai_accounts`).
 * „Sprawdź” = lista modeli na kluczu; model wybiera się z niej (domyślnie najnowszy Flash-Lite). Zmiany — online.
 */
import { AI_ACCOUNT_STATUS, AI_BILLING_STATEMENT, AI_INTRO, AI_PROVIDER, AI_PROVIDERS, aiDataNote, aiModelLabel, type AiAccount, type AiProvider } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useState } from "react";

import { createAiAccount, deleteAiAccount, testAiAccount, updateAiAccount, useAiAccount } from "@/lib/ai";

import { CollapsibleCard } from "./collapsible-card";
import { Button, Field, Input, Notice, Select } from "./ui";

const dateTime = (iso: string) => new Date(iso).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
const TONE = { ok: "text-green-700 dark:text-green-400", error: "text-red-700 dark:text-red-400", muted: "text-[var(--muted)]" } as const;

type Message = { tone: "ok" | "error" | "info"; text: string } | null;

export function AiCard({ store }: { store: TabStore }) {
  const account = useAiAccount(store);
  const [editingKey, setEditingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  /** Wywołanie funkcji `ai` i od razu synchronizacja — zmieniony wiersz konta wraca do lokalnej bazy. */
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

  const check = (accountId: string): Promise<Message> =>
    testAiAccount(accountId).then((r) =>
      r.ok ? { tone: "ok", text: `Klucz działa — dostępnych modeli: ${r.models.length}. Wybrany: ${r.model ?? "—"}.` } : { tone: "error", text: r.error },
    );

  const saveKey = (provider: AiProvider, key: string) =>
    run(async () => {
      const id = account ? (await updateAiAccount(account.id, { key, billingConfirmed: true }), account.id) : (await createAiAccount({ provider, key, billingConfirmed: true })).accountId;
      setEditingKey(false);
      return check(id);
    });

  return (
    <CollapsibleCard id="ai" title="Asystent AI" alert={account?.status === "error"}>
      <p className="mb-3 text-xs text-[var(--muted)]">{AI_INTRO}</p>

      {account ? <AccountSummary account={account} busy={busy} onModel={(model) => run(async () => (await updateAiAccount(account.id, { model }), null))} /> : null}

      {!account || editingKey ? (
        <KeyForm
          key={account?.id ?? "nowe"}
          provider={account?.provider ?? "gemini"}
          replacing={!!account}
          busy={busy}
          onSubmit={saveKey}
          onCancel={account ? () => setEditingKey(false) : undefined}
        />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => run(() => check(account.id))}>
            {busy ? "Sprawdzanie…" : "Sprawdź"}
          </Button>
          <Button kind="ghost" disabled={busy} onClick={() => setEditingKey(true)}>
            Zmień klucz
          </Button>
          <Button
            kind="ghost"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Odłączyć konto ${AI_PROVIDER[account.provider].label}? Klucz zostanie usunięty z serwera, a funkcje ✨ znikną.`)) return;
              void run(async () => (await deleteAiAccount(account.id), { tone: "info", text: "Konto AI odłączone, klucz usunięty z serwera." }));
            }}
          >
            Odłącz
          </Button>
        </div>
      )}

      {/* Błąd „Sprawdź” jest już na koncie jako „Ostatni błąd” — bez powtórzenia. */}
      {message && !(message.tone === "error" && message.text === account?.lastError) ? (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-[var(--muted)]">{aiDataNote(account?.provider ?? "gemini")}</p>
    </CollapsibleCard>
  );
}

function AccountSummary({ account, busy, onModel }: { account: AiAccount; busy: boolean; onModel: (model: string) => void }) {
  const status = AI_ACCOUNT_STATUS[account.status];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        <span className="font-medium">{AI_PROVIDER[account.provider].label}</span>
        {account.keyHint ? <span className="text-[var(--muted)]"> · klucz {account.keyHint}</span> : null}
        {" · "}
        <span className={TONE[status.tone]}>{status.label}</span>
        {account.verifiedAt && account.status === "active" ? <span className="text-xs text-[var(--muted)]"> (sprawdzone {dateTime(account.verifiedAt)})</span> : null}
      </p>
      {account.lastError ? <Notice tone="error">Ostatni błąd: {account.lastError}</Notice> : null}
      {account.models.length ? (
        <Field label="Model" hint="Lista pochodzi od dostawcy dla Twojego klucza. Domyślnie najtańszy Flash-Lite — wystarcza do funkcji ✨.">
          <Select value={account.model ?? ""} disabled={busy} onChange={(e) => e.target.value && onModel(e.target.value)} aria-label="Model AI">
            {account.model ? null : <option value="">— wybierz —</option>}
            {account.models.map((m) => (
              <option key={m.id} value={m.id}>
                {aiModelLabel(account, m.id)}
                {m.label !== m.id ? ` (${m.id})` : ""}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <p className="text-xs text-[var(--muted)]">Kliknij „Sprawdź”, żeby pobrać listę modeli dla tego klucza.</p>
      )}
    </div>
  );
}

function KeyForm({
  provider: initial,
  replacing,
  busy,
  onSubmit,
  onCancel,
}: {
  provider: AiProvider;
  replacing: boolean;
  busy: boolean;
  onSubmit: (provider: AiProvider, key: string) => void;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<AiProvider>(initial);
  const [key, setKey] = useState("");
  const [billing, setBilling] = useState(false);
  const info = AI_PROVIDER[provider];
  const ready = key.trim().length >= 20 && billing && !busy;
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(provider, key.trim());
      }}
    >
      <Field label="Dostawca">
        <Select value={provider} disabled={replacing || busy} onChange={(e) => setProvider(e.target.value as AiProvider)}>
          {AI_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {AI_PROVIDER[p].label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={replacing ? "Nowy klucz API" : "Klucz API"}>
        <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Wklej klucz z AI Studio" disabled={busy} />
      </Field>
      <p className="text-xs text-[var(--muted)]">
        {info.keyHelp}{" "}
        <a className="underline" href={info.keyUrl} target="_blank" rel="noreferrer noopener">
          Utwórz klucz w Google AI Studio
        </a>
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={billing} onChange={(e) => setBilling(e.target.checked)} disabled={busy} />
        <span>{AI_BILLING_STATEMENT}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" kind="primary" disabled={!ready}>
          {busy ? "Sprawdzanie…" : "Sprawdź"}
        </Button>
        {onCancel ? (
          <Button type="button" kind="ghost" disabled={busy} onClick={onCancel}>
            Anuluj
          </Button>
        ) : null}
      </div>
    </form>
  );
}
