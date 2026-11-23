"use client";

/**
 * Ustawienia → „Integracje” (M21, etap I1): połączenia z usługami zewnętrznymi (na razie Webhook), reguły
 * „Wyślij do…” z szablonem treści i historia wysyłek z „Ponów”. Połączenia zmienia Edge Function `plugins`
 * (online; sekret idzie od razu do Vault i nie da się go potem odczytać), reguły zapisują się lokalnie
 * (offline też), historia jest na serwerze (`plugin_deliveries`, tylko odczyt — wymaga sieci).
 */
import {
  DELIVERY_STATUS,
  generateSecret,
  PLUGIN_CONNECTION_STATUS,
  PLUGINS,
  pluginDef,
  pluginRuleDeleteOps,
  pluginRuleEnableOps,
  pluginRuleSaveOps,
  TEMPLATE_FIELDS,
  type PluginConnection,
  type PluginDef,
  type PluginRule,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useCallback, useEffect, useState } from "react";

import { createPluginConnection, deletePluginConnection, retryPluginDelivery, testPluginConnection, updatePluginConnection, usePlugins } from "@/lib/plugins";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { Button, Card, Field, Input, Notice, Select } from "./ui";

type Message = { tone: "error" | "ok"; text: string } | null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dateTime = (iso: string) => new Date(iso).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });

export function PluginsCard({ store, userId }: { store: TabStore; userId: string }) {
  const { connections, rules } = usePlugins(store);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ tone: "ok", text: ok });
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4">
      <h2 className="mb-1 text-sm font-semibold">Integracje</h2>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Wysyłaj zadania do innych usług: połączenie mówi dokąd, reguła — co wysłać. Zadanie wysyłasz z panelu zadania („Wyślij do…”) albo paletą poleceń; bez sieci prośba czeka i
        wychodzi z serwera po synchronizacji. Nieudane wysyłki serwer ponawia przez kilkanaście godzin.
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <h3 className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Połączenia</h3>
      {connections.length ? (
        <ul className="mb-3 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
          {connections.map((c) => (
            <ConnectionItem key={c.id} connection={c} busy={busy} act={act} />
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-[var(--muted)]">Brak połączeń.</p>
      )}
      <NewConnection busy={busy} act={act} />

      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Reguły „Wyślij do…”</h3>
      <Rules store={store} userId={userId} rules={rules} connections={connections} setMessage={setMessage} />

      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Historia wysyłek</h3>
      <Deliveries rules={rules} connections={connections} />
    </Card>
  );
}

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function ConnectionItem({ connection: c, busy, act }: { connection: PluginConnection; busy: boolean; act: Act }) {
  const def = pluginDef(c.plugin);
  const [secretOpen, setSecretOpen] = useState(false);
  return (
    <li className="p-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{c.label}</span>
        <span className="text-xs text-[var(--muted)]">
          {def?.name ?? c.plugin} · {PLUGIN_CONNECTION_STATUS[c.status]}
          {typeof c.config.url === "string" ? ` · ${c.config.url}` : ""}
          {c.lastUsedAt ? ` · ostatnio ${dateTime(c.lastUsedAt)}` : ""}
        </span>
      </div>
      {c.lastError && c.status !== "active" ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{c.lastError}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          disabled={busy || c.status !== "active"}
          onClick={() =>
            act(async () => {
              const r = await testPluginConnection(c.id);
              if (!r.ok) throw new Error(`Wysyłka próbna nieudana: ${r.error ?? "nieznany błąd"}`);
            }, `Wysyłka próbna do „${c.label}” dotarła.`)
          }
        >
          Wyślij próbne
        </Button>
        <Button kind="ghost" disabled={busy} onClick={() => act(() => updatePluginConnection(c.id, { enabled: c.status !== "active" }))}>
          {c.status === "active" ? "Wyłącz" : "Włącz"}
        </Button>
        {def?.secretFields.length ? (
          <Button kind="ghost" disabled={busy} onClick={() => setSecretOpen((o) => !o)} aria-expanded={secretOpen}>
            Nowy sekret
          </Button>
        ) : null}
        <Button
          kind="danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Usunąć połączenie „${c.label}”? Reguły z nim przestaną wysyłać.`)) void act(() => deletePluginConnection(c.id), "Połączenie usunięte.");
          }}
        >
          Usuń
        </Button>
      </div>
      {secretOpen && def ? (
        <SecretForm
          def={def}
          busy={busy}
          onSubmit={(secrets) =>
            act(async () => {
              await updatePluginConnection(c.id, { secrets });
              setSecretOpen(false);
            }, "Sekret zmieniony — wpisz go też u odbiorcy.")
          }
        />
      ) : null}
    </li>
  );
}

function SecretInputs({ def, values, onChange }: { def: PluginDef; values: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  return (
    <>
      {def.secretFields.map((f) => (
        <Field key={f.key} label={f.label} hint={f.help}>
          <div className="flex gap-2">
            <Input value={values[f.key] ?? ""} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} autoComplete="off" spellCheck={false} className="min-w-0 flex-1 font-mono" />
            {f.generate ? (
              <Button kind="ghost" onClick={() => onChange({ ...values, [f.key]: generateSecret() })}>
                Generuj
              </Button>
            ) : null}
          </div>
        </Field>
      ))}
    </>
  );
}

