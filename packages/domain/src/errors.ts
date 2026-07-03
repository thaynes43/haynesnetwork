// DESIGN-003 D-13 — typed domain errors. packages/api maps these to TRPCError codes via
// mapDomainErrors; the `code` field is the stable appCode clients switch on.

/** R-14: catalog URL failed the *.haynesnetwork.com host assert (url-assert.ts). */
export class ForbiddenHostError extends Error {
  readonly code = 'CATALOG_URL_FORBIDDEN_HOST' as const;
}

/** tags.create / tags.update hit an existing tag name. */
export class TagNameConflictError extends Error {
  readonly code = 'TAG_NAME_CONFLICT' as const;
}

/** catalog.reorder received a stale or partial id set. */
export class ReorderMismatchError extends Error {
  readonly code = 'REORDER_SET_MISMATCH' as const;
}

/** Optimistic-concurrency guard tripped in transitionRole (donor pattern). */
export class ConcurrentTransitionError extends Error {
  readonly code = 'CONCURRENT_TRANSITION' as const;
}

/** The target row (user/app/tag) does not exist. */
export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
}

// ---------------------------------------------------------------------------
// DESIGN-005 Phase 2 — media ledger / fix / sync errors (D-09, D-14, D-17).
// ---------------------------------------------------------------------------

/** R-47: requester hit FIX_RATE_LIMIT_PER_HOUR (admins bypass). */
export class FixRateLimitError extends Error {
  readonly code = 'FIX_RATE_LIMIT_EXCEEDED' as const;
}

/** D-09: an open fix (pending/actioned/search_triggered) already targets this item+child. */
export class FixAlreadyOpenError extends Error {
  readonly code = 'FIX_ALREADY_OPEN' as const;
}

/** D-15: sonarr fixes need an episode target, lidarr an album target, radarr none. */
export class FixTargetRequiredError extends Error {
  readonly code = 'FIX_TARGET_REQUIRED' as const;
}

/** D-17: fix.create on a tombstoned item — nothing to fix in the *arr. */
export class LedgerItemTombstonedError extends Error {
  readonly code = 'LEDGER_ITEM_TOMBSTONED' as const;
}

/** D-09 lifecycle (DDD-001 T-43): the requested status transition is not legal. */
export class InvalidFixTransitionError extends Error {
  readonly code = 'FIX_INVALID_TRANSITION' as const;
}

/**
 * D-14 mass-tombstone guard: the tombstone pass would exceed
 * SYNC_TOMBSTONE_GUARD_PCT of the instance's live rows (and the 10-row minimum) —
 * a wiped/fresh *arr looks exactly like a mass deletion, and blindly tombstoning
 * would corrupt the very ledger Restore needs (R-50). No tombstones are written;
 * the caller records the sync run as 'aborted' and an admin re-runs with force
 * (--force-tombstones) after confirming reality (Q-03).
 */
export class MassTombstoneAbortedError extends Error {
  readonly code = 'SYNC_MASS_TOMBSTONE_ABORTED' as const;
  constructor(
    message: string,
    readonly detail: { wouldTombstone: number; liveCount: number },
  ) {
    super(message);
  }
}

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  // Some wrappers (and future drizzle versions) surface the pg error as `cause`.
  const cause = (err as { cause?: unknown }).cause;
  return cause === undefined ? undefined : pgErrorCode(cause);
}

/** SQLSTATE 23514 — CHECK constraint violation. */
export function isPostgresCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23514';
}

/** SQLSTATE 23505 — UNIQUE constraint violation. */
export function isPostgresUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

/** SQLSTATE 23503 — FOREIGN KEY constraint violation. */
export function isPostgresForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23503';
}
