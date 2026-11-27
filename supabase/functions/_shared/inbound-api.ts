/**
 * Wspólne dla Edge Function `inbound-api` (przychodzące API, v1.x): odczyt treści z limitem rozmiaru i mapowanie
 * błędów bazy na statusy HTTP. Bez Deno — testy w Node (`tools/edge-tests/src/inbound-api.test.ts`).
 */

/** Błąd z odpowiedzią HTTP (jak `HttpError` w `runtime.ts`, ale bez zależności od Deno). */
export class InboundError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** `details` w treści błędu (np. ścieżki pól z walidacji). */
  readonly details: unknown[] | undefined;
  constructor(status: number, message: string, headers: Record<string, string> = {}, details?: unknown[]) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.details = details;
  }
}

/**
 * Treść zapytania jako tekst, najwyżej `max` bajtów: większy `Content-Length` albo strumień = 413 bez czytania
 * reszty (klient może kłamać w nagłówku, więc liczymy też bajty strumienia).
 */
export async function readLimitedText(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) throw new InboundError(413, `Treść za duża — najwyżej ${Math.floor(max / 1024)} KB.`);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new InboundError(413, `Treść za duża — najwyżej ${Math.floor(max / 1024)} KB.`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Treść JSON (obiekt) z limitem rozmiaru; inny typ treści albo nieczytelny JSON = 400 / 415. */
export async function readJsonObject(req: Request, max: number): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type') ?? '';
  if (type && !/^application\/json\b/i.test(type)) throw new InboundError(415, 'Oczekiwano Content-Type: application/json.');
  const text = await readLimitedText(req, max);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InboundError(400, 'Nieczytelny JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InboundError(400, 'Oczekiwano obiektu JSON.');
  return value as Record<string, unknown>;
}

/** Błąd RPC (`{code, message}` z PostgREST) → błąd HTTP z komunikatem z bazy; nieznany kod = `null` (500). */
export function dbError(error: { code?: string; message?: string } | null | undefined): InboundError | null {
  if (!error) return null;
  const message = error.message || 'Błąd bazy';
  switch (error.code) {
    case 'TP003':
      return new InboundError(403, message);
    case 'P0002':
      return new InboundError(404, message);
    case '22023':
      return new InboundError(400, message);
    default:
      return null;
  }
}
