// Hermes nie ma `crypto.getRandomValues` (UUIDv7 w @taskplanner/core) ani pełnego `URL` (supabase-js).
import 'react-native-url-polyfill/auto';
import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';

type Digest = (algorithm: string | { name: string }, data: BufferSource) => Promise<ArrayBuffer>;
const scope = globalThis as { crypto?: { getRandomValues?: typeof getRandomValues; subtle?: { digest: Digest } } };
scope.crypto ??= {};
scope.crypto.getRandomValues ??= getRandomValues;

// Tylko `crypto.subtle.digest`: bez niego supabase-js robi PKCE z `code_challenge_method = plain`
// (weryfikator jawnie w linku) zamiast S256. Reszty SubtleCrypto (`importKey`, `verify`) nie ma —
// `auth.getClaims()` (lokalna weryfikacja JWT) w aplikacji nie jest używane.
const ALGORITHMS: Record<string, CryptoDigestAlgorithm> = {
  'SHA-1': CryptoDigestAlgorithm.SHA1,
  'SHA-256': CryptoDigestAlgorithm.SHA256,
  'SHA-384': CryptoDigestAlgorithm.SHA384,
  'SHA-512': CryptoDigestAlgorithm.SHA512,
};
scope.crypto.subtle ??= {
  digest: (algorithm, data) => {
    const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
    const native = ALGORITHMS[name];
    return native ? digest(native, data) : Promise.reject(new Error(`crypto.subtle.digest: nieobsługiwany algorytm ${name}`));
  },
};
