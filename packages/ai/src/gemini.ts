import { type AiModel, isModelName, normalizeModel, OTHER_WORK, sortModels } from './models.ts';
import type { AiImage, AskOptions } from './providers.ts';
import { describeStatus, isBusy } from './status.ts';
import { AiError, InvalidKeyError, logFailure, send } from './transport.ts';

/**
 * Gemini (Google Generative Language API).
 *
 * Klucz idzie nagłówkiem `x-goog-api-key`, nigdy parametrem `?key=` — adres zapytania trafia do logów
 * (funkcji, pośredników, `logFailure`). Nowe „auth keys” z AI Studio (od 28.05.2026, prefiks `AQ.`)
 * przechodzą tak samo jak stare `AIza…` — prefiksu nie sprawdzamy.
 */

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

const modelsUrl = (base: string | undefined) => `${(base ?? GEMINI_ENDPOINT).replace(/\/+$/, '')}/models`;
const headers = (key: string, extra: Record<string, string> = {}) => ({ 'x-goog-api-key': key, ...extra });

/** Na samą listę modeli czekamy krócej: to jedno zdanie odpowiedzi, nie praca modelu. */
const LIST_TIMEOUT_MS = 20_000;

/** Formaty, które Google przyjmuje jako załącznik w treści: obrazy i PDF (potwierdzenia rezerwacji). */
const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

export type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

/**
 * Części wiadomości. Obraz idzie **przed** tekstem: model czyta części po kolei, więc polecenie
 * odwołujące się do obrazu musi mieć go już za sobą. Nazwy pól w stylu REST API Google
 * (`inline_data`, `mime_type`), a nie w camelCase.
 */
export function contentParts(prompt: string, image?: AiImage | null): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (image != null) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  }
  parts.push({ text: prompt });
  return parts;
}

/** Odpowiedź w postaci, jakiej potrzebujemy. Każde pole może nie przyjść. */
type Reply = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  /** Tokeny „myślenia” liczą się do wyjścia (i do ceny wyjścia). */
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: ApiError;
};

/** Odmowa w formacie Google (`google.rpc.Status`). */
type ApiError = { message?: string; status?: string; details?: { reason?: string }[] };

/**
 * Zły klucz u Google to **HTTP 400** `INVALID_ARGUMENT` z „API key not valid” (powód `API_KEY_INVALID`),
 * a nie 401/403 — po samym kodzie wyglądałby jak błędne zapytanie.
 */
export function isInvalidKey(status: number, error: ApiError | undefined | null): boolean {
  if (status !== 400) return false;
  if (error?.details?.some((detail) => detail?.reason === 'API_KEY_INVALID')) return true;
  return /api key not valid|api_key_invalid/i.test(error?.message ?? '');
}

/** Odmowa Google jako `AiError`: awarię warto powtórzyć, odmowę z klucza albo z nazwy modelu — nie. */
function refusal(status: number, error: ApiError | undefined | null, model: string): AiError {
  if (isInvalidKey(status, error)) return new InvalidKeyError('GEMINI');
  return new AiError(describeStatus('GEMINI', status, error?.message, model), {
    retryable: status >= 500,
    modelGone: model !== '' && status === 404,
    busy: isBusy(status, error?.message),
    badKey: status === 401 || status === 403,
  });
}

export async function askGemini(
  key: string,
  model: string,
  prompt: string,
  options: AskOptions = {},
  base?: string,
): Promise<string> {
  const image = options.image;
  if (image != null && !IMAGES.includes(image.mimeType)) {
    throw new AiError('Gemini nie przyjmuje obrazów w tym formacie.');
  }

  const generationConfig: Record<string, unknown> = {
    // Prosimy o JSON wprost; sam kształt opisuje polecenie, a odpowiedź i tak przechodzi przez
    // walidator Zod — schemat Gemini to osobna składnia, a jeden błąd w niej wywraca zapytanie.
    responseMimeType: 'application/json',
    temperature: 0.4,
  };
  if (options.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;

  const response = await send(
    `${modelsUrl(base)}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: headers(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
        contents: [{ parts: contentParts(prompt, image) }],
        generationConfig,
      }),
    },
    {
      provider: 'GEMINI',
      label: `Gemini ${model}${image ? ' z obrazem' : ''}`,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    },
  );

  const body = (await response.json().catch(() => null)) as Reply | null;
  if (!response.ok) {
    logFailure(`Gemini ${model}`, `HTTP ${response.status}: ${body?.error?.message ?? 'bez treści'}`);
    throw refusal(response.status, body?.error, model);
  }

  if (body?.usageMetadata) {
    const usage = body.usageMetadata;
    options.onUsage?.({ inputTokens: usage.promptTokenCount ?? 0, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) });
  }

  const blocked = body?.promptFeedback?.blockReason;
  if (blocked !== undefined) {
    logFailure(`Gemini ${model}`, `odmowa: ${blocked}`);
    throw new AiError(`Gemini odmówił odpowiedzi (${blocked}).`);
  }

  const candidate = body?.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (text.trim() === '') {
    logFailure(`Gemini ${model}`, 'pusta odpowiedź');
    throw new AiError('Gemini zwrócił pustą odpowiedź.', { retryable: true });
  }
  if (candidate?.finishReason === 'MAX_TOKENS') {
    logFailure(`Gemini ${model}`, 'odpowiedź ucięta na limicie długości');
    throw new AiError('Odpowiedź Gemini urwała się na limicie długości. Podnieś maxTokens albo podziel zadanie.');
  }
  return text;
}

type ModelRow = {
  name?: string | null;
  displayName?: string | null;
  supportedGenerationMethods?: string[] | null;
};

export type ModelListReply = { models?: ModelRow[] | null } | null;

/** Lista modeli z odpowiedzi Google, zawężona do tych, które potrafią napisać tekst. */
export function parseModelList(body: ModelListReply): AiModel[] {
  const found = new Map<string, AiModel>();

  for (const row of body?.models ?? []) {
    const id = normalizeModel(row?.name ?? '');
    if (id === '' || !isModelName(id)) continue;

    const methods = row?.supportedGenerationMethods;
    if (Array.isArray(methods) && methods.length > 0) {
      if (!methods.includes('generateContent')) continue;
    } else if (OTHER_WORK.test(id)) {
      // Spis metod bywa pusty — wtedy zostaje nazwa. Lepiej pokazać model za dużo niż pustą listę.
      continue;
    }

    if (!found.has(id)) found.set(id, { id, label: row?.displayName?.trim() || id });
  }

  return sortModels([...found.values()]);
}

export async function geminiModels(key: string, base?: string): Promise<AiModel[]> {
  const response = await send(
    `${modelsUrl(base)}?pageSize=200`,
    { headers: headers(key) },
    { provider: 'GEMINI', label: 'Gemini — lista modeli', timeoutMs: LIST_TIMEOUT_MS },
  );

  const body = (await response.json().catch(() => null)) as (ModelListReply & { error?: ApiError }) | null;

  if (!response.ok) {
    logFailure('Gemini — lista modeli', `HTTP ${response.status}: ${body?.error?.message ?? 'bez treści'}`);
    throw refusal(response.status, body?.error, '');
  }

  const models = parseModelList(body);
  if (models.length === 0) throw new AiError('Google nie zwrócił ani jednego modelu do tekstu.');
  return models;
}
