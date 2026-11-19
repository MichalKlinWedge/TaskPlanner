/**
 * `link-preview` — tytuł, opis, obraz i ikona strony dla linku w zadaniu (M5, M19).
 *
 * `POST …/link-preview` `{ url }` z JWT użytkownika → `{ ok, preview }`. Strona niedostępna albo adres
 * niedozwolony (SSRF, `_shared/link-preview.ts`) → `ok: false` i pusty podgląd (klient zapisuje go
 * i nie ponawia); błąd 401 / 5xx — klient ponowi później.
 */
import { fetchPreview, PreviewError } from '../_shared/link-preview.ts';
import { HttpError, json, requireUser, serve } from '../_shared/runtime.ts';

async function resolve(host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([Deno.resolveDns(host, 'A').catch(() => []), Deno.resolveDns(host, 'AAAA').catch(() => [])]);
  return [...a, ...aaaa];
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Tylko POST');
  await requireUser(req);
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  if (typeof body?.url !== 'string' || body.url.length > 2000) throw new HttpError(400, 'Brak adresu');
  try {
    return json({ ok: true, preview: await fetchPreview(body.url, { fetch, resolve }) });
  } catch (error) {
    if (error instanceof PreviewError || (error as Error).name === 'TimeoutError' || error instanceof TypeError) {
      return json({ ok: false, preview: {}, error: (error as Error).message });
    }
    throw error;
  }
});
