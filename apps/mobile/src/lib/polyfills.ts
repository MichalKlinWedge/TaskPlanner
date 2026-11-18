// Hermes nie ma `crypto.getRandomValues` (UUIDv7 w @taskplanner/core) ani pełnego `URL` (supabase-js).
import 'react-native-url-polyfill/auto';
import { getRandomValues } from 'expo-crypto';

const scope = globalThis as { crypto?: { getRandomValues?: typeof getRandomValues } };
scope.crypto ??= {};
scope.crypto.getRandomValues ??= getRandomValues;
