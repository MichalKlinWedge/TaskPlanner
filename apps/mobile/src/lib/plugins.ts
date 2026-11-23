/**
 * Integracje wychodzące (M21, etap I1) na telefonie: tylko „Wyślij do…” — reguły ręczne z aktywnym
 * połączeniem z lokalnej bazy (połączenia przychodzą synchronizacją, tylko do odczytu). Połączenia i reguły
 * ustawia się na webie (Ustawienia → „Integracje”); prośba `plugin_requests` zapisuje się lokalnie i wychodzi
 * z serwera po synchronizacji.
 */
import { parsePluginConnection, parsePluginRule, sendableRules, type PluginConnection, type PluginRule } from '@taskplanner/core';

import type { SqlRow } from '@taskplanner/sync';

import { useLocalQuery } from './local-query';

type Row = SqlRow;

export function useSendableRules(): PluginRule[] {
  return (
    useLocalQuery(['plugin_connections', 'plugin_rules'], async (engine) => {
      const [connections, rules] = await Promise.all([
        engine.db.all<Row>('select id, plugin, label, config, status, last_error, last_used_at from plugin_connections'),
        engine.db.all<Row>('select id, name, connection_id, enabled, trigger, action, options, sort_key from plugin_rules where deleted_at is null'),
      ]);
      return sendableRules(
        rules.map(parsePluginRule).filter((r): r is PluginRule => r !== null),
        connections.map(parsePluginConnection).filter((c): c is PluginConnection => c !== null),
      );
    }) ?? []
  );
}
