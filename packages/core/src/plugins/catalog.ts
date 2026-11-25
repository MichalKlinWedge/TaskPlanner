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
  /** Wartość, gdy pole puste (szablon akcji albo konfiguracja). */
  defaultValue?: string;
  /** Pole jednowierszowe (formularz: `input` zamiast `textarea`). */
  singleLine?: boolean;
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
  /**
   * Plugin tworzy obiekt powiązany z zadaniem (issue) — kolejne wysyłki tego zadania przez to połączenie
   * zmieniają ten obiekt zamiast tworzyć nowy (powiązanie w `plugin_links`).
   */
  linksTasks?: boolean;
}

export const PluginId = z.enum(['webhook', 'gitlab']);
export type PluginId = z.infer<typeof PluginId>;

/** Adres `http(s)` bez danych logowania — Edge Function i tak przyjmuje tylko `https` (poza fałszywymi usługami testów). */
const HttpUrl = z
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
  configSchema: z.object({ url: HttpUrl }),
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
      help: 'Wszystkie pola szablonów są też zawsze wysyłane osobno, w obiekcie JSON „fields” (np. fields.title, fields.due).',
    },
  ],
  events: PLUGIN_EVENTS,
  escape: 'plain',
};

/** Domyślny opis issue: opis zadania i link do niego. */
export const GITLAB_DESCRIPTION = '{{description}}\n\n---\n[Zadanie w Task Plannerze]({{url}})';

const GITLAB: PluginDef = {
  id: 'gitlab',
  name: 'GitLab',
  description:
    'Zadanie jako issue w projekcie GitLab (gitlab.com albo własny serwer https). Issue jest powiązane z zadaniem: ' +
    'ukończenie i kosz je zamykają, przywrócenie otwiera, zmiana terminu ustawia termin (pole „Termin issue”), tag zmienia etykiety, zmiana odpowiedzialnego — przypisanych, ' +
    'komentarz dodaje notatkę, ponowne „Wyślij do…” aktualizuje tytuł, opis i szacowany czas. Token: Personal / Project Access Token z zakresem „api”.',
  configSchema: z.object({
    baseUrl: HttpUrl.default('https://gitlab.com'),
    project: z.string().trim().min(1, 'Podaj projekt (ścieżkę albo numer).').max(255, 'Projekt: najwyżej 255 znaków.'),
  }),
  configFields: [
    { key: 'baseUrl', label: 'Adres GitLaba', kind: 'url', placeholder: 'https://gitlab.com', defaultValue: 'https://gitlab.com', optional: true },
    { key: 'project', label: 'Projekt', kind: 'text', placeholder: 'grupa/projekt albo 12345', help: 'Ścieżka z adresu projektu albo jego numer (Project ID).' },
  ],
  secretSchema: z.object({ token: z.string().trim().min(8, 'Wklej token dostępu.').max(500) }),
  secretFields: [
    {
      key: 'token',
      label: 'Token dostępu (zakres „api”)',
      kind: 'secret',
      help: 'GitLab → Preferences → Access tokens (albo Settings → Access tokens projektu). Później nie da się go tu odczytać.',
    },
  ],
  actionSchema: z.object({
    title: z.string().max(500, 'Tytuł: najwyżej 500 znaków.').optional(),
    description: z.string().max(5000, 'Opis: najwyżej 5000 znaków.').optional(),
    labels: z.string().max(500, 'Etykiety: najwyżej 500 znaków.').optional(),
    dueDate: z
      .string()
      .max(100, 'Termin: najwyżej 100 znaków.')
      .refine((v) => /^\s*(\{\{\s*[a-z_]+\s*\}\}|\d{4}-\d{2}-\d{2})?\s*$/.test(v), 'Termin issue: pole szablonu (np. {{due}}) albo data RRRR-MM-DD.')
      .optional(),
    estimate: z
      .string()
      .max(100, 'Szacowany czas: najwyżej 100 znaków.')
      .refine((v) => !/\{\{\s*time\s*\}\}/.test(v), 'Szacowany czas: {{time}} to godzina zadania — czas w minutach to {{duration}}.')
      .refine((v) => /^\s*(\{\{\s*duration\s*\}\}|\d{1,6}|(\d+(mo|w|d|h|m)\s*)+)?\s*$/i.test(v), 'Szacowany czas: {{duration}}, minuty (np. 90) albo zapis GitLaba (np. 1h 30m).')
      .optional(),
    assignees: z.string().max(500, 'Przypisani: najwyżej 500 znaków.').optional(),
  }),
  actionFields: [
    { key: 'title', label: 'Tytuł issue', kind: 'template', optional: true, placeholder: '{{title}}', defaultValue: '{{title}}', singleLine: true },
    { key: 'description', label: 'Opis issue (Markdown)', kind: 'template', optional: true, placeholder: GITLAB_DESCRIPTION, defaultValue: GITLAB_DESCRIPTION },
    { key: 'labels', label: 'Etykiety (po przecinku)', kind: 'template', optional: true, placeholder: 'task-planner, {{tags}}', singleLine: true },
    {
      key: 'dueDate',
      label: 'Termin issue (Due date)',
      kind: 'template',
      optional: true,
      placeholder: '{{due}}',
      defaultValue: '{{due}}',
      singleLine: true,
      help: 'Domyślnie termin zadania ({{due}}); można wpisać stałą datę RRRR-MM-DD. Zadanie bez terminu — issue bez terminu.',
    },
    {
      key: 'estimate',
      label: 'Szacowany czas (Estimate)',
      kind: 'template',
      optional: true,
      placeholder: '{{duration}}',
      defaultValue: '{{duration}}',
      singleLine: true,
      help: 'Domyślnie pole „Czas (min)” zadania ({{duration}}); można wpisać stałą wartość w minutach (90) albo jak w GitLabie (1h 30m), 0 — nie wysyłaj. Ustawiany przy nowym issue i przy ponownym „Wyślij do…”; zadanie bez czasu nie zmienia estymaty w GitLabie.',
    },
    {
      key: 'assignees',
      label: 'Przypisz do (nazwy użytkowników GitLaba, po przecinku)',
      kind: 'template',
      optional: true,
      placeholder: 'jan.kowalski',
      singleLine: true,
      help: 'Nazwa z adresu profilu (gitlab.com/<nazwa>); {{assignee}} zadziała, gdy nazwy osób w Task Plannerze to nazwy z GitLaba. W planie Free GitLab bierze tylko pierwszą osobę.',
    },
  ],
  events: PLUGIN_EVENTS,
  escape: 'plain',
  linksTasks: true,
};

export const PLUGINS: Record<PluginId, PluginDef> = { webhook: WEBHOOK, gitlab: GITLAB };

export const pluginDef = (id: string): PluginDef | null => (PluginId.safeParse(id).success ? PLUGINS[id as PluginId] : null);

/** Losowy sekret (32 bajty, base64url) — przeglądarka, Hermes (polyfill) i Deno. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
