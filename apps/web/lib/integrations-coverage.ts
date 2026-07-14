// ADR-055 / DESIGN-028 (PLAN-044) — pure presentation helper for the Integrations coverage card.
// Fix 3b (v0.49.0 live acceptance): a just-linked integration that has never synced must NOT render a
// "0% / 0 of 0 books" badge — that reads as "we have nothing" when the truth is "the first sync hasn't
// run yet". The first sync fires in the background on link, so the card shows a PENDING state until
// last_synced_at is stamped, then swaps to the real coverage. The swap must not reflow neighbors
// (ADR-015) — the card reserves the same footprint for both states. Unit-tested (no React).

export interface Coverage {
  total: number;
  covered: number;
  pct: number;
}

export type CoverageView =
  | { kind: 'pending' }
  | { kind: 'coverage'; pct: number; covered: number; total: number };

/**
 * Decide what the coverage card renders. A LINKED integration that has never synced
 * (`lastSyncedAt === null`) is "first sync in progress", regardless of the (necessarily empty) coverage
 * numbers — never a 0% dead-end. Once synced, the real coverage shows, including an honest 0% for a
 * genuinely empty want shelf.
 */
export function coverageView(input: {
  lastSyncedAt: string | null;
  coverage: Coverage;
}): CoverageView {
  if (input.lastSyncedAt === null) return { kind: 'pending' };
  return { kind: 'coverage', ...input.coverage };
}

/** True while a linked integration is waiting on its first shelf sync (drives the pending poll + copy). */
export function isFirstSyncPending(linked: boolean, lastSyncedAt: string | null): boolean {
  return linked && lastSyncedAt === null;
}
