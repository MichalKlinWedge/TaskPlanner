"use client";

/**
 * Ustawienia → „Integracje” (M21, etapy I1–I3): połączenia z usługami zewnętrznymi (Webhook, GitLab), reguły
 * ręczne („Wyślij do…”) i zdarzeniowe (zdarzenia + filtr + opóźnienie) z szablonem treści i podglądem ładunku
 * oraz zmianą zadania po udanej wysyłce (tagi, status), historia wysyłek z „Ponów” (zwijana, 10 ostatnich; całość
 * z filtrami na ekranie `#/deliveries` — `DeliveryLogScreen`). Połączenia zmienia Edge Function `plugins`
 * (online; sekret idzie od razu do Vault i nie da się go potem odczytać), reguły zapisują się lokalnie
 * (offline też), historia jest na serwerze (`plugin_deliveries`, tylko odczyt — wymaga sieci).
 */
import {
  afterSendSummary,
  compareText,
  DEFAULT_DELAY_SEC,
  DELIVERY_STATUS,
  generateSecret,
  isEmptyFilter,
  matchesFilter,
  normalizeText,
  PLUGIN_EVENT,
  PLUGIN_CONNECTION_STATUS,
  PLUGINS,
  pluginDef,
  pluginRuleDeleteOps,
  pluginRuleEnableOps,
  pluginRuleSaveOps,
  RULE_EVENTS,
  rulePreview,
  SAMPLE_TASK,
  TASK_STATUS,
  TEMPLATE_FIELDS,
  viewTaskData,
  type FilterQuery,
  type PluginConnection,
  type PluginDef,
  type PluginRule,
  type PluginTaskData,
  type PluginTrigger,
  type RuleEvent,
  type TaskStatus,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useLocalQuery } from "@/lib/local-store";
import { createPluginConnection, deletePluginConnection, retryPluginDelivery, testPluginConnection, updatePluginConnection, usePlugins } from "@/lib/plugins";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { useAppEnv } from "./app-env";
import { FilterBar } from "./filter-bar";
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
        Wysyłaj zadania do innych usług: połączenie mówi dokąd, reguła — kiedy i co wysłać. Regułę ręczną wybierasz przy zadaniu („Wyślij do…” w panelu albo paletą), zdarzeniowa
        wysyła sama, gdy np. zadanie dostanie tag. Bez sieci zmiany czekają i wychodzą z serwera po synchronizacji. Nieudane wysyłki serwer ponawia przez kilkanaście godzin.
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

      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Reguły</h3>
      <Rules store={store} userId={userId} rules={rules} connections={connections} setMessage={setMessage} />

      <DeliveriesSection rules={rules} connections={connections} />
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
          {typeof c.config.project === "string" ? ` · ${c.config.project}${typeof c.config.baseUrl === "string" && c.config.baseUrl !== "https://gitlab.com" ? ` (${c.config.baseUrl})` : ""}` : ""}
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
            <Input
              value={values[f.key] ?? ""}
              onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
              type={f.generate ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono"
            />
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
        // Puste pole = wartość domyślna schematu (np. adres gitlab.com).
        const parsedConfig = def.configSchema.safeParse(Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim() !== "")));
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
  enabled: boolean;
  kind: "manual" | "event";
  events: RuleEvent[];
  filter: FilterQuery;
  delaySec: number;
  includeIntegrations: boolean;
  /** Po udanej wysyłce: tagi dodane / zdjęte, status (`""` = bez zmiany). */
  addTagIds: string[];
  removeTagIds: string[];
  status: TaskStatus | "";
}

/** Opóźnienie wysyłki reguły zdarzeniowej (s) do wyboru. */
const DELAYS: { value: number; label: string }[] = [
  { value: 0, label: "od razu" },
  { value: DEFAULT_DELAY_SEC, label: `${DEFAULT_DELAY_SEC} s (domyślnie)` },
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
  { value: 900, label: "15 min" },
  { value: 3600, label: "1 godz." },
];

const delayLabel = (sec: number) => DELAYS.find((d) => d.value === sec)?.label.replace(" (domyślnie)", "") ?? `${sec} s`;

