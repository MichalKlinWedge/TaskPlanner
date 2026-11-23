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
  /** `skipped` = nic do zrobienia (powód trafia do historii jako „Pominięte”). */
  | { ok: true; externalId?: string; externalUrl?: string; httpStatus?: number; skipped?: string }
  | { ok: false; retryable: boolean; retryAfterSec?: number; disable?: boolean; error: string; httpStatus?: number };

/** Jedna wysyłka dla pluginu. */
export interface DeliveryInput {
  /** Id wysyłki (`Idempotency-Key`, znacznik w obiekcie u dostawcy). */
  id: string;
  payload: PluginPayload;
  /** Pola akcji reguły, wypełnione dla zadania (`renderActionFields`). */
  fields: Record<string, string>;
  /** Obiekt już powiązany z zadaniem przez to połączenie (`plugin_links`; pluginy z `linksTasks`). */
  link: { externalId: string; externalUrl: string | null } | null;
  /** Kolejna próba — poprzednia mogła utworzyć obiekt, choć odpowiedź nie dotarła. */
  retry: boolean;
}

export interface PluginRuntime {
  /** Dodatkowe sprawdzenie konfiguracji przy zapisie połączenia (np. tylko `https`); `null` = poprawna. */
  validateConfig(config: Record<string, unknown>, net: Pick<NetDeps, 'allowHosts'>): string | null;
  /** „Wyślij próbne”. */
  test(ctx: RuntimeContext): Promise<DeliveryResult>;
  deliver(ctx: RuntimeContext, delivery: DeliveryInput): Promise<DeliveryResult>;
}
