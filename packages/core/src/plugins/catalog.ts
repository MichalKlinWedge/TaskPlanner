/**
 * Katalog pluginów (SPECYFIKACJA M21, D21): opis każdego pluginu — schematy konfiguracji (bez sekretów),
 * sekretów i akcji reguły oraz pola formularzy, z których aplikacje budują ustawienia. Wykonanie jest
 * wkompilowane w Edge Function (`supabase/functions/_shared/plugins/<id>.ts`) — nie ładuje się kodu w locie.
 */
import { z } from 'zod';

import type { PluginEvent } from './events.ts';
import { PLUGIN_EVENTS } from './events.ts';
import type { TemplateEscape } from './template.ts';

/** Pole formularza połączenia albo akcji reguły. */
export interface PluginField {
  key: string;
  label: string;
  kind: 'text' | 'url' | 'secret' | 'template';
  placeholder?: string;
  help?: string;
  /** Sekret, który aplikacja może wygenerować (przycisk „Generuj”). */
  generate?: boolean;
  optional?: boolean;
}

export interface PluginDef {
  id: PluginId;
  name: string;
  description: string;
  configSchema: z.ZodType<Record<string, unknown>>;
  configFields: readonly PluginField[];
  /** Sekrety połączenia — idą od razu do Edge Function → Vault, klient ich potem nie odczyta. */
  secretSchema: z.ZodType<Record<string, string>>;
  secretFields: readonly PluginField[];
  actionSchema: z.ZodType<Record<string, unknown>>;
  actionFields: readonly PluginField[];
  /** Zdarzenia, które plugin obsługuje. */
  events: readonly PluginEvent[];
  /** Ucieczka wartości w szablonach akcji. */
  escape: TemplateEscape;
}

export const PluginId = z.enum(['webhook']);
export type PluginId = z.infer<typeof PluginId>;

/** Adres webhooka: `http(s)` — Edge Function i tak przyjmuje tylko `https` (poza fałszywymi usługami testów). */
const WebhookUrl = z
  .string()
  .trim()
  .max(2000, 'Adres jest za długi.')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Podaj pełny adres https://…');

const WEBHOOK: PluginDef = {
  id: 'webhook',
  name: 'Webhook',
  description:
    'Podpisany JSON (HMAC SHA-256) wysyłany metodą POST pod dowolny adres https — np. n8n, Make, Zapier albo własny serwer. ' +
    'Nagłówki: Idempotency-Key (id wysyłki), X-TaskPlanner-Event, X-TaskPlanner-Timestamp, X-TaskPlanner-Signature: sha256=HMAC(sekret, timestamp + "." + treść).',
  configSchema: z.object({ url: WebhookUrl }),
  configFields: [{ key: 'url', label: 'Adres webhooka', kind: 'url', placeholder: 'https://n8n.example.com/webhook/…' }],
  secretSchema: z.object({ signingSecret: z.string().trim().min(16, 'Sekret podpisu: co najmniej 16 znaków.').max(200) }),
  secretFields: [
    {
      key: 'signingSecret',
      label: 'Sekret podpisu (HMAC)',
      kind: 'secret',
      generate: true,
      help: 'Skopiuj go do odbiorcy, żeby sprawdzał podpis — później nie da się go tu odczytać.',
    },
  ],
  actionSchema: z.object({ message: z.string().max(2000, 'Treść: najwyżej 2000 znaków.').optional() }),
  actionFields: [
    {
      key: 'message',
      label: 'Treść (pole „message”)',
      kind: 'template',
      optional: true,
      placeholder: 'Nowe zgłoszenie: {{title}} ({{priority}}) — {{url}}',
    },
  ],
  events: PLUGIN_EVENTS,
  escape: 'plain',
};

export const PLUGINS: Record<PluginId, PluginDef> = { webhook: WEBHOOK };

export const pluginDef = (id: string): PluginDef | null => (PluginId.safeParse(id).success ? PLUGINS[id as PluginId] : null);

/** Losowy sekret (32 bajty, base64url) — przeglądarka, Hermes (polyfill) i Deno. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
