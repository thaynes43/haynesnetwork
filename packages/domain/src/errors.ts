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
