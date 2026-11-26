/**
 * Integracje wychodzące (M21) na telefonie: „Wyślij do…” (reguły ręczne z aktywnym połączeniem), lista reguł
 * z włączaniem / wyłączaniem i ostatnie wysyłki z „Ponów”. Połączenia przychodzą synchronizacją (tylko do odczytu);
 * połączenia i treść reguł ustawia się na webie (Ustawienia → „Integracje”). Reguły i prośby `plugin_requests`
 * zapisują się lokalnie i wychodzą z serwera po synchronizacji; historia wysyłek jest tylko na serwerze
 * (`plugin_deliveries`, RLS: własne, 30 dni — wymaga sieci).
 */
import { parsePluginConnection, parsePluginRule, sendableRules, type DELIVERY_STATUS, type PluginConnection, type PluginRule } from '@taskplanner/core';

import type { SqlRow } from '@taskplanner/sync';

import { sessionUser } from './config';
import { useLocalQuery } from './local-query';
import { supabaseClient } from './sync';

type Row = SqlRow;

/** Połączenia i reguły z lokalnej bazy (działa offline), w kolejności jak na webie. */
export function usePlugins(): { connections: PluginConnection[]; rules: PluginRule[] } | undefined {
  return useLocalQuery(['plugin_connections', 'plugin_rules'], async (engine) => {
    const [connections, rules] = await Promise.all([
      engine.db.all<Row>('select id, plugin, label, config, status, last_error, last_used_at from plugin_connections order by created_at, id'),
      engine.db.all<Row>('select id, name, connection_id, enabled, trigger, action, options, sort_key from plugin_rules where deleted_at is null order by sort_key, id'),
    ]);
    return {
      connections: connections.map(parsePluginConnection).filter((c): c is PluginConnection => c !== null),
      rules: rules.map(parsePluginRule).filter((r): r is PluginRule => r !== null),
    };
  });
}

export function useSendableRules(): PluginRule[] {
  const plugins = usePlugins();
  return plugins ? sendableRules(plugins.rules, plugins.connections) : [];
}

export interface DeliveryRow {
  id: string;
  rule_id: string | null;
  connection_id: string | null;
  task_id: string | null;
  status: keyof typeof DELIVERY_STATUS;
  attempts: number;
  next_attempt_at: string | null;
  http_status: number | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  external_url: string | null;
  title: string | null;
}

const DELIVERY_COLUMNS = 'id, rule_id, connection_id, task_id, status, attempts, next_attempt_at, http_status, error, created_at, sent_at, external_url, title:payload->task->>title';

/** Ostatnie wysyłki z serwera (najnowsze pierwsze). */
export async function recentDeliveries(limit: number): Promise<DeliveryRow[]> {
  if (!sessionUser().online) throw new Error('Historia wysyłek jest na serwerze — zaloguj się.');
  const { data, error } = await supabaseClient().from('plugin_deliveries').select(DELIVERY_COLUMNS).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as DeliveryRow[];
}

/** „Ponów” w historii wysyłek (RPC — tylko własne wysyłki). */
export async function retryPluginDelivery(id: string): Promise<void> {
  const { error } = await supabaseClient().rpc('retry_plugin_delivery', { p_delivery: id });
  if (error) throw new Error(error.message);
}
