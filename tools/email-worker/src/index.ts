/**
 * Cloudflare Email Worker — przekazuje surową wiadomość do Edge Function `inbound-email`
 * (SPECYFIKACJA M19). Bez parsowania MIME: na planie Free Worker ma mało CPU (`docs/USLUGI.md`),
 * więc parsuje dopiero funkcja. Decyzję (token, nadawca) też podejmuje funkcja; Worker odrzuca maila
 * (odbicie do nadawcy) tylko wtedy, gdy funkcja nie przyjęła go z przyczyn technicznych.
 */

/** Minimalny kształt `ForwardableEmailMessage` z runtime Workers (bez pakietu typów). */
export interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface Env {
  INBOUND_URL: string;
  INBOUND_SECRET: string;
}

export async function forward(message: EmailMessage, env: Env, fetchImpl: typeof fetch = fetch): Promise<{ status: number; body: unknown }> {
  // Całość w pamięci (do 25 MiB): strumień bez długości nie każdy serwer przyjmie, a CPU to nie zużywa.
  const raw = await new Response(message.raw).arrayBuffer();
  let res: Response;
  try {
    res = await fetchImpl(env.INBOUND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'message/rfc822',
        'x-inbound-secret': env.INBOUND_SECRET,
        'x-envelope-from': message.from,
        'x-envelope-to': message.to,
        'x-received-at': new Date().toISOString(),
      },
      body: raw,
    });
  } catch (error) {
    message.setReject('Tymczasowy błąd odbiorcy, spróbuj później');
    return { status: 0, body: String(error) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) message.setReject('Tymczasowy błąd odbiorcy, spróbuj później');
  return { status: res.status, body };
}

export default {
  async email(message: EmailMessage, env: Env): Promise<void> {
    const r = await forward(message, env);
    console.log(JSON.stringify({ to: message.to, size: message.rawSize, status: r.status, result: r.body }));
  },
};
