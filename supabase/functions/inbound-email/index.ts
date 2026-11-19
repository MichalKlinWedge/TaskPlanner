/**
 * `inbound-email` — mail → zadanie w Inbox (SPECYFIKACJA M19, PoC-6).
 *
 * Wywołuje go tylko Cloudflare Email Worker (`tools/email-worker`): POST z surową wiadomością RFC 822
 * w treści i nagłówkami `x-inbound-secret` (sekret współdzielony), `x-envelope-from`, `x-envelope-to`,
 * `x-received-at`. Przyjmuje tylko adres z poprawnym tokenem i nadawcę z listy użytkownika; każda decyzja
 * trafia do dziennika `inbound_messages` (bez treści). Odpowiedź zawsze 200 z wynikiem — odrzucenia nie
 * wracają do nadawcy (bez rozsyłania odbić do podszytych adresów); 5xx = błąd po naszej stronie (Worker odrzuca).
 */
import PostalMime from 'postal-mime';

import { authenticationFailure, buildInboundTask, recipientToken, senderAllowed, type InboundContext } from '../_shared/email.ts';
import { admin, env, HttpError, json, safeEqual, serve } from '../_shared/runtime.ts';

const MAX_BYTES = 25 * 1024 * 1024;

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Tylko POST');
  if (!safeEqual(req.headers.get('x-inbound-secret'), env('INBOUND_SECRET'))) throw new HttpError(401, 'Zły sekret');
  const started = Date.now();
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BYTES) throw new HttpError(413, 'Wiadomość za duża');

  const db = admin();
  const envelopeTo = req.headers.get('x-envelope-to') ?? '';
  const receivedAt = req.headers.get('x-received-at') ?? new Date().toISOString();
  const mail = await PostalMime.parse(raw);
  const from = (mail.from?.address ?? req.headers.get('x-envelope-from') ?? '').toLowerCase();
  const subject = mail.subject ?? null;
  const messageId = mail.messageId ?? null;

  const log = async (row: { user_id: string; status: 'rejected'; reason: string }) => {
    const { error } = await db.from('inbound_messages').insert({
      ...row,
      received_at: receivedAt,
      from_addr: from || null,
      to_addr: envelopeTo || null,
      subject: subject?.slice(0, 500) ?? null,
      message_id: messageId,
    });
    return error;
  };
  const reject = async (user: string | null, reason: string) => {
    // Bez użytkownika (zły token) dziennik nie ma właściciela — tylko log funkcji.
    if (user) await log({ user_id: user, status: 'rejected', reason });
    else console.warn(`odrzucony (${reason}): do ${envelopeTo}`);
    return json({ status: 'rejected', reason });
  };

  const token = recipientToken(envelopeTo);
  if (!token) return reject(null, 'no_token');
  const { data: address } = await db.from('inbound_addresses').select('*').eq('token', token).maybeSingle();
  if (!address) return reject(null, 'unknown_token');
  const user = address.user_id as string;

  const auth = authenticationFailure(mail.headers.filter((h) => /authentication-results$/i.test(h.key)).map((h) => h.value));
  if (auth) return reject(user, auth);
  if (!senderAllowed(from, address.senders)) return reject(user, address.senders.length ? 'sender_not_allowed' : 'no_senders');

  const { data: ctx, error: ctxError } = await db.rpc('inbound_context', { p_user: user });
  if (ctxError) throw ctxError;
  const built = buildInboundTask(
    { subject, text: mail.text ?? null, html: mail.html ?? null, from, messageId, receivedAt },
    ctx as InboundContext,
    { zone: address.time_zone, nowMs: Date.now(), defaultListId: address.list_id },
  );
  if (!built) return reject(user, 'no_inbox');

  // Najpierw wpis w dzienniku (unikalny `message_id`), potem zadanie: dwa równoległe dostarczenia tego
  // samego maila (ponowienie Cloudflare) dają jedno zadanie.
  const { data: entry, error: claimError } = await db.from('inbound_messages').insert({
    user_id: user, status: 'created', received_at: receivedAt, from_addr: from || null, to_addr: envelopeTo || null,
    subject: subject?.slice(0, 500) ?? null, message_id: messageId,
  }).select('id').single();
  if (claimError) {
    if (claimError.code !== '23505') throw claimError;
    const { data: dup } = await db.from('inbound_messages').select('task_id').eq('user_id', user).eq('message_id', messageId).eq('status', 'created').maybeSingle();
    return json({ status: 'duplicate', taskId: dup?.task_id ?? null });
  }
  const { data: taskId, error } = await db.rpc('create_integration_task', { p_user: user, p_task: built.task, p_tags: built.tags });
  if (error) {
    console.error('create_integration_task', error);
    await db.from('inbound_messages').update({ status: 'rejected', reason: `task_error:${error.code ?? ''}` }).eq('id', entry.id);
    return json({ status: 'rejected', reason: 'task_error' });
  }
  await db.from('inbound_messages').update({ task_id: taskId }).eq('id', entry.id);
  return json({ status: 'created', taskId, listId: built.task.list_id, title: built.task.title, ms: Date.now() - started });
});
