import { openSyncEngine } from '@/lib/sync';

// Wymusza dołączenie silnika synchronizacji do bundla (PoC-1: sprawdzenie Metro + Hermes).
export const syncEntry = openSyncEngine;
