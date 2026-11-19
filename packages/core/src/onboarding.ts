/**
 * Onboarding (M1): profil z ustawieniami oraz przestrzenie „Osobiste” i „Praca” z Inboxem.
 * Identyfikatory przestrzeni są deterministyczne (UUIDv5 z id użytkownika), więc onboarding
 * przeprowadzony offline na dwóch urządzeniach daje te same wiersze, a nie dwie pary przestrzeni.
 * Wynik to lista operacji dla `mutate` — web i telefon zapisują je tak samo.
 */
import { inboxId, uuidv5 } from './ids.ts';
import { ProfileSettings } from './schemas/model.ts';
import { renumber } from './sort-key.ts';

export type DefaultWorkspace = 'personal' | 'work';

export const DEFAULT_WORKSPACES: readonly { kind: DefaultWorkspace; name: string; color: string; icon: string }[] = [
  { kind: 'personal', name: 'Osobiste', color: '#16A34A', icon: 'home' },
  { kind: 'work', name: 'Praca', color: '#4F46E5', icon: 'briefcase' },
];

export const defaultWorkspaceId = (userId: string, kind: DefaultWorkspace) => uuidv5(`workspace:${kind}:${userId}`);

export interface MutationOp {
  table: 'profiles' | 'workspaces' | 'lists';
  id: string;
  patch: Record<string, unknown>;
}

export interface OnboardingInput {
  displayName?: string | null;
  /** Ustawienia z formularza; brakujące pola dostają wartości domyślne. */
  settings?: Partial<ProfileSettings>;
  /** Które przestrzenie założyć (domyślnie obie). */
  workspaces?: readonly DefaultWorkspace[];
}

/** Operacje onboardingu w kolejności zapisu (przestrzeń przed swoją listą). */
export function onboardingOps(userId: string, input: OnboardingInput = {}): MutationOp[] {
  const settings = ProfileSettings.parse({ ...input.settings, onboarded: true });
  const chosen = DEFAULT_WORKSPACES.filter((w) => (input.workspaces ?? ['personal', 'work']).includes(w.kind));
  const keys = renumber(chosen.length);
  const ops: MutationOp[] = [
    { table: 'profiles', id: userId, patch: { display_name: input.displayName?.trim() || null, settings } },
  ];
  chosen.forEach((w, i) => {
    const id = defaultWorkspaceId(userId, w.kind);
    ops.push({ table: 'workspaces', id, patch: { name: w.name, color: w.color, icon: w.icon, sort_key: keys[i] } });
    ops.push({ table: 'lists', id: inboxId(id), patch: { scope_id: id, kind: 'inbox', name: 'Inbox', sort_key: 'a' } });
  });
  return ops;
}

/** Czy użytkownik przeszedł onboarding (profil z serwera albo zapisany lokalnie). */
export function isOnboarded(settings: unknown): boolean {
  const parsed = ProfileSettings.safeParse(settings ?? {});
  return parsed.success && parsed.data.onboarded;
}