const draftOf = (r: PluginRule): RuleDraftState => ({
  id: r.id,
  name: r.name,
  connectionId: r.connectionId,
  action: Object.fromEntries(Object.entries(r.action).map(([k, v]) => [k, String(v ?? "")])),
  enabled: r.enabled,
  kind: r.trigger.kind,
  events: r.trigger.kind === "event" ? [...r.trigger.events] : [],
  filter: r.trigger.kind === "event" ? (r.trigger.filter ?? {}) : {},
  delaySec: r.options.delaySec ?? DEFAULT_DELAY_SEC,
  includeIntegrations: !!r.options.includeIntegrations,
  addTagIds: r.options.afterSend?.addTagIds ?? [],
  removeTagIds: r.options.afterSend?.removeTagIds ?? [],
  status: r.options.afterSend?.status ?? "",
});

const triggerOf = (d: RuleDraftState): PluginTrigger =>
  d.kind === "manual" ? { kind: "manual" } : { kind: "event", events: RULE_EVENTS.filter((e) => d.events.includes(e)), ...(isEmptyFilter(d.filter) ? {} : { filter: d.filter }) };

/** Opis wyzwalacza na liście reguł. */
function triggerSummary(r: PluginRule): string {
  if (r.trigger.kind !== "event") return "„Wyślij do…”";
  const events = r.trigger.events.map((e) => PLUGIN_EVENT[e]).join(", ");
  return `gdy: ${events}${r.trigger.filter && !isEmptyFilter(r.trigger.filter) ? " (z filtrem)" : ""} · po ${delayLabel(r.options.delaySec ?? DEFAULT_DELAY_SEC)}`;
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
  const { data } = useAppEnv();
  const tagName = (id: string) => data.tags.find((t) => t.id === id)?.name;
  const connection = (id: string) => connections.find((c) => c.id === id);
  const write = (ops: Parameters<TabStore["mutateMany"]>[0], ok?: string) =>
    store.mutateMany(ops).then(
      () => ok && setMessage({ tone: "ok", text: ok }),
      (e: unknown) => setMessage({ tone: "error", text: errorText(e) }),
    );

  const save = () => {
    if (!draft) return;
    if (draft.kind === "event" && !draft.events.length) return setMessage({ tone: "error", text: "Zaznacz co najmniej jedno zdarzenie." });
    const result = pluginRuleSaveOps(userId, rules, connections, {
      id: draft.id,
      name: draft.name,
      connectionId: draft.connectionId,
      enabled: draft.enabled,
      trigger: triggerOf(draft),
      action: draft.action,
      options: {
        ...(draft.kind === "event" && { delaySec: draft.delaySec, ...(draft.includeIntegrations && { includeIntegrations: true }) }),
        afterSend: { addTagIds: draft.addTagIds, removeTagIds: draft.removeTagIds, ...(draft.status && { status: draft.status }) },
      },
    });
    if (!result.ok) return setMessage({ tone: "error", text: result.error });
    const ok = draft.id ? "Reguła zapisana." : draft.kind === "event" ? "Reguła dodana — wysyła sama, gdy zajdzie zdarzenie." : "Reguła dodana — jest w „Wyślij do…”.";
    void write(result.ops, ok);
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
                  {c && c.status !== "active" ? ` (${PLUGIN_CONNECTION_STATUS[c.status]})` : ""} · {triggerSummary(r)}
                  {afterSendSummary(r.options.afterSend, tagName) ? ` · ${afterSendSummary(r.options.afterSend, tagName)}` : ""}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button kind="ghost" onClick={() => setDraft(draftOf(r))}>
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
          aria-label="Reguła"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label={draft.kind === "manual" ? "Nazwa (widoczna w „Wyślij do…”)" : "Nazwa"}>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={100} placeholder={draft.kind === "manual" ? "np. Zgłoszenie do n8n" : "np. Tag #zgłoś → n8n"} />
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
          <Field label="Kiedy wysłać">
            <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as RuleDraftState["kind"] })}>
              <option value="manual">Ręcznie — „Wyślij do…” przy zadaniu</option>
              <option value="event">Samo, gdy zajdzie zdarzenie</option>
            </Select>
          </Field>
          {draft.kind === "event" ? <EventFields draft={draft} setDraft={setDraft} /> : null}
          {def?.actionFields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.help}>
              {f.singleLine ? (
                <Input value={draft.action[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setDraft({ ...draft, action: { ...draft.action, [f.key]: e.target.value } })} />
              ) : (
                <textarea
                  className="min-h-16 w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm"
                  value={draft.action[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setDraft({ ...draft, action: { ...draft.action, [f.key]: e.target.value } })}
                />
              )}
            </Field>
          ))}
          {def?.actionFields.some((f) => f.kind === "template") ? (
            <p className="text-xs text-[var(--muted)]">
              Pola do wstawienia w szablonach:{" "}
              {TEMPLATE_FIELDS.map((t, i) => (
                <span key={t.key}>
                  {i ? ", " : ""}
                  <code>{`{{${t.key}}}`}</code> — {t.label.charAt(0).toLowerCase() + t.label.slice(1)}
                </span>
              ))}
              .
            </p>
          ) : null}
          <AfterSendFields draft={draft} setDraft={setDraft} />
          {def ? <RulePreview draft={draft} def={def} /> : null}
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
        <Button
          disabled={!connections.length}
          onClick={() =>
            setDraft({
              name: "",
              connectionId: connections.find((c) => c.status === "active")?.id ?? connections[0]?.id ?? "",
              action: {},
              enabled: true,
              kind: "manual",
              events: [],
              filter: {},
              delaySec: DEFAULT_DELAY_SEC,
              includeIntegrations: false,
              addTagIds: [],
              removeTagIds: [],
              status: "",
            })
          }
        >
          + Reguła
        </Button>
      )}
    </>
  );
}