function SecretForm({ def, busy, onSubmit }: { def: PluginDef; busy: boolean; onSubmit: (secrets: Record<string, string>) => void }) {
  const [secrets, setSecrets] = useState<Record<string, string>>(() => Object.fromEntries(def.secretFields.filter((f) => f.generate).map((f) => [f.key, generateSecret()])));
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(secrets);
      }}
    >
      <SecretInputs def={def} values={secrets} onChange={setSecrets} />
      <Button type="submit" kind="primary" disabled={busy}>
        Zapisz sekret
      </Button>
    </form>
  );
}

function NewConnection({ busy, act }: { busy: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  const [plugin, setPlugin] = useState<string>(Object.keys(PLUGINS)[0] ?? "webhook");
  const def = pluginDef(plugin);
  const [label, setLabel] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const start = () => {
    setOpen((o) => !o);
    if (def) setSecrets(Object.fromEntries(def.secretFields.filter((f) => f.generate).map((f) => [f.key, generateSecret()])));
  };

  if (!open || !def)
    return (
      <Button disabled={busy} onClick={start} aria-expanded={open}>
        + Połączenie
      </Button>
    );
  return (
    <form
      className="space-y-2 rounded-md border border-[var(--line)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const parsedConfig = def.configSchema.safeParse(config);
        if (!parsedConfig.success) return void act(async () => Promise.reject(new Error(parsedConfig.error.issues[0]?.message ?? "Niepoprawne dane.")));
        const parsedSecrets = def.secretSchema.safeParse(secrets);
        if (!parsedSecrets.success) return void act(async () => Promise.reject(new Error(parsedSecrets.error.issues[0]?.message ?? "Niepoprawny sekret.")));
        void act(async () => {
          await createPluginConnection({ plugin: def.id, label: label.trim() || def.name, config: parsedConfig.data, secrets: parsedSecrets.data });
          setOpen(false);
          setLabel("");
          setConfig({});
        }, "Połączenie dodane — sprawdź je przyciskiem „Wyślij próbne”.");
      }}
    >
      <Field label="Usługa">
        <Select value={plugin} onChange={(e) => setPlugin(e.target.value)}>
          {Object.values(PLUGINS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-xs text-[var(--muted)]">{def.description}</p>
      <Field label="Nazwa">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={def.name} maxLength={100} />
      </Field>
      {def.configFields.map((f) => (
        <Field key={f.key} label={f.label} hint={f.help}>
          <Input value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} placeholder={f.placeholder} type={f.kind === "url" ? "url" : "text"} />
        </Field>
      ))}
      <SecretInputs def={def} values={secrets} onChange={setSecrets} />
      <div className="flex gap-2">
        <Button type="submit" kind="primary" disabled={busy}>
          Dodaj połączenie
        </Button>
        <Button kind="ghost" onClick={() => setOpen(false)}>
          Anuluj
        </Button>
      </div>
    </form>
  );
}

interface RuleDraftState {
  id?: string;
  name: string;
  connectionId: string;
  action: Record<string, string>;
}

