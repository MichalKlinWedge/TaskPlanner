/**
 * Identyfikatory z klienta (SPECYFIKACJA §5 „Konwencje”): UUIDv7 dla nowych wierszy (zapis offline,
 * sortowalne po czasie) i UUIDv5 dla wierszy, które dwa urządzenia mogą zapisać „tak samo” —
 * ukończenie wystąpienia, tag zadania, Inbox przestrzeni — wtedy oba dają ten sam id i jeden wiersz.
 * Czysty TS (SHA-1 własne), bez `node:crypto`: działa w przeglądarce, Hermes i Deno.
 */

/** Przestrzeń nazw UUIDv5 aplikacji (stała, nigdy nie zmieniać). */
export const TASKPLANNER_NAMESPACE = '4b6f2a2e-6f0e-4c1e-9b1a-7a5d3c2e9f10';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const format = (bytes: Uint8Array) => {
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const parse = (uuid: string): Uint8Array => {
  const h = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error(`Niepoprawny UUID: „${uuid}”.`);
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
};

type RandomBytes = (length: number) => Uint8Array;

const defaultRandom: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

/** UUIDv7 (RFC 9562): 48 bitów milisekund + losowe bity. */
export function uuidv7(now: number = Date.now(), random: RandomBytes = defaultRandom): string {
  const bytes = random(16);
  let time = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return format(bytes);
}

/** UUIDv5 (RFC 9562): SHA-1 z przestrzeni nazw i nazwy (UTF-8). */
export function uuidv5(name: string, namespace: string = TASKPLANNER_NAMESPACE): string {
  const ns = parse(namespace);
  const text = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + text.length);
  input.set(ns);
  input.set(text, ns.length);
  const bytes = sha1(input).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return format(bytes);
}

/** Ukończenie wystąpienia zadania cyklicznego / nawyku (`task_completions.id`). */
export const completionId = (taskId: string, occurrenceDate: string) => uuidv5(`completion:${taskId}:${occurrenceDate}`);
/** Tag zadania (`task_tags.id`). */
export const taskTagId = (taskId: string, tagId: string) => uuidv5(`task-tag:${taskId}:${tagId}`);
/** Inbox przestrzeni (`lists.id`, `kind = 'inbox'`). */
export const inboxId = (workspaceId: string) => uuidv5(`inbox:${workspaceId}`);
/** Tag o danej nazwie użytkownika: ten sam tag utworzony na dwóch urządzeniach to jeden wiersz. */
export const tagId = (userId: string, name: string) =>
  uuidv5(`tag:${userId}:${name.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').trim().toLowerCase()}`);

function sha1(message: Uint8Array): Uint8Array {
  const length = message.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((value, i) => outView.setUint32(i * 4, value));
  return out;
}