/** Zdarzenia, filtr i opcje reguły zdarzeniowej. */
function EventFields({ draft, setDraft }: { draft: RuleDraftState; setDraft: (d: RuleDraftState) => void }) {
  const toggle = (e: RuleEvent) => setDraft({ ...draft, events: draft.events.includes(e) ? draft.events.filter((x) => x !== e) : [...draft.events, e] });
  return (
    <>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-medium">Zdarzenia</legend>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {RULE_EVENTS.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.events.includes(e)} onChange={() => toggle(e)} />
              {PLUGIN_EVENT[e]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <p className="mb-1 text-xs font-medium">Tylko zadania pasujące do filtra (bez filtra — wszystkie)</p>
        <FilterBar query={draft.filter} onChange={(filter) => setDraft({ ...draft, filter })} />
      </div>
      <Field label="Opóźnienie wysyłki" hint="Zmiany w tym czasie łączą się w jedną wysyłkę; cofnięte („Cofnij”) nie wychodzą wcale.">
        <Select value={String(draft.delaySec)} onChange={(e) => setDraft({ ...draft, delaySec: Number(e.target.value) })}>
          {(DELAYS.some((d) => d.value === draft.delaySec) ? DELAYS : [...DELAYS, { value: draft.delaySec, label: `${draft.delaySec} s` }]).map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.includeIntegrations} onChange={(e) => setDraft({ ...draft, includeIntegrations: e.target.checked })} />
        Także zadania z integracji (e-mail, kalendarz)
      </label>
    </>
  );
}

/**
 * Lista tagów jako „chipy” z ✕ i wyborem kolejnego: własne i wspólne (kopie tagów innych członków
 * udostępnionych przestrzeni — serwer przypnie je tylko zadaniom z tych przestrzeni, `plugin_after_send`).
 */
function TagIdsField({ label, value, exclude, onChange }: { label: string; value: string[]; exclude: string[]; onChange: (ids: string[]) => void }) {
  const { data } = useAppEnv();
  const choices = useMemo(() => {
    const space = (id: string) => data.workspaces.find((w) => w.id === id)?.name;
    return data.tags
      .map((t) => ({ id: t.id, label: t.shared ? `${t.name} (wspólny: ${(t.workspaceIds ?? []).map(space).filter(Boolean).join(", ") || "przestrzeń udostępniona"})` : t.name, name: t.name }))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.label, b.label));
  }, [data.tags, data.workspaces]);
  const name = (id: string) => data.tags.find((t) => t.id === id)?.name ?? "(usunięty tag)";
  const free = choices.filter((t) => !value.includes(t.id) && !exclude.includes(t.id));
  return (
    // Nie `Field` (`<label>`): klik w podpis „kliknąłby” pierwszy ✕.
    <div className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        {value.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-[var(--hover)] px-2 py-0.5 text-xs">
            #{name(id)}
            <button type="button" aria-label={`Usuń tag ${name(id)} z listy „${label}”`} onClick={() => onChange(value.filter((x) => x !== id))} className="text-[var(--muted)]">
              ✕
            </button>
          </span>
        ))}
        <Select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} aria-label={label} className="w-auto">
          <option value="">{free.length ? "+ tag…" : "brak tagów do wyboru"}</option>
          {free.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/** Zmiana zadania po udanej wysyłce (serwer, `plugin_after_send`). */
function AfterSendFields({ draft, setDraft }: { draft: RuleDraftState; setDraft: (d: RuleDraftState) => void }) {
  return (
    <fieldset className="space-y-2 rounded-md border border-[var(--line)] p-2">
      <legend className="px-1 text-xs font-medium">Po udanej wysyłce zmień zadanie</legend>
      <TagIdsField label="Dodaj tagi" value={draft.addTagIds} exclude={draft.removeTagIds} onChange={(addTagIds) => setDraft({ ...draft, addTagIds })} />
      <TagIdsField label="Zdejmij tagi" value={draft.removeTagIds} exclude={draft.addTagIds} onChange={(removeTagIds) => setDraft({ ...draft, removeTagIds })} />
      <Field label="Ustaw status">
        <Select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as RuleDraftState["status"] })}>
          <option value="">bez zmiany</option>
          {(Object.keys(TASK_STATUS) as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS[s]}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-xs text-[var(--muted)]">
        Zmienia serwer zaraz po wysłaniu (także z „Wyślij do…”) — zadanie musi być do edycji. Taka zmiana liczy się jak z integracji: reguły zdarzeniowe bez „Także zadania z integracji” jej nie widzą, więc nie ma pętli. Tag wspólny (innego członka przestrzeni) trafia tylko do zadań z tej przestrzeni. Status „Gotowe” / „Anulowane” nie zmienia zadania cyklicznego.
      </p>
    </fieldset>
  );
}

