/**
 * Strona serwera dla silnika: RPC `push_changes` / `pull_changes` i sygnał Realtime.
 */
import type { Hlc } from '@taskplanner/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { RemoteRow } from './merge.ts';
import type { ReadonlyTable, SyncedTable } from './specs.ts';

export interface PushOp {
  op: string;
  table: SyncedTable;
  id: string;
  set: Record<string, unknown>;
  hlc: Hlc;
}

export interface RejectedOp {
  op: string;
  code: string;
  message: string;
}

export interface PushResult {
  applied: number;
  rejected: RejectedOp[];
  clamped: string[];
  /** Bieżące wiersze serwera dla odrzuconych i obciętych operacji (`row: null` = brak wiersza). */
  rows: { table: SyncedTable; id: string; row: RemoteRow | null }[];
  serverHlc: Hlc;
}

export interface ScopeInfo {
  kind: 'workspace' | 'personal';
  version: number;
  role: 'owner' | 'editor' | 'viewer';
  /** Listy przestrzeni ukryte przed tym użytkownikiem (`lists.guest_access = 'hidden'`, nie właściciel). */
  hidden?: string[];
  /** Liczba członków przestrzeni (z właścicielem) — > 1 = przestrzeń udostępniona. */
  members?: number;
}

/** Wiersz, który przestał być widoczny (ukryta lista) — klient usuwa swoją kopię. */
export interface GoneRow {
  table: SyncedTable;
  id: string;
}

export interface PullResult {
  scopes: Record<string, ScopeInfo>;
  tables: Partial<Record<SyncedTable | ReadonlyTable, RemoteRow[]>> & { _gone?: GoneRow[] };
  /** Jest dalszy ciąg: `scopes[id].version` to wtedy kursor, od którego pytać dalej. */
  more?: boolean;
  serverHlc: Hlc;
}

export interface Remote {
  push(ops: PushOp[]): Promise<PushResult>;
  pull(since: Record<string, number>, limit?: number): Promise<PullResult>;
  /** Sygnał „coś się zmieniło” (`onChange`) i gotowość subskrypcji (`onReady` — wtedy też trzeba pobrać). */
  subscribe?(onChange: () => void, onReady: () => void): () => void;
}

export function supabaseRemote(client: SupabaseClient, channelName = 'sync'): Remote {
  return {
    async push(ops) {
      const { data, error } = await client.rpc('push_changes', { p_ops: ops });
      if (error) throw new Error(`push_changes: ${error.message}`);
      return data as PushResult;
    },
    async pull(since, limit) {
      const { data, error } = await client.rpc('pull_changes', limit ? { p_since: since, p_limit: limit } : { p_since: since });
      if (error) throw new Error(`pull_changes: ${error.message}`);
      return data as PullResult;
    },
    subscribe(onChange, onReady) {
      const channel = client
        .channel(channelName)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sync_scopes' }, () => onChange())
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') onReady();
        });
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
