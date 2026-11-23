/**
 * Wykonanie pluginu (SPECYFIKACJA M21): moduł wkompilowany w Edge Function `plugins`. Opis pluginu
 * (schematy, pola formularzy) jest w `packages/core/src/plugins/catalog.ts`, tu — wysyłka. Bez Deno.
 */
import type { PluginPayload } from '../../../../packages/core/src/plugins/payload.ts';

/** Sieć wstrzykiwana (Deno w funkcji, atrapy w testach Node) — ochrona SSRF jak w `link-preview`. */
export interface NetDeps {
  fetch: typeof fetch;
  /** Adresy IP nazwy (A i AAAA). */
  resolve: (host: string) => Promise<string[]>;
  /** Hosty (`nazwa:port`) bez blokady adresów prywatnych i `https` — tylko fałszywe usługi testów integracyjnych. */
  allowHosts?: readonly string[];
  timeoutMs?: number;
}

export interface RuntimeContext {
  /** Konfiguracja połączenia (bez sekretów), już sprawdzona schematem pluginu. */
  config: Record<string, unknown>;
  /** Sekrety połączenia z Vault. */
  secrets: Record<string, string>;
  net: NetDeps;
  now: () => Date;
}

export type DeliveryResult =
  | { ok: true; externalId?: string; externalUrl?: string; httpStatus?: number }
  | { ok: false; retryable: boolean; retryAfterSec?: number; disable?: boolean; error: string; httpStatus?: number };

export interface PluginRuntime {
  /** Dodatkowe sprawdzenie konfiguracji przy zapisie połączenia (np. tylko `https`); `null` = poprawna. */
  validateConfig(config: Record<string, unknown>, net: Pick<NetDeps, 'allowHosts'>): string | null;
  /** „Wyślij próbne”. */
  test(ctx: RuntimeContext): Promise<DeliveryResult>;
  deliver(ctx: RuntimeContext, delivery: { id: string; payload: PluginPayload }): Promise<DeliveryResult>;
}