function Rules({
  store,
  userId,
  rules,
  connections,
  setMessage,
}: {
  store: TabStore;
  userId: string;
  rules: PluginRule[];
  connections: PluginConnection[];
  setMessage: (m: Message) => void;
}) {
  const [draft, setDraft] = useState<RuleDraftState | null>(null);
  const connection = (id: string) => connections.find((c) => c.id === id);
  const write = (ops: Parameters<TabStore["mutateMany"]>[0], ok?: string) =>
    store.mutateMany(ops).then(
      () => ok && setMessage({ tone: "ok", text: ok }),
      (e: unknown) => setMessage({ tone: "error", text: errorText(e) }),
    );

  const save = () => {
    if (!draft) return;
    const existing = draft.id ? rules.find((r) => r.id === draft.id) : undefined;
    const result = pluginRuleSaveOps(userId, rules, connections, {
      id: draft.id,
      name: draft.name,
      connectionId: draft.connectionId,
      enabled: existing?.enabled ?? true,
      trigger: existing?.trigger ?? { kind: "manual" },
      action: draft.action,
      options: existing?.options,
    });
    if (!result.ok) return setMessage({ tone: "error", text: result.error });
    void write(result.ops, draft.id ? "Reguła zapisana." : "Reguła dodana — jest w „Wyślij do…”.");
    setDraft(null);
  };

  const def = draft ? pluginDef(connection(draft.connectionId)?.plugin ?? "") : null;
  return (
    <>
      {rules.length ? (
        <ul className="mb-3 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
          {rules.map((r) => {
            const c = connection(r.connectionId);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => void write(pluginRuleEnableOps(r.id, e.target.checked))} aria-label={`Reguła „${r.name}” włączona`} />
                  <span className="font-medium">{r.name}</span>
                </label>
                <span className="text-xs text-[var(--muted)]">
                  → {c ? c.label : "połączenie usunięte"}
                  {c && c.status !== "active" ? ` (${PLUGIN_CONNECTION_STATUS[c.status]})` : ""}
                  {r.trigger.kind !== "manual" ? " · zdarzeniowa (wkrótce)" : ""}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button
                    kind="ghost"
                    onClick={() => setDraft({ id: r.id, name: r.name, connectionId: r.connectionId, action: Object.fromEntries(Object.entries(r.action).map(([k, v]) => [k, String(v ?? "")])) })}
                  >
                    Edytuj
                  </Button>
                  <Button
                    kind="ghost"
                    onClick={() => {
                      if (window.confirm(`Usunąć regułę „${r.name}”?`)) void write(pluginRuleDeleteOps(r.id), "Reguła usunięta.");
                    }}
                  >
                    Usuń
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-[var(--muted)]">{connections.length ? "Brak reguł." : "Najpierw dodaj połączenie."}</p>
      )}
      {draft ? (
        <form
          className="space-y-2 rounded-md border border-[var(--line)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="Nazwa (widoczna w „Wyślij do…”)">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={100} placeholder="np. Zgłoszenie do n8n" />
          </Field>
          <Field label="Połączenie">
            <Select value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          {def?.actionFields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.kind === "template" ? `Pola: ${TEMPLATE_FIELDS.map((t) => `{{${t.key}}}`).join(" ")}` : f.help}>
              <textarea
                className="min-h-16 w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm"
                value={draft.action[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setDraft({ ...draft, action: { ...draft.action, [f.key]: e.target.value } })}
              />
            </Field>
          ))}
          <div className="flex gap-2">
            <Button type="submit" kind="primary">
              {draft.id ? "Zapisz regułę" : "Dodaj regułę"}
            </Button>
            <Button kind="ghost" onClick={() => setDraft(null)}>
              Anuluj
            </Button>
          </div>
        </form>
      ) : (
        <Button disabled={!connections.length} onClick={() => setDraft({ name: "", connectionId: connections.find((c) => c.status === "active")?.id ?? connections[0]?.id ?? "", action: {} })}>
          + Reguła
        </Button>
      )}
    </>
  );
}

interface DeliveryRow {
  id: string;
  rule_id: string | null;
  connection_id: string | null;
  status: keyof typeof DELIVERY_STATUS;
  attempts: number;
  next_attempt_at: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  title: string | null;
}

const RETRYABLE = new Set(["failed", "dead", "skipped"]);
const TONE: Record<"muted" | "ok" | "error", string> = {
  muted: "text-[var(--muted)]",
  ok: "text-green-700 dark:text-green-300",
  error: "text-red-700 dark:text-red-300",
};

function Deliveries({ rules, connections }: { rules: PluginRule[]; connections: PluginConnection[] }) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabaseBrowser()
      .from("plugin_deliveries")
      .select("id, rule_id, connection_id, status, attempts, next_attempt_at, error, created_at, sent_at, title:payload->task->>title")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) setProblem(navigator.onLine ? `Nie udało się wczytać historii: ${error.message}` : "Historia jest na serwerze — wczyta się po powrocie sieci.");
    else {
      setProblem(null);
      setRows(data as unknown as DeliveryRow[]);
    }
  }, []);

  useEffect(() => {
    // Wczytanie przy pokazaniu karty (zapytanie do serwera, nie do lokalnej bazy).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const retry = async (id: string) => {
    setBusy(true);
    try {
      await retryPluginDelivery(id);
      await load();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ruleName = (id: string | null) => rules.find((r) => r.id === id)?.name;
  const connectionLabel = (id: string | null) => connections.find((c) => c.id === id)?.label;
  return (
    <>
      <div className="mb-2">
        <Button kind="ghost" disabled={busy} onClick={() => void load()}>
          Odśwież
        </Button>
      </div>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {rows && !rows.length ? <p className="text-sm text-[var(--muted)]">Jeszcze nic nie wysłano.</p> : null}
      {rows?.length ? (
        <ul className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
          {rows.map((d) => {
            const status = DELIVERY_STATUS[d.status] ?? { label: d.status, tone: "muted" as const };
            return (
              <li key={d.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 p-2 text-sm">
                <span className={`text-xs font-medium ${TONE[status.tone]}`}>{status.label}</span>
                <span className="min-w-0 flex-1 truncate">{d.title ?? "(zadanie)"}</span>
                <span className="text-xs text-[var(--muted)]">
                  {ruleName(d.rule_id) ?? connectionLabel(d.connection_id) ?? ""} · {dateTime(d.sent_at ?? d.created_at)}
                  {d.status === "pending" && d.attempts > 0 && d.next_attempt_at ? ` · próba ${d.attempts + 1} o ${dateTime(d.next_attempt_at)}` : ""}
                </span>
                {RETRYABLE.has(d.status) ? (
                  <Button kind="ghost" disabled={busy} onClick={() => void retry(d.id)}>
                    Ponów
                  </Button>
                ) : null}
                {d.error ? <p className="w-full text-xs text-[var(--muted)]">{d.error}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
