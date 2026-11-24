import { askGemini, geminiModels } from './gemini.ts';
import { type AiModel, fallbackModels, isModelName, normalizeModel } from './models.ts';
import { type AskOptions, DEFAULT_MODELS, PROVIDER_LABELS, type Provider } from './providers.ts';
import { memoryRejectedStore, type RejectedStore, withoutRejected } from './rejected.ts';
import { AiError, logFailure } from './transport.ts';

/**
 * Jedno wejście do dostawców.
 *
 * Reszta systemu nie wie, który model odpowiada — pyta o tekst i dostaje tekst. Klucz i nazwa
 * modelu przychodzą z konta użytkownika (`ai_accounts` + Vault), czytanego w Edge Function `ai`.
 */

export class NoApiKeyError extends AiError {
  constructor(provider: Provider) {
    super(`Brak klucza do ${PROVIDER_LABELS[provider]} — podepnij go w Ustawieniach → „Asystent AI”.`);
    this.name = 'NoApiKeyError';
  }
}

export class NoModelError extends AiError {
  constructor(provider: Provider) {
    super(`Nie wiadomo, którego modelu ${PROVIDER_LABELS[provider]} użyć. Kliknij „Sprawdź” i wybierz model z listy.`);
    this.name = 'NoModelError';
  }
}

export type AiClientConfig = {
  keys: Partial<Record<Provider, string | undefined>>;
  models?: Partial<Record<Provider, string | undefined>>;
  defaultProvider?: Provider;
  rejected?: RejectedStore;
  /**
   * Adres API dostawcy zamiast prawdziwego — tylko testy (fałszywy dostawca w `tools/edge-tests`).
   * Gemini: odpowiednik `https://generativelanguage.googleapis.com/v1beta`.
   */
  endpoints?: Partial<Record<Provider, string | undefined>>;
  /**
   * Przeciążony model: jedna ponowna próba po chwili, potem tanie modele zastępcze z listy dostawcy
   * (`fallbackModels`). Model, który odpowiedział, zostaje do końca życia klienta, żeby kolejne
   * zapytania nie czekały na ponowne przeciążenie.
   */
  failover?: { retryDelayMs?: number };
};

export type AiRequest = AskOptions & { provider?: Provider };

export type AiAnswer = { text: string; provider: Provider; model: string };

export type AiClient = {
  readonly defaultProvider: Provider;
  ask(prompt: string, request?: AiRequest): Promise<AiAnswer>;
  listModels(provider: Provider): Promise<AiModel[]>;
};

/** Przeciążenie mija zwykle po chwili, a Edge Function ma własny limit czasu. */
const RETRY_DELAY_MS = 2_000;

export function createAiClient(config: AiClientConfig): AiClient {
  const rejected = config.rejected ?? memoryRejectedStore();
  const defaultProvider = config.defaultProvider ?? 'GEMINI';
  const standIn = new Map<Provider, string>();

  const keyFor = (provider: Provider): string => {
    const key = config.keys[provider]?.trim() ?? '';
    if (key === '') throw new NoApiKeyError(provider);
    return key;
  };

  // Nazwę sprawdzamy u siebie: inaczej odpowiedzią na nazwę ze strony dostawcy jest komunikat API
  // o formacie, z którego nie wynika, co poprawić.
  const modelFor = (provider: Provider): string => {
    const raw = config.models?.[provider] ?? DEFAULT_MODELS[provider];
    const model = normalizeModel(raw);
    if (model === '') throw new NoModelError(provider);
    if (!isModelName(model)) {
      throw new AiError(`„${raw}” to nie jest nazwa modelu, tylko jej opis. Wskaż identyfikator z listy modeli.`);
    }
    return model;
  };

  const endpoint = (provider: Provider) => config.endpoints?.[provider] || undefined;

  const listModels = async (provider: Provider) => {
    const all = await geminiModels(keyFor(provider), endpoint(provider));
    return withoutRejected(rejected, provider, all);
  };

  return {
    defaultProvider,

    async ask(prompt, request = {}) {
      const { provider = defaultProvider, ...options } = request;
      const key = keyFor(provider);

      const once = async (model: string): Promise<AiAnswer> => {
        try {
          const text = await askGemini(key, model, prompt, options, endpoint(provider));
          return { text, provider, model };
        } catch (error) {
          // Odmowa z samego modelu nie minie: ten klucz tego wariantu nie dostanie.
          if (error instanceof AiError && error.modelGone) rejected.add(provider, model);
          throw error;
        }
      };

      const model = standIn.get(provider) ?? modelFor(provider);
      const failover = config.failover;
      if (failover === undefined) return once(model);

      const busy = (error: unknown) => error instanceof AiError && error.busy;
      let refusal: unknown;
      try {
        return await once(model);
      } catch (error) {
        if (!busy(error)) throw error;
        refusal = error;
      }
      await new Promise((resolve) => setTimeout(resolve, failover.retryDelayMs ?? RETRY_DELAY_MS));
      try {
        return await once(model);
      } catch (error) {
        if (!busy(error)) throw error;
      }
      // Bez listy zastępców zostaje odmowa, która to wszystko zaczęła: ona mówi, co się stało.
      const names = await listModels(provider).then((models) => fallbackModels(models, model), () => [] as string[]);
      for (const name of names) {
        try {
          const answer = await once(name);
          standIn.set(provider, name);
          logFailure(`model ${model}`, `przeciążony, odpowiedział ${name}`);
          return answer;
        } catch (error) {
          if (!busy(error) && !(error instanceof AiError && error.modelGone)) throw error;
        }
      }
      throw refusal;
    },

    listModels,
  };
}