const PREVIEW_SAMPLE = "";

/** Podgląd ładunku: dokładnie to, co serwer wyśle dla wybranego zadania (albo przykładowego). */
function RulePreview({ draft, def }: { draft: RuleDraftState; def: PluginDef }) {
  const { store, data, today } = useAppEnv();
  const [search, setSearch] = useState("");
  const [taskId, setTaskId] = useState(PREVIEW_SAMPLE);
  const found = useMemo(() => {
    const q = normalizeText(search.trim());
    if (!q) return [];
    return data.tasks.filter((t) => t.kind === "task" && normalizeText(t.title).includes(q)).slice(0, 20);
  }, [data.tasks, search]);
  const task = taskId ? data.tasks.find((t) => t.id === taskId) : undefined;
  const description = useLocalQuery<{ description_md: string | null }>(store, "select description_md from tasks where id = ?", [taskId], ["tasks"]).rows[0]?.description_md ?? null;
  const trigger = triggerOf(draft);

  const preview = useMemo(() => {
    let taskData: PluginTaskData = SAMPLE_TASK;
    if (task) {
      const list = data.lists.find((l) => l.id === task.listId);
      const tagNames = new Map(data.tags.map((t) => [t.id, t.name]));
      taskData = viewTaskData(task, {
        list: list?.name ?? "",
        listKind: list?.kind ?? "list",
        workspace: data.workspaces.find((w) => w.id === task.workspaceId)?.name ?? null,
        tags: task.tagIds.map((id) => tagNames.get(id)).filter((n): n is string => !!n),
        assignee: task.assigneeId ? (data.collaborators.find((c) => c.id === task.assigneeId)?.name ?? null) : null,
        description,
      });
    }
    return rulePreview({
      rule: { id: draft.id ?? SAMPLE_TASK.id, name: draft.name.trim() || "(bez nazwy)", trigger },
      def,
      action: draft.action,
      task: taskData,
      appUrl: window.location.origin,
    });
    // `trigger` liczony z `draft` — wystarczą zależności od szkicu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, def, task, description, data.lists, data.tags, data.workspaces, data.collaborators]);

  const fits = task && trigger.kind === "event" && trigger.filter ? matchesFilter(trigger.filter, today)(task) : null;
  return (
    <details className="rounded-md border border-[var(--line)] p-2">
      <summary className="cursor-pointer text-xs font-medium">{def.linksTasks ? "Podgląd żądania" : "Podgląd ładunku"}</summary>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Szukaj zadania do podglądu…" aria-label="Szukaj zadania do podglądu" className="min-w-0 flex-1" />
          <Select value={taskId} onChange={(e) => setTaskId(e.target.value)} aria-label="Zadanie do podglądu" className="min-w-0 flex-1">
            <option value={PREVIEW_SAMPLE}>Przykładowe zadanie</option>
            {task && !found.includes(task) ? <option value={task.id}>{task.title}</option> : null}
            {found.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        </div>
        {fits !== null ? (
          <p className={`text-xs ${fits ? TONE.ok : TONE.error}`}>{fits ? "To zadanie pasuje do filtra reguły." : "To zadanie nie pasuje do filtra — reguła by go nie wysłała."}</p>
        ) : null}
        <p className="text-xs text-[var(--muted)]">
          {trigger.kind === "event"
            ? "Wszystkie zaznaczone zdarzenia w jednej wysyłce; naprawdę idą te, które zaszły w oknie opóźnienia. Id i czas wysyłki są przykładowe."
            : "Id i czas wysyłki są przykładowe."}
          {def.linksTasks
            ? " Pokazane jest nowe issue; gdy zadanie ma już issue z tego połączenia, wysyłka je zmienia (stan, termin, etykiety, notatka), a ponowne „Wyślij do…” aktualizuje też tytuł i opis."
            : ""}
        </p>
        <p className="text-xs font-medium">
          {preview.request.method} {preview.request.path}
        </p>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--hover)] p-2 text-xs">{JSON.stringify(preview.request.body, null, 2)}</pre>
      </div>
    </details>
  );
}

interface DeliveryRow {
  id: string;
  rule_id: string | null;
  connection_id: string | null;
  task_id: string | null;
  source: string;
  events: string[] | null;
  status: keyof typeof DELIVERY_STATUS;
  attempts: number;
  next_attempt_at: string | null;
  http_status: number | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  title: string | null;
  external_url: string | null;
}

const DELIVERY_COLUMNS = "id, rule_id, connection_id, task_id, source, events, status, attempts, next_attempt_at, http_status, error, created_at, sent_at, external_url, title:payload->task->>title";
const RETRYABLE = new Set(["failed", "dead", "skipped"]);
const TONE: Record<"muted" | "ok" | "error", string> = {
  muted: "text-[var(--muted)]",
  ok: "text-green-700 dark:text-green-300",
  error: "text-red-700 dark:text-red-300",
};
const SOURCE: Record<string, string> = { manual: "„Wyślij do…”", event: "zdarzenie", schedule: "harmonogram" };

interface DeliveryFilter {
  connectionId?: string;
  status?: keyof typeof DELIVERY_STATUS;
}

/**
 * Ostatnie wysyłki z serwera: limit w zapytaniu (o jeden wiersz więcej, żeby wiedzieć, czy jest „więcej”),
 * filtr po połączeniu i stanie. Historia jest tylko na serwerze (RLS: własne wysyłki, retencja 30 dni).
 */
function useDeliveries(limit: number, filter: DeliveryFilter = {}) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { connectionId, status } = filter;

  const load = useCallback(async () => {
    let query = supabaseBrowser().from("plugin_deliveries").select(DELIVERY_COLUMNS);
    if (connectionId) query = query.eq("connection_id", connectionId);
    if (status) query = query.eq("status", status);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(limit + 1);
    if (error) {
      setProblem(navigator.onLine ? `Nie udało się wczytać historii: ${error.message}` : "Historia jest na serwerze — wczyta się po powrocie sieci.");
      return;
    }
    const all = (data ?? []) as unknown as DeliveryRow[];
    setProblem(null);
    setMore(all.length > limit);
    setRows(all.slice(0, limit));
  }, [limit, connectionId, status]);

  useEffect(() => {
    // Wczytanie przy pokazaniu (zapytanie do serwera, nie do lokalnej bazy) i po zmianie filtra / limitu.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return { rows, more, problem, setProblem, load };
}

/** Lista wysyłek; `detailed` = ekran historii (próby, HTTP, zdarzenia, pełny błąd, zadanie). */
function DeliveryList({
  rows,
  rules,
  connections,
  busy,
  onRetry,
  detailed = false,
}: {
  rows: DeliveryRow[];
  rules: PluginRule[];
  connections: PluginConnection[];
  busy: boolean;
  onRetry: (id: string) => void;
  detailed?: boolean;
}) {
  const { openTask } = useAppEnv();
  const ruleName = (id: string | null) => rules.find((r) => r.id === id)?.name;
  const connectionLabel = (id: string | null) => connections.find((c) => c.id === id)?.label;
  return (
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
            {d.external_url && /^https?:\/\//.test(d.external_url) ? (
              <a href={d.external_url} target="_blank" rel="noreferrer noopener" className="text-xs text-[var(--accent)] underline">
                Otwórz ↗
              </a>
            ) : null}
            {RETRYABLE.has(d.status) ? (
              <Button kind="ghost" disabled={busy} onClick={() => onRetry(d.id)}>
                Ponów
              </Button>
            ) : null}
            {detailed ? (
              <p className="w-full text-xs text-[var(--muted)]">
                {connectionLabel(d.connection_id) ?? "połączenie usunięte"} · {SOURCE[d.source] ?? d.source}
                {d.source !== "manual" && d.events?.length ? ` · ${d.events.map((e) => PLUGIN_EVENT[e as RuleEvent] ?? e).join(", ")}` : ""}
                {` · prób: ${d.attempts}`}
                {d.http_status ? ` · HTTP ${d.http_status}` : ""}
                {` · utworzona ${dateTime(d.created_at)}`}
                {d.task_id ? (
                  <>
                    {" · "}
                    <button type="button" className="text-[var(--accent)] underline" onClick={() => openTask(d.task_id)}>
                      zadanie
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            {d.error ? <p className={`w-full text-xs text-[var(--muted)] ${detailed ? "whitespace-pre-wrap break-words" : "truncate"}`}>{d.error}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

function useRetry(load: () => Promise<void>, setProblem: (p: string | null) => void) {
  const [busy, setBusy] = useState(false);
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
  return { busy, retry: (id: string) => void retry(id) };
}

/** Ile ostatnich wysyłek w Ustawieniach (reszta na ekranie historii `#/deliveries`). */
const RECENT_DELIVERIES = 10;
const HISTORY_OPEN_KEY = "tp-plugin-history-open";

const readOpen = (): boolean => {
  try {
    return window.localStorage.getItem(HISTORY_OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

/** „Historia wysyłek” w Ustawieniach: zwijana (stan w `localStorage`), zwinięta nic nie pobiera. */
function DeliveriesSection({ rules, connections }: { rules: PluginRule[]; connections: PluginConnection[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // `localStorage` dopiero po zamontowaniu (bez rozjazdu z renderem serwera).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(readOpen());
  }, []);
  const toggle = () => {
    setOpen(!open);
    try {
      if (open) window.localStorage.removeItem(HISTORY_OPEN_KEY);
      else window.localStorage.setItem(HISTORY_OPEN_KEY, "1");
    } catch {
      // Bez pamięci przeglądarki — stan tylko do przeładowania.
    }
  };
  return (
    <section className="mt-5" aria-label="Historia wysyłek">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="plugin-deliveries"
        onClick={toggle}
        className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        <span aria-hidden className={`inline-block w-3 transition-transform ${open ? "rotate-90" : ""}`}>
          ▸
        </span>
        Historia wysyłek
      </button>
      {open ? (
        <div id="plugin-deliveries">
          <RecentDeliveries rules={rules} connections={connections} />
        </div>
      ) : null}
    </section>
  );
}

function RecentDeliveries({ rules, connections }: { rules: PluginRule[]; connections: PluginConnection[] }) {
  const { rows, more, problem, setProblem, load } = useDeliveries(RECENT_DELIVERIES);
  const { busy, retry } = useRetry(load, setProblem);
  return (
    <>
      <div className="mb-2 flex gap-2">
        <Button kind="ghost" disabled={busy} onClick={() => void load()}>
          Odśwież
        </Button>
      </div>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {rows && !rows.length ? <p className="text-sm text-[var(--muted)]">Jeszcze nic nie wysłano.</p> : null}
      {rows?.length ? <DeliveryList rows={rows} rules={rules} connections={connections} busy={busy} onRetry={retry} /> : null}
      {rows?.length ? (
        <a href="#/deliveries" className="mt-2 inline-block text-sm text-[var(--accent)] underline">
          {more ? "Więcej — cała historia z filtrami →" : "Szczegóły i filtry →"}
        </a>
      ) : null}
    </>
  );
}

/** Wysyłek na stronę ekranu historii („Pokaż więcej” dobiera kolejne). */
const LOG_PAGE = 50;

/** Ekran `#/deliveries`: cała historia wysyłek (30 dni) z filtrami po połączeniu i stanie, szczegóły, „Ponów”. */
export function DeliveryLogScreen() {
  const { store } = useAppEnv();
  const { connections, rules } = usePlugins(store);
  const [filter, setFilter] = useState<DeliveryFilter>({});
  const [limit, setLimit] = useState(LOG_PAGE);
  const { rows, more, problem, setProblem, load } = useDeliveries(limit, filter);
  const { busy, retry } = useRetry(load, setProblem);
  const change = (next: DeliveryFilter) => {
    setFilter(next);
    setLimit(LOG_PAGE);
  };
  return (
    <div className="mx-auto max-w-3xl">
      <a href="#/settings" className="text-sm text-[var(--accent)] underline">
        ← Ustawienia
      </a>
      <h1 className="mb-1 mt-2 text-xl font-semibold">Historia wysyłek</h1>
      <p className="mb-3 text-sm text-[var(--muted)]">Wysyłki pluginów z ostatnich 30 dni (starsze serwer usuwa). Historia jest na serwerze — wymaga sieci.</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={filter.connectionId ?? ""} onChange={(e) => change({ ...filter, connectionId: e.target.value || undefined })} aria-label="Połączenie" className="w-auto">
          <option value="">Wszystkie połączenia</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select value={filter.status ?? ""} onChange={(e) => change({ ...filter, status: (e.target.value || undefined) as DeliveryFilter["status"] })} aria-label="Stan" className="w-auto">
          <option value="">Każdy stan</option>
          {(Object.keys(DELIVERY_STATUS) as (keyof typeof DELIVERY_STATUS)[]).map((s) => (
            <option key={s} value={s}>
              {DELIVERY_STATUS[s].label}
            </option>
          ))}
        </Select>
        <Button kind="ghost" disabled={busy} onClick={() => void load()}>
          Odśwież
        </Button>
      </div>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {rows === null && !problem ? <p className="text-sm text-[var(--muted)]">Wczytywanie…</p> : null}
      {rows && !rows.length ? <p className="text-sm text-[var(--muted)]">{filter.connectionId || filter.status ? "Brak wysyłek dla tego filtra." : "Jeszcze nic nie wysłano."}</p> : null}
      {rows?.length ? <DeliveryList rows={rows} rules={rules} connections={connections} busy={busy} onRetry={retry} detailed /> : null}
      {more ? (
        <div className="mt-3">
          <Button kind="ghost" onClick={() => setLimit(limit + LOG_PAGE)}>
            Pokaż więcej
          </Button>
        </div>
      ) : null}
    </div>
  );
}
