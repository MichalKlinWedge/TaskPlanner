/**
 * `account-delete` — usunięcie własnego konta ze wszystkimi danymi na serwerze (v1.x, RODO).
 *
 * `POST …/account-delete` `{ email }` z JWT użytkownika; `email` musi być adresem konta
 * (potwierdzenie wpisane ręcznie). Kolejno:
 *   1. kalendarze — przez `calendar-sync/accounts/delete` z tym samym JWT (Google: zatrzymanie
 *      kanałów `watch` i odwołanie tokenu, sekret z Vault znika triggerem);
 *   2. pliki w Storage `attachments/{user_id}/…` (Storage nie kasuje ich kaskadą);
 *   3. `auth.admin.deleteUser` — kaskadą zakresy (`sync_scopes.owner_id`), wszystkie wiersze
 *      synchronizowane, urządzenia, subskrypcje push, dziennik błędów.
 * Przerwane w połowie można powtórzyć (każdy krok jest idempotentny). Kopie zapasowe
 * (`db-backup.yml`) zawierają dane do końca ich retencji.
 */
import { admin, env, HttpError, json, requireUser, serve } from '../_shared/runtime.ts';

const BUCKET = 'attachments';

/** Wszystkie pliki pod `{prefix}/` (Storage listuje jeden poziom; foldery mają `id = null`). */
async function listFiles(prefix: string): Promise<string[]> {
  const files: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin().storage.from(BUCKET).list(prefix, { limit: 1000, offset });
    if (error) throw error;
    for (const item of data ?? []) {
      const path = `${prefix}/${item.name}`;
      if (item.id) files.push(path);
      else files.push(...(await listFiles(path)));
    }
    if (!data || data.length < 1000) return files;
  }
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Tylko POST');
  const user = await requireUser(req);
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const typed = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!user.email || typed !== user.email.toLowerCase()) throw new HttpError(400, 'Wpisz adres e-mail konta, żeby potwierdzić usunięcie.');
  const db = admin();

  const { data: accounts, error: accountsError } = await db.from('calendar_accounts').select('id').eq('user_id', user.id);
  if (accountsError) throw accountsError;
  for (const { id } of accounts ?? []) {
    const res = await fetch(`${env('SUPABASE_URL')}/functions/v1/calendar-sync/accounts/delete`, {
      method: 'POST',
      headers: { authorization: req.headers.get('authorization')!, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: id }),
    });
    if (!res.ok) throw new Error(`Odłączanie kalendarza: ${res.status} ${await res.text()}`);
  }

  const files = await listFiles(user.id);
  for (let i = 0; i < files.length; i += 100) {
    const { error } = await db.storage.from(BUCKET).remove(files.slice(i, i + 100));
    if (error) throw error;
  }

  const { error } = await db.auth.admin.deleteUser(user.id);
  if (error) throw error;
  return json({ deleted: user.id, calendars: accounts?.length ?? 0, files: files.length });
});
