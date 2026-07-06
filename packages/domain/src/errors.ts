// DESIGN-003 D-13 — typed domain errors. packages/api maps these to TRPCError codes via
// mapDomainErrors; the `code` field is the stable appCode clients switch on.

/** ADR-013: catalog URL failed normalize/validate — not a well-formed http(s) URL
 * (url-assert.ts). BRANCH-A: no host rules, so any well-formed link is accepted. */
export class InvalidCatalogUrlError extends Error {
  readonly code = 'CATALOG_URL_INVALID' as const;
}

/** roles.create / roles.update hit an existing role name (ADR-012). */
export class RoleNameConflictError extends Error {
  readonly code = 'ROLE_NAME_CONFLICT' as const;
}

/** ADR-012: attempt to edit/rename/delete a locked system role (Admin fully; Default's
 * name/existence). Admin is a superuser with an implicit all-apps grant. */
export class SystemRoleImmutableError extends Error {
  readonly code = 'ROLE_IMMUTABLE' as const;
}

/** ADR-012: assigning a user off the Admin role when they are the last Admin — refused so
 * the instance can never be locked out of its own admin console. */
export class LastAdminError extends Error {
  readonly code = 'LAST_ADMIN' as const;
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

/**
 * ADR-016 / D-19: a missing_subtitles Fix reached a kind Bazarr cannot cover (lidarr —
 * no music subtitle integration). Defense in depth: the reason is not offered for Music
 * (fixReasonsForKind) and thrown BEFORE any fix_requests row is created (no orphan pending).
 */
export class SubtitleFixUnsupportedError extends Error {
  readonly code = 'SUBTITLE_FIX_UNSUPPORTED' as const;
}

/** D-09 lifecycle (DDD-001 T-43): the requested status transition is not legal. */
export class InvalidFixTransitionError extends Error {
  readonly code = 'FIX_INVALID_TRANSITION' as const;
}

/**
 * D-17: an *arr/Seerr call failed while serving a request (fix orchestration,
 * ledger.children live proxy, restore diff/execute) — surfaced to the client as
 * BAD_GATEWAY. The original ArrError rides along as `cause`.
 */
export class ArrUpstreamError extends Error {
  readonly code = 'ARR_UPSTREAM_UNAVAILABLE' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * D-16/D-17: a ledger profile-name snapshot has no match on the live target *arr —
 * never silently defaulted; per-item failure recorded in restore_runs.results.
 */
export class RestoreProfileUnmappedError extends Error {
  readonly code = 'RESTORE_PROFILE_UNMAPPED' as const;
}

/**
 * ADR-022 D-02: a Ledger bulk Add-&-search (`executeArrAdd`, reason 'ledger_add', searches ON)
 * was asked to act on more than ARR_ADD_SEARCH_CAP items. The *arrs queue search commands
 * internally, but indexers rate-limit, so a single run is capped; the UI guides the user to
 * batch (e.g. by vote tier). Thrown BEFORE any *arr write, so nothing partial happens.
 */
export class SearchCapExceededError extends Error {
  readonly code = 'ARR_ADD_SEARCH_CAP_EXCEEDED' as const;
  constructor(
    message: string,
    readonly detail: { requested: number; cap: number },
  ) {
    super(message);
  }
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

// ---------------------------------------------------------------------------
// ADR-017 / DESIGN-007 Phase 3 — Plex library self-service errors (D-04/D-05).
// ---------------------------------------------------------------------------

/**
 * ADR-017 D-04: a user tried to self-share a library their Role does not grant. The domain
 * re-derives the fresh allowed set INSIDE the share transaction (TOCTOU guard) and throws
 * this BEFORE any Plex write — so a stale/forged client can never widen access.
 */
export class LibraryNotAllowedError extends Error {
  readonly code = 'LIBRARY_NOT_ALLOWED' as const;
}

/**
 * ADR-017 D-01: the app user's OIDC email has no matching Plex friend on the target server's
 * account, so there is no Plex account id to share to. NOT an invite flow (out of scope,
 * Q-06) — the user must already be a Plex friend of the server owner. Surfaced as
 * UNPROCESSABLE_CONTENT with an actionable message.
 */
export class PlexAccountUnmatchedError extends Error {
  readonly code = 'PLEX_ACCOUNT_UNMATCHED' as const;
}

/**
 * ADR-017 D-04/D-05: a Plex read/write (registry refresh, friend lookup, share apply) failed
 * upstream — surfaced to the client as BAD_GATEWAY. The original PlexError rides as `cause`.
 * The token is never echoed (the PlexError taxonomy keeps it header-only).
 */
export class PlexServerUnavailableError extends Error {
  readonly code = 'PLEX_SERVER_UNAVAILABLE' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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
