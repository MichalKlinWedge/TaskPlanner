import { describe, expect, it, vi } from 'vitest';

import { forward, type EmailMessage } from './index.ts';

const RAW = 'From: Ja <ja@example.com>\r\nTo: zadania+abc@example.com\r\nSubject: Test\r\n\r\nTreść\r\n';

function message(): EmailMessage & { rejected: string | null } {
  const m = {
    from: 'ja@example.com',
    to: 'zadania+0123456789abcdef@example.com',
    raw: new Response(RAW).body!,
    rawSize: RAW.length,
    rejected: null as string | null,
    setReject(reason: string) {
      m.rejected = reason;
    },
  };
  return m;
}

const env = { INBOUND_URL: 'https://fn.example/inbound-email', INBOUND_SECRET: 's3cret' };

describe('Email Worker', () => {
  it('przekazuje surową wiadomość z kopertą i sekretem', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ status: 'created' }));
    const m = message();
    const r = await forward(m, env, fetchImpl as typeof fetch);
    expect(r.status).toBe(200);
    expect(m.rejected).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(env.INBOUND_URL);
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-inbound-secret']).toBe('s3cret');
    expect(headers['x-envelope-to']).toBe(m.to);
    expect(headers['x-envelope-from']).toBe(m.from);
    expect(new TextDecoder().decode(init!.body as ArrayBuffer)).toBe(RAW);
  });

  it('odrzucenie przez funkcję (200 rejected) nie odbija maila', async () => {
    const m = message();
    await forward(m, env, (async () => Response.json({ status: 'rejected', reason: 'sender_not_allowed' })) as typeof fetch);
    expect(m.rejected).toBeNull();
  });

  it('błąd funkcji albo sieci → setReject', async () => {
    const m1 = message();
    await forward(m1, env, (async () => new Response('x', { status: 500 })) as typeof fetch);
    expect(m1.rejected).toMatch(/Tymczasowy/);
    const m2 = message();
    await forward(m2, env, (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch);
    expect(m2.rejected).toMatch(/Tymczasowy/);
  });
});
