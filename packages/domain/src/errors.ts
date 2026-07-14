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

/**
 * ADR-024 (live-validated 2026-07-06): a per-library add/remove was attempted while the user's
 * account is currently in the plex.tv all-libraries state (`allLibraries="1"` — share-everything
 * incl. future libraries). Applying an explicit single-library change would silently + permanently
 * demote the superset grant (new libraries would stop auto-appearing). No silent demotion ever:
 * `applyShare` throws this BEFORE any Plex write and the message directs the user to LEAVE All
 * first (`plex.setServerAll { on:false }` seeds the explicit list with their current full set — no
 * access loss), then manage individual libraries. Surfaced as UNPROCESSABLE_CONTENT.
 */
export class PlexAllStateError extends Error {
  readonly code = 'PLEX_ALL_STATE' as const;
}

// ---------------------------------------------------------------------------
// ADR-023 / DESIGN-010 — Trash section (Maintainerr) errors.
// ---------------------------------------------------------------------------

/**
 * ADR-023 D-04: a DESTRUCTIVE Trash path (expedite) re-ran the preflight `auditMaintainerr` and
 * the install did NOT look safe — a required integration is down, or the service is unreachable.
 * The orchestrator refuses BEFORE any Maintainerr write (fail closed). Surfaced as
 * PRECONDITION_FAILED with the failing checks named (never a raw error).
 */
export class MaintainerrUnsafeError extends Error {
  readonly code = 'MAINTAINERR_UNSAFE' as const;
  constructor(
    message: string,
    readonly detail?: { integrations?: Record<string, boolean>; reachable?: boolean },
  ) {
    super(message);
  }
}

/**
 * ADR-023 D-04: a Maintainerr read/write failed upstream (unreachable, non-2xx, schema drift) —
 * surfaced to the client as BAD_GATEWAY, exactly like ArrUpstreamError. The original ArrError
 * (the shared @hnet/arr HTTP taxonomy) rides along as `cause`. Fail closed.
 */
