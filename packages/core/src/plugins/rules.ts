/**
 * Reguły pluginów (SPECYFIKACJA M21): „Gdy [wyzwalacz] i [filtr] → [akcja przez połączenie]”. Filtr = zwykły
 * `FilterQuery`, dopasowany tą samą funkcją co zapisane filtry (`matchesFilter`). Wiersze `plugin_rules`
 * i `plugin_requests` są synchronizowane (zakres osobisty) — operacje idą przez `mutate` jak każda zmiana.
 * Etap I1: wyzwalacz ręczny „Wyślij do…”; zdarzeniowy (I2) już ma schemat i dopasowanie.
 */
import { z } from 'zod';

import { uuidv7 } from '../ids.ts';
import { keyBetween } from '../sort-key.ts';
import type { TaskOp } from '../tasks.ts';
import { FilterQuery, matchesFilter, type ViewTask } from '../views.ts';
import type { LocalDate } from '../schemas/primitives.ts';
import { pluginDef } from './catalog.ts';
import { RuleEvent, type PluginEvent } from './events.ts';
import { unknownTemplateFields } from './template.ts';

export const PluginTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('event'), events: z.array(RuleEvent).min(1), filter: FilterQuery.optional() }),
]);
export type PluginTrigger = z.infer<typeof PluginTrigger>;

/** Domyślne opóźnienie reguły zdarzeniowej (s): łączenie zdarzeń i „Cofnij” w ciągu kilku sekund. */
export const DEFAULT_DELAY_SEC = 20;

export const PluginRuleOptions = z.object({
  /** Opóźnienie wysyłki reguły zdarzeniowej (s); brak = `DEFAULT_DELAY_SEC`. */
  delaySec: z.number().int().min(0).max(3600).optional(),
  /** Także zadania z integracji (e-mail, kalendarz) — domyślnie nie (ochrona przed pętlami). */
  includeIntegrations: z.boolean().optional(),
});
export type PluginRuleOptions = z.infer<typeof PluginRuleOptions>;

export const PLUGIN_CONNECTION_STATUSES = ['active', 'disabled', 'error'] as const;
export type PluginConnectionStatus = (typeof PLUGIN_CONNECTION_STATUSES)[number];

/** Połączenie (tylko do odczytu u klienta — pisze Edge Function `plugins`). */
export interface PluginConnection {
  id: string;
  plugin: string;
  label: string;
  config: Record<string, unknown>;
  status: PluginConnectionStatus;
  lastError: string | null;
  lastUsedAt: string | null;
}

export interface PluginRule {
  id: string;
  name: string;
  connectionId: string;
  enabled: boolean;
  trigger: PluginTrigger;
  action: Record<string, unknown>;
  options: PluginRuleOptions;
  sortKey: string;
}

const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** Wiersz lokalnej bazy (jsonb jako tekst, boolean jako 0/1) → połączenie albo `null`. */
export function parsePluginConnection(row: Record<string, unknown>): PluginConnection | null {
  if (typeof row.id !== 'string' || typeof row.label !== 'string' || row.deleted_at) return null;
  const config = json(row.config);
  const status = PLUGIN_CONNECTION_STATUSES.includes(row.status as PluginConnectionStatus) ? (row.status as PluginConnectionStatus) : 'disabled';
  return {
    id: row.id,
    plugin: String(row.plugin ?? ''),
    label: row.label,
    config: config && typeof config === 'object' ? (config as Record<string, unknown>) : {},
    status,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    lastUsedAt: typeof row.last_used_at === 'string' ? row.last_used_at : null,
  };
}

/**
 * Wiersz `plugin_rules` → reguła albo `null` (usunięta albo z wyzwalaczem nieznanym tej wersji aplikacji —
 * np. czasowy z nowszej wersji: pomijamy zamiast psuć listę).
 */
export function parsePluginRule(row: Record<string, unknown>): PluginRule | null {
  if (typeof row.id !== 'string' || row.deleted_at) return null;
  const trigger = PluginTrigger.safeParse(json(row.trigger));
  if (!trigger.success) return null;
  const action = json(row.action);
  const options = PluginRuleOptions.safeParse(json(row.options) ?? {});
  return {
    id: row.id,
    name: String(row.name ?? ''),
    connectionId: String(row.connection_id ?? ''),
    enabled: row.enabled === true || row.enabled === 1,
    trigger: trigger.data,
    action: action && typeof action === 'object' ? (action as Record<string, unknown>) : {},
    options: options.success ? options.data : {},
    sortKey: String(row.sort_key ?? 'n'),
  };
}

/**
 * Czy reguła zdarzeniowa łapie te zdarzenia zadania: włączona, wspólne zdarzenie, filtr pasuje do zadania,
 * zadanie z integracji tylko z opcją `includeIntegrations`.
 */
