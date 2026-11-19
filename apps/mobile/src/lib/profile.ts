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
