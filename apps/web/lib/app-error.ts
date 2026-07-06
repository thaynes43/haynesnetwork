// DESIGN-003 D-13 — clients switch on the stable `appCode` the errorFormatter
// attaches, never on message text. Pure + structurally typed for unit tests.

const APP_CODE_COPY: Record<string, string> = {
  CATALOG_URL_INVALID: "That URL isn't valid — enter something like example.com.",
  REORDER_SET_MISMATCH: 'The catalog changed under you — refresh and reorder again.',
  // ADR-012 — role management codes.
  ROLE_NAME_CONFLICT: 'A role with that name already exists.',
  ROLE_IMMUTABLE: 'That role is a system role and can’t be changed.',
  LAST_ADMIN: 'You can’t remove the last Admin — assign another user to Admin first.',
  CONCURRENT_TRANSITION: 'That user’s role changed under you — refresh and try again.',
  // DESIGN-005 D-17 — media ledger / fix / restore codes.
  FIX_RATE_LIMIT_EXCEEDED: 'Fix limit reached (5 per hour). Try again in a bit.',
  FIX_ALREADY_OPEN: 'A fix is already open for this target — check its status below.',
  FIX_TARGET_REQUIRED: 'Pick the episode or album that needs fixing first.',
  LEDGER_ITEM_TOMBSTONED: 'This item is no longer in the media manager — nothing to fix.',
  ARR_UPSTREAM_UNAVAILABLE:
    'The media manager did not respond. The request was recorded as failed — an admin can see the details.',
  RESTORE_PROFILE_UNMAPPED:
    'A recorded quality profile has no match on the live instance — see the per-item report.',
  // ADR-017 / DESIGN-007 D-05 — Plex library self-service codes.
  LIBRARY_NOT_ALLOWED: 'Your role doesn’t include that library.',
  PLEX_ACCOUNT_UNMATCHED:
    'Your account isn’t a Plex friend of this server yet — ask an admin to add you on Plex first.',
  PLEX_SERVER_UNAVAILABLE: 'Plex didn’t respond. Nothing changed — try again in a bit.',
  // ADR-022 D-02 / DESIGN-009 — the Ledger bulk Add-&-search cap (indexer safety).
  ARR_ADD_SEARCH_CAP_EXCEEDED:
    'Monitor & search is capped at 1000 items per run — narrow the filter set and run in batches.',
};

/** The machine-readable appCode riding on a TRPCClientError, if any. */
export function appCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const appCode = (data as { appCode?: unknown }).appCode;
  return typeof appCode === 'string' ? appCode : undefined;
}

/** Friendly copy for a failed mutation: appCode mapping first, message fallback. */
export function describeMutationError(err: unknown): string {
  const code = appCodeOf(err);
  if (code && APP_CODE_COPY[code]) return APP_CODE_COPY[code];
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Something went wrong. Try again.';
}
