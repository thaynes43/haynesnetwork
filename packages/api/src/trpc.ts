// DESIGN-003 D-01/D-02/D-13 — tRPC context, procedure ladder, and the domain-error
// seam (ADR-004). Donor: todos-for-dues packages/api/src/trpc.ts. No wire transformer
// (D-03): procedures return plain-JSON-safe shapes; timestamps are emitted as ISO-8601
// strings explicitly, never raw Date fields.
import { initTRPC, TRPCError } from '@trpc/server';
import { getServerSession, type SessionUser } from '@hnet/auth';
import { db, ROLES, type Database } from '@hnet/db';
import {
  arrClientBundleFromEnv,
  ArrUpstreamError,
  FixAlreadyOpenError,
  FixRateLimitError,
  FixTargetRequiredError,
  ForbiddenHostError,
  LedgerItemTombstonedError,
  NotFoundError,
  ReorderMismatchError,
  RestoreProfileUnmappedError,
  TagNameConflictError,
  type ArrClientBundle,
} from '@hnet/domain';

export type { SessionUser };

export interface TRPCContext {
  db: Database;
  /** null ⇢ no/invalid session (D-01). */
  user: SessionUser | null;
  /**
   * DESIGN-005 D-17/D-18 — the *arr client bundle the ledger/fix/restore procedures
   * run against. Absent in production contexts (built lazily from env on first use);
   * tests inject fetch-stubbed bundles here (ADR-010 — no live-API tests in CI).
   */
  arr?: ArrClientBundle;
}

let envArrBundle: ArrClientBundle | undefined;

/** The bundle for this request: injected (tests) or the env-built singleton (D-18). */
export function resolveArrBundle(ctx: TRPCContext): ArrClientBundle {
  if (ctx.arr) return ctx.arr;
  envArrBundle ??= arrClientBundleFromEnv();
  return envArrBundle;
}

function hasKnownRole(user: SessionUser): boolean {
  return (ROLES as readonly string[]).includes(user.role);
}

/**
 * D-01 — per-request context: getServerSession reads the Better Auth session from the
 * request headers and hydrates { role, displayName, effective isFamily } (DESIGN-002
 * D-06); isFamily is the EFFECTIVE flag so the UI never re-derives it. Unknown/missing
 * role coerces to a null user — fail closed, same as the donor's isRole() guard.
 */
export const createTRPCContext = async ({
  headers,
}: {
  headers: Headers;
}): Promise<TRPCContext> => {
  const session = await getServerSession(headers);
  const user = session && hasKnownRole(session.user) ? session.user : null;
  return { db, user };
};

/**
 * D-13 — the domain-error classes whose `code` field becomes the wire `appCode`
 * (DESIGN-003 table + the DESIGN-005 D-17 additions). ONLY the errorFormatter below
 * iterates this list; mapDomainErrors is a hand-written instanceof chain (and also
 * handles NotFoundError, which carries no appCode). The two are INDEPENDENT and CAN
 * drift — adding a coded domain error is a two-place edit here (this list AND the
 * mapDomainErrors chain), plus the DESIGN-003 D-13 and DESIGN-005 D-17 tables. See
 * packages/api/README.md.
 */
const APP_CODED_ERRORS = [
  ForbiddenHostError,
  TagNameConflictError,
  ReorderMismatchError,
  FixRateLimitError,
  FixAlreadyOpenError,
  FixTargetRequiredError,
  LedgerItemTombstonedError,
  ArrUpstreamError,
  RestoreProfileUnmappedError,
] as const;

const t = initTRPC.context<TRPCContext>().create({
  // D-13 — attach the stable appCode so clients switch on a machine-readable string,
  // never on the message (donor errorFormatter pattern).
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    for (const ErrorClass of APP_CODED_ERRORS) {
      if (cause instanceof ErrorClass) {
        return { ...shape, data: { ...shape.data, appCode: cause.code } };
      }
    }
    return shape;
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

// D-02 — exactly three rungs in Phase 1 (adminProcedure lives in middleware/role.ts).
export const publicProcedure = t.procedure;

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, user: ctx.user } }); // narrowed non-null
});

/**
 * D-13 — maps typed @hnet/domain errors to the right TRPCError code (donor pattern);
 * procedures wrap their domain calls in `mapDomainErrors(async () => { ... })`. The
 * original error rides along as `cause`, where the errorFormatter finds it to attach
 * the wire appCode.
 *
 * | Domain error                | appCode                     | TRPC code             |
 * |-----------------------------|-----------------------------|-----------------------|
 * | ForbiddenHostError          | CATALOG_URL_FORBIDDEN_HOST  | UNPROCESSABLE_CONTENT |
 * | TagNameConflictError        | TAG_NAME_CONFLICT           | CONFLICT              |
 * | ReorderMismatchError        | REORDER_SET_MISMATCH        | CONFLICT              |
 * | FixRateLimitError           | FIX_RATE_LIMIT_EXCEEDED     | TOO_MANY_REQUESTS     |
 * | FixAlreadyOpenError         | FIX_ALREADY_OPEN            | CONFLICT              |
 * | FixTargetRequiredError      | FIX_TARGET_REQUIRED         | UNPROCESSABLE_CONTENT |
 * | LedgerItemTombstonedError   | LEDGER_ITEM_TOMBSTONED      | PRECONDITION_FAILED   |
 * | ArrUpstreamError            | ARR_UPSTREAM_UNAVAILABLE    | BAD_GATEWAY           |
 * | RestoreProfileUnmappedError | RESTORE_PROFILE_UNMAPPED    | UNPROCESSABLE_CONTENT |
 * | NotFoundError               | —                           | NOT_FOUND             |
 */
export async function mapDomainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForbiddenHostError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof TagNameConflictError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof ReorderMismatchError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof FixRateLimitError) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
    }
    if (err instanceof FixAlreadyOpenError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof FixTargetRequiredError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof LedgerItemTombstonedError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    }
    if (err instanceof ArrUpstreamError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof RestoreProfileUnmappedError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof NotFoundError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
    throw err;
  }
}
