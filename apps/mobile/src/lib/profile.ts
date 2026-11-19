/**
 * Profil zalogowanego użytkownika (M1) z lokalnej bazy i onboarding: operacje z
 * `onboardingOps` (core) zapisane po kolei przez `engine.mutate` — offline też działa.
 */
import { isOnboarded, onboardingOps, ProfileSettings, type OnboardingInput } from '@taskplanner/core';
import { decodeRow, type SyncEngine } from '@taskplanner/sync';

import { sessionUser } from './config';
import { localEngine } from './sync';

export interface Profile {
  id: string;
  display_name: string | null;
  settings: ProfileSettings;
  onboarded: boolean;
}

/** `null`, gdy profilu jeszcze nie ma lokalnie (powstaje na serwerze z kontem, przychodzi z synchronizacją). */
export async function loadProfile(engine: SyncEngine, userId = engine.userId): Promise<Profile | null> {
  const row = await engine.get('profiles', userId);
  if (!row) return null;
  const decoded = decodeRow<{ id: string; display_name: string | null; settings: unknown }>('profiles', row);
  const parsed = ProfileSettings.safeParse(decoded.settings ?? {});
  return {
    id: decoded.id,
    display_name: decoded.display_name,
    settings: parsed.success ? parsed.data : ProfileSettings.parse({}),
    onboarded: isOnboarded(decoded.settings),
  };
}

// ── Wstrzymanie bramki onboardingu ─────────────────────────────────────────────────────────
// Ekran powrotu z logowania (`auth-callback`) wstrzymuje bramkę, póki jest zamontowany: kreator
// nie może przykryć komunikatu o błędzie ani przejścia po udanym logowaniu. Flaga w module,
// a nie segment trasy z `useSegments`, bo bramka decyduje asynchronicznie (po odczycie profilu),
// a segment w efekcie bywa jeszcze stary, gdy deep link właśnie otwiera ekran.

let gateHolds = 0;
const gateListeners = new Set<() => void>();

/** Wstrzymuje bramkę; zwrócona funkcja zwalnia (raz) i, gdy nic jej już nie trzyma, budzi bramkę. */
export function holdOnboardingGate(): () => void {
  gateHolds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gateHolds--;
    if (!gateHolds) gateListeners.forEach((l) => l());
  };
}

export const onboardingGateHeld = () => gateHolds > 0;

export function onOnboardingGateRelease(listener: () => void): () => void {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
}

/** Strefa urządzenia (Hermes ma `Intl`); bez niej ustawienie zostaje puste = strefa urządzenia. */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Zapis onboardingu: profil, przestrzenie z Inboxem; wysyłka po ostatniej operacji. */
export async function completeOnboarding(input: OnboardingInput): Promise<void> {
  const user = sessionUser();
  const engine = await localEngine();
  for (const op of onboardingOps(user.id, input)) await engine.mutate(op.table, op.id, op.patch);
  if (user.online) engine.requestSync(0);
}
