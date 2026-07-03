// DESIGN-003 D-13 — clients switch on the stable `appCode` the errorFormatter
// attaches, never on message text. Pure + structurally typed for unit tests.

const APP_CODE_COPY: Record<string, string> = {
  CATALOG_URL_FORBIDDEN_HOST:
    'The server rejected that URL — catalog links must be https://<sub>.haynesnetwork.com.',
  TAG_NAME_CONFLICT: 'A tag with that name already exists.',
  REORDER_SET_MISMATCH: 'The catalog changed under you — refresh and reorder again.',
  // DESIGN-005 D-17 — media ledger / fix / restore codes.
  FIX_RATE_LIMIT_EXCEEDED: 'Fix limit reached (5 per hour). Try again in a bit.',
  FIX_ALREADY_OPEN: 'A fix is already open for this target — check its status below.',
  FIX_TARGET_REQUIRED: 'Pick the episode or album that needs fixing first.',
  LEDGER_ITEM_TOMBSTONED: 'This item is no longer in the media manager — nothing to fix.',
  ARR_UPSTREAM_UNAVAILABLE:
    'The media manager did not respond. The request was recorded as failed — an admin can see the details.',
  RESTORE_PROFILE_UNMAPPED:
    'A recorded quality profile has no match on the live instance — see the per-item report.',
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
