// ADR-091 / DESIGN-050 D-10 — a small fixed-window limiter over the shared `rate_limit` table (the Better Auth
// bucket store, saga haynesnetwork-ha plan 05), so the OAuth endpoints' per-IP limits hold ACROSS the three
// replicas. Better Auth's own limiter is internal to its router and only covers /api/auth paths, so it cannot be
// reused for /oauth/*; this is the "small helper" D-10 calls for.
//
// One atomic statement per consume: an INSERT … ON CONFLICT DO UPDATE takes the bucket's row lock, so concurrent
// requests on any replica count exactly once each. Keys are `oauth:<route>|<ip>` — disjoint from Better Auth's
// `<ip>|<path>` keys. For these keys `last_request` holds the window's END (epoch ms), not the last request:
// Better Auth's pruner deletes every row whose `last_request` is older than its longest window (60 s), which
// would silently reset a 1-hour bucket a minute after its last hit; a window end in the future keeps the bucket
// alive until it has expired. No audit row — rate-limit buckets are library-managed operational state.
import { type DbClient } from '@hnet/db';
import { sql } from 'drizzle-orm';
import { resolveDb } from './db-client';

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests counted in the current window, this one included. */
  count: number;
  /** Seconds until the window ends (the `Retry-After` of a refused request); ≥ 1. */
  retryAfterSeconds: number;
}

/**
 * Count one request against `key`'s fixed window of `windowSeconds`, allowing `max` per window. The first request
 * after a window ends opens a new one.
 */
export async function consumeRateLimit(input: {
  db?: DbClient;
  key: string;
  windowSeconds: number;
  max: number;
  now?: Date;
}): Promise<RateLimitDecision> {
  const nowMs = (input.now ?? new Date()).getTime();
  const windowEnd = nowMs + input.windowSeconds * 1000;
  const result = await resolveDb(input.db).execute<{
    count: number;
    window_end: string | number;
  }>(sql`
    INSERT INTO rate_limit (key, count, last_request)
    VALUES (${input.key}, 1, ${windowEnd}::bigint)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limit.last_request <= ${nowMs}::bigint THEN 1 ELSE rate_limit.count + 1 END,
      last_request = CASE WHEN rate_limit.last_request <= ${nowMs}::bigint THEN ${windowEnd}::bigint ELSE rate_limit.last_request END
    RETURNING count, last_request AS window_end`);
  const row = result.rows[0];
  const count = Number(row?.count ?? 1);
  const end = Number(row?.window_end ?? windowEnd);
  return {
    allowed: count <= input.max,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((end - nowMs) / 1000)),
  };
}
