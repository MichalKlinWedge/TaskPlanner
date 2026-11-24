/** „Nie dziś” przy porze przeglądu: data odłożenia per rodzaj (tylko ten telefon) — pasek w „Dziś” i powiadomienie. */
import type { LocalDate, ReviewKind } from '@taskplanner/core';

import { readJson, writeJson } from './config';

type Dismissed = Partial<Record<ReviewKind, LocalDate>>;

const KEY = 'review.dismissed';
let cached: Dismissed | null = null;
const listeners = new Set<() => void>();

export const dismissedReviews = (): Dismissed => (cached ??= readJson<Dismissed>(KEY, {}));

export function dismissReview(kind: ReviewKind, date: LocalDate) {
  cached = { ...dismissedReviews(), [kind]: date };
  writeJson(KEY, cached);
  listeners.forEach((l) => l());
}

export function onDismissedReviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
