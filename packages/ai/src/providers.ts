/**
 * Dostawcy modeli.
 *
 * Przeniesione z ExpeditionPlan. Różnica: tam klucz był jeden, projektu; w Task Plannerze każdy
 * użytkownik podpina własny klucz (BYOK), trzymany w Supabase Vault, a zapytania idą z Edge
 * Function `ai` — nigdy z przeglądarki ani z APK. Na start tylko Gemini (`docs/USLUGI.md`);
 * Claude i OpenAI dojdą po sprawdzeniu ich warunków.
 */

export const providers = ['GEMINI'] as const;
export type Provider = (typeof providers)[number];

/** Nazwa modelu po ludzku — tak, jak mówi o nim użytkownik. */
export const PROVIDER_LABELS: Record<Provider, string> = {
  GEMINI: 'Gemini',
};

/** Kto stoi za modelem. Przy zdaniu „dane idą do…” liczy się firma, nie nazwa modelu. */
export const PROVIDER_COMPANIES: Record<Provider, string> = {
  GEMINI: 'Google',
};

/**
 * Wariant domyślny, gdy konto nie wskazuje innego. Pusto znaczy „nie zgadujemy”: nazwy modeli
 * wycofują się szybciej niż wychodzą wersje aplikacji, a jedyne pewne źródło to lista pobrana od
 * dostawcy (`listModels`, potem `defaultModel`).
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  GEMINI: '',
};

/** Obraz doklejony do zapytania: typ MIME i zawartość w base64. */
export type AiImage = { mimeType: string; data: string };

export type AskOptions = {
  image?: AiImage | null;
  /** Instrukcja systemowa: rola i reguły, osobno od treści zadania. */
  system?: string;
  /** Najdłuższa odpowiedź — za ciasno i JSON urwie się w połowie. */
  maxTokens?: number;
  timeoutMs?: number;
  /** Zużycie tokenów z odpowiedzi dostawcy. */
  onUsage?: (usage: AiUsage) => void;
};

export type AiUsage = { inputTokens: number; outputTokens: number };
