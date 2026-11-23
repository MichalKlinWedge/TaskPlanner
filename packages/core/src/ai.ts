/**
 * Asystent AI na własnym koncie użytkownika (v1.x) — konto AI.
 *
 * Każdy użytkownik podpina własny klucz (BYOK); klucz trafia do Supabase Vault przez Edge Function `ai`
 * i nigdy nie wraca do klienta. Klienci dostają wiersz `ai_accounts` bez klucza w `pull_changes`
 * (tabela tylko do odczytu) — tu jego schemat, parsowanie i wejście tras `ai/accounts/*` (walidowane
 * tak samo w aplikacjach i w funkcji).
 */
import { z } from 'zod';

export const AI_PROVIDERS = ['gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_ACCOUNT_STATUSES = ['unverified', 'active', 'error'] as const;
export type AiAccountStatus = (typeof AI_ACCOUNT_STATUSES)[number];

/** Komunikat, gdy oświadczenie o rozliczeniu nie jest zaznaczone. */
export const AI_BILLING_REQUIRED = 'Zaznacz oświadczenie, że klucz pochodzi z projektu z włączonym rozliczeniem.';

/**
 * Klucz API. Bez założeń o prefiksie: stare klucze Google to `AIza…` (39 znaków), nowe „auth keys”
 * z AI Studio (od 28.05.2026) — `AQ.…` (53 znaki). Tylko widoczne znaki ASCII, bez spacji.
 */
export const AiKey = z
  .string()
  .trim()
  .min(20, 'Klucz jest za krótki — skopiuj go w całości.')
  .max(256, 'Klucz jest za długi — wklej sam klucz.')
  .regex(/^[\x21-\x7e]+$/, 'Klucz nie może zawierać spacji ani znaków spoza ASCII — wklej sam klucz.');

/** Identyfikator modelu dostawcy (`gemini-3.5-flash-lite`) — jak `isModelName` w `packages/ai`. */
export const AiModelId = z.string().max(100).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, 'Niepoprawna nazwa modelu.');

export const AiModelEntry = z.object({ id: AiModelId, label: z.string().max(200) });
export type AiModelEntry = z.infer<typeof AiModelEntry>;

/** `ai/accounts/create`: podpięcie konta. */
export const AiAccountCreate = z.object({
  provider: z.enum(AI_PROVIDERS),
  key: AiKey,
  billingConfirmed: z.literal(true, { error: AI_BILLING_REQUIRED }),
});
export type AiAccountCreate = z.infer<typeof AiAccountCreate>;

/** `ai/accounts/update`: nowy klucz (wymaga ponownego oświadczenia) i / albo wybór modelu z listy konta. */
export const AiAccountUpdate = z
  .object({
    accountId: z.uuid(),
    key: AiKey.optional(),
    billingConfirmed: z.boolean().optional(),
    model: AiModelId.optional(),
  })
  .refine((v) => v.key === undefined || v.billingConfirmed === true, { message: AI_BILLING_REQUIRED, path: ['billingConfirmed'] });
export type AiAccountUpdate = z.infer<typeof AiAccountUpdate>;

/** `ai/accounts/delete` i `ai/accounts/test`. */
export const AiAccountRef = z.object({ accountId: z.uuid() });

/** Odpowiedź `ai/accounts/test` („Sprawdź”). */
export type AiAccountTestResult =
  | { ok: true; models: AiModelEntry[]; model: string | null }
  | { ok: false; error: string; badKey: boolean };

/** Konto AI u klienta (tylko do odczytu — pisze Edge Function `ai`). */
export interface AiAccount {
  id: string;
  provider: AiProvider;
  model: string | null;
  models: AiModelEntry[];
  keyHint: string | null;
  status: AiAccountStatus;
  lastError: string | null;
  verifiedAt: string | null;
  billingConfirmedAt: string | null;
}

const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** Wiersz lokalnej bazy (jsonb jako tekst) → konto albo `null` (usunięte, nieznany dostawca). */
export function parseAiAccount(row: Record<string, unknown>): AiAccount | null {
  if (typeof row.id !== 'string' || row.deleted_at) return null;
  if (!AI_PROVIDERS.includes(row.provider as AiProvider)) return null;
  const models = z.array(AiModelEntry).safeParse(json(row.models));
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    id: row.id,
    provider: row.provider as AiProvider,
    model: text(row.model),
    models: models.success ? models.data : [],
    keyHint: text(row.key_hint),
    status: AI_ACCOUNT_STATUSES.includes(row.status as AiAccountStatus) ? (row.status as AiAccountStatus) : 'unverified',
    lastError: text(row.last_error),
    verifiedAt: text(row.verified_at),
    billingConfirmedAt: text(row.billing_confirmed_at),
  };
}

/** Końcówka klucza do rozpoznania („…x1Y2”) — jedyna część klucza, która wychodzi poza Vault. */
export const aiKeyHint = (key: string): string => `…${key.trim().slice(-4)}`;

/** Czy konto nadaje się do funkcji AI (przyciski ✨): sprawdzone i z wybranym modelem. */
export const aiAccountReady = (account: AiAccount | null | undefined): account is AiAccount =>
  !!account && account.status === 'active' && account.model !== null;

/** Nazwa modelu do pokazania: etykieta z listy dostawcy, bez niej identyfikator. */
export const aiModelLabel = (account: AiAccount, model = account.model): string =>
  (model && account.models.find((m) => m.id === model)?.label) || model || '—';