export class MaintainerrUpstreamError extends Error {
  readonly code = 'MAINTAINERR_UNAVAILABLE' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * ADR-023 / R-87: a Trash action reached a music (Lidarr) target. Music is NEVER deletable via
 * Trash — Maintainerr has no Lidarr integration and the estate keeps music undeletable. Rejected
 * at the orchestrator (defence in depth beneath the UI, which hides the shield for Lidarr items).
 */
export class TrashMusicUnsupportedError extends Error {
  readonly code = 'TRASH_MUSIC_UNSUPPORTED' as const;
}

// ---------------------------------------------------------------------------
// ADR-025 / DESIGN-011 — Trash curation pipeline (batch state machine) errors.
// ---------------------------------------------------------------------------

/**
 * ADR-025 C-01: a batch transition or precondition was illegal — green-light on a batch not in
 * `admin_review`, cancel on an already-terminal batch, expire on a batch that is not
 * `leaving_soon`/not-yet-expired, or a save flip whose phase does not match the batch state. The
 * state machine refuses (fail closed) BEFORE any external write. Surfaced as CONFLICT.
 */
export class TrashBatchStateError extends Error {
  readonly code = 'TRASH_BATCH_STATE' as const;
}

/**
 * ADR-025 C-01 (Q-01): a batch could not be created because an OPEN (draft/admin_review/
 * leaving_soon) batch already exists for that media kind — one live batch per kind. Also raised
 * when the DB partial-unique index trips a race. Surfaced as CONFLICT.
 */
export class TrashBatchOpenError extends Error {
  readonly code = 'TRASH_BATCH_ALREADY_OPEN' as const;
}

/**
 * ADR-025: create-batch found no actionable pending items to snapshot (nothing for that kind, or
 * every candidate lacks a Maintainerr id). No empty batch is created. Surfaced as
 * UNPROCESSABLE_CONTENT.
 */
export class TrashBatchEmptyError extends Error {
  readonly code = 'TRASH_BATCH_EMPTY' as const;
}

/**
 * ADR-025 / DESIGN-011 D-05: an un-save was attempted during the OPEN `leaving_soon` window against
 * a save that is NOT the caller's own, by a caller who does not hold `manage_batches`/admin. During
 * the family save window a `save_leaving_soon` holder may release ONLY their own rescue; releasing
 * another family member's rescue needs a batch manager. Enforced server-side in the
 * `setBatchItemSaved` writer BEFORE any external Maintainerr write (the poster wall scopes this
 * client-side, but the domain is authoritative — AC-13). Surfaced as FORBIDDEN.
 */
export class TrashSaveNotOwnedError extends Error {
  readonly code = 'TRASH_SAVE_NOT_OWNED' as const;
}

// ---------------------------------------------------------------------------
// ADR-050 / DESIGN-012 D-10 (PLAN-034) — Bulletin Helpdesk ticket errors. (The ADR-026 Messages
// board errors — MESSAGE_NOT_OWNED / MESSAGE_MODERATED — retired with the board itself.)
// ---------------------------------------------------------------------------

/**
 * ADR-050: the requested ticket state transition is not a legal edge of TICKET_TRANSITIONS
 * (self-transition, anything out of the terminal `complete`, or `rejected` to anywhere but
 * `open`). Thrown by `transitionTicket` under the row lock BEFORE any write. Surfaced as CONFLICT
 * (the ticket's current state precludes the move — mirrors FIX_INVALID_TRANSITION).
 */
export class InvalidTicketTransitionError extends Error {
  readonly code = 'TICKET_INVALID_TRANSITION' as const;
}

// ---------------------------------------------------------------------------
// ADR-045 / DESIGN-023 (PLAN-026) — Authentik role-portal errors.
// ---------------------------------------------------------------------------

/**
 * THE GUARDRAIL (ADR-045 C-02): a membership write was attempted against a group NOT in the owned-groups
 * allowlist. The domain orchestrator throws this BEFORE any external Authentik call, so the app can never
 * touch an authentik-admin-managed group (authentik Admins, mfa-exempt, …). Surfaced as FORBIDDEN. This
 * is the negative-path invariant proven by unit test AND live spot-check.
 */
export class AuthentikGroupNotOwnedError extends Error {
  readonly code = 'AUTHENTIK_GROUP_NOT_OWNED' as const;
  constructor(readonly groupName: string) {
    super(
      `refusing to write membership for '${groupName}': not in the owned-groups allowlist ` +
        `(the app manages only the groups it owns; edit the allowlist to opt a group in)`,
    );
  }
}

/** The Authentik API was unreachable/failed during a portal read or write (wraps the typed cause). */
export class AuthentikUnavailableError extends Error {
  readonly code = 'AUTHENTIK_UNAVAILABLE' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The Open WebUI group API was unreachable/failed during a synced-tier provision (wraps the cause). */
export class OwuiUnavailableError extends Error {
  readonly code = 'OWUI_UNAVAILABLE' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A synced-tier operation was requested for a role that is not (or can't be) a synced tier. */
export class SyncedTierInvalidError extends Error {
  readonly code = 'SYNCED_TIER_INVALID' as const;
}

// ---------------------------------------------------------------------------
// ADR-055 / DESIGN-028 (PLAN-044) — Integration (Goodreads requests MVP) errors.
// ---------------------------------------------------------------------------

/**
 * linkIntegration could not extract a Goodreads user id from the profile reference the user entered.
 * A Goodreads profile URL looks like `https://www.goodreads.com/user/show/12345-name` (or a bare numeric
 * id); anything else is refused BEFORE any row is written. Surfaced as UNPROCESSABLE_CONTENT with an
 * actionable message (never the raw input echoed unbounded).
 */
export class InvalidGoodreadsProfileError extends Error {
  readonly code = 'GOODREADS_PROFILE_INVALID' as const;
}

/**
 * A LazyLibrarian read/write failed upstream while serving a request (a manual "Search again" push) —
 * surfaced to the client as BAD_GATEWAY, exactly like ArrUpstreamError. The original LazyLibrarianError
 * rides along as `cause`; the API key is never echoed (the taxonomy keeps it query-only + redacted).
 */
export class LazyLibrarianUpstreamError extends Error {
  readonly code = 'LAZYLIBRARIAN_UNAVAILABLE' as const;
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