export function ruleMatches(
  rule: PluginRule,
  events: readonly PluginEvent[],
  task: ViewTask,
  ctx: { today: LocalDate; fromIntegration?: boolean },
): boolean {
  if (!rule.enabled || rule.trigger.kind !== 'event') return false;
  if (ctx.fromIntegration && !rule.options.includeIntegrations) return false;
  const wanted = new Set<string>(rule.trigger.events);
  if (!events.some((e) => wanted.has(e))) return false;
  return rule.trigger.filter ? matchesFilter(rule.trigger.filter, ctx.today)(task) : true;
}

/** Reguły do „Wyślij do…”: ręczne, włączone, z aktywnym połączeniem; w kolejności `sort_key`. */
export function sendableRules(rules: readonly PluginRule[], connections: readonly PluginConnection[]): PluginRule[] {
  const active = new Set(connections.filter((c) => c.status === 'active').map((c) => c.id));
  return rules
    .filter((r) => r.enabled && r.trigger.kind === 'manual' && active.has(r.connectionId))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1));
}

// ── Operacje ─────────────────────────────────────────────────────────────────────────────────

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface PluginRuleDraft {
  /** Brak = nowa reguła. */
  id?: string;
  name: string;
  connectionId: string;
  enabled: boolean;
  trigger: PluginTrigger;
  action: Record<string, unknown>;
  options?: PluginRuleOptions;
}

/** Zapis reguły (nowa na końcu listy); akcja sprawdzona schematem pluginu połączenia. */
export function pluginRuleSaveOps(
  userId: string,
  rules: readonly PluginRule[],
  connections: readonly PluginConnection[],
  draft: PluginRuleDraft,
  newId: () => string = () => uuidv7(),
): Result<{ id: string; ops: TaskOp[] }> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: 'Nazwa reguły nie może być pusta.' };
  if (name.length > 100) return { ok: false, error: 'Nazwa reguły: najwyżej 100 znaków.' };
  const connection = connections.find((c) => c.id === draft.connectionId);
  if (!connection) return { ok: false, error: 'Wybierz połączenie.' };
  const def = pluginDef(connection.plugin);
  if (!def) return { ok: false, error: 'Ta wersja aplikacji nie zna tego pluginu.' };
  const trigger = PluginTrigger.safeParse(draft.trigger);
  if (!trigger.success) return { ok: false, error: 'Niepoprawny wyzwalacz reguły.' };
  const cleaned = Object.fromEntries(Object.entries(draft.action).filter(([, v]) => v !== '' && v !== undefined));
  const action = def.actionSchema.safeParse(cleaned);
  if (!action.success) return { ok: false, error: action.error.issues[0]?.message ?? 'Niepoprawna akcja.' };
  for (const value of Object.values(action.data)) {
    const unknown = typeof value === 'string' ? unknownTemplateFields(value) : [];
    if (unknown.length) return { ok: false, error: `Nieznane pole szablonu: {{${unknown[0]}}}.` };
  }
  const options = PluginRuleOptions.safeParse(draft.options ?? {});
  if (!options.success) return { ok: false, error: 'Niepoprawne opcje reguły.' };
  const existing = draft.id ? rules.find((r) => r.id === draft.id) : undefined;
  const id = existing?.id ?? newId();
  const last = [...rules].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)).at(-1)?.sortKey;
  return {
    ok: true,
    id,
    ops: [
      {
        table: 'plugin_rules',
        id,
        patch: {
          ...(!existing && { scope_id: userId, sort_key: keyBetween(last) }),
          name,
          connection_id: connection.id,
          enabled: draft.enabled,
          trigger: trigger.data,
          action: action.data,
          options: options.data,
        },
      },
    ],
  };
}

export const pluginRuleEnableOps = (ruleId: string, enabled: boolean): TaskOp[] => [{ table: 'plugin_rules', id: ruleId, patch: { enabled } }];

export const pluginRuleDeleteOps = (ruleId: string, now: Date = new Date()): TaskOp[] => [
  { table: 'plugin_rules', id: ruleId, patch: { deleted_at: now.toISOString() } },
];

/** „Wyślij do…”: jedna prośba na zadanie (offline — wyjdzie po synchronizacji). */
export const pluginRequestOps = (userId: string, ruleId: string, taskIds: readonly string[], now: Date = new Date(), newId: () => string = () => uuidv7(now.getTime())): TaskOp[] =>
  taskIds.map((taskId) => ({
    table: 'plugin_requests',
    id: newId(),
    patch: { scope_id: userId, rule_id: ruleId, task_id: taskId, requested_at: now.toISOString() },
  }));
