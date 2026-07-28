import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { startPostgres } from '@hnet/test-utils';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';

/**
 * Saga haynesnetwork-ha plan 05 — shared rate-limit storage (DESIGN-002 D-14 amend):
 * https://github.com/thaynes43/haynes-ops/blob/main/.agents/sagas/haynesnetwork-ha/backlog/05-shared-rate-limit-storage.md
 *
 * Acceptance: "Two app processes sharing one DB enforce ONE combined limit."
 *
 * Two Better Auth instances (authA, authB) — each with its own pg Pool + drizzle client,
 * standing in for two replicas — point `rateLimit.storage: 'database'` at the SAME embedded
 * Postgres 16. What makes this a faithful cross-replica proof (not an in-process accident):
 * with `storage: 'database'` the limiter keeps ZERO per-instance state — every consume
 * reads and writes the shared `rate_limit` row, so two instances in one process behave
 * exactly like two pods sharing one DB. (Contrast the default `storage: 'memory'`, whose
 * bucket Map is created per PROCESS — each real pod would keep its own, so the effective
 * limit would multiply by the replica count. That per-process isolation is the bug this plan
 * fixes.) The tests below prove (1) the budget is COMBINED across instances, (2) the count
 * actually LIVES in Postgres, and (3) both instances derive their decision from that one
 * shared row — resetting it in the DB frees both at once.
 */

let started: Awaited<ReturnType<typeof startPostgres>>;
const pools: Pool[] = [];

// Global budget: 4 requests / 60s per (ip, path). Small so the combined limit is easy to hit.
const MAX = 4;
const CLIENT_IP = '203.0.113.7'; // single-value x-forwarded-for → resolves to one shared key
const BUCKET_KEY = `${CLIENT_IP}|/ok`; // createRateLimitKey(ip, path); path is basePath-relative

/** Build a standalone Better Auth instance over its own pool against the shared DB (a "replica"). */
function makeReplica(connectionString: string) {
  const pool = new Pool({ connectionString });
  pool.on('error', () => {}); // swallow late teardown FATALs on the throwaway pool (helpers.ts note)
  pools.push(pool);
  const db = drizzle(pool, { schema });
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'test-secret-test-secret-test-secret',
    advanced: {
      // Match production: uuid ids for every Better Auth table, including rate_limit.
      database: { generateId: 'uuid' },
      // Single-value x-forwarded-for resolves to a real IP (no trustedProxies needed).
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    rateLimit: {
      // Force-enabled here (config.ts gates on NODE_ENV=production; tests run under 'test').
      enabled: true,
      storage: 'database',
      window: 60,
      max: MAX,
    },
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        users: schema.users,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    user: { modelName: 'users', fields: { name: 'displayName' } },
  });
}

/** Hit better-auth's built-in GET /ok (a non-special path → global window/max) as CLIENT_IP. */
async function hit(auth: ReturnType<typeof makeReplica>): Promise<number> {
  const res = await auth.handler(
    new Request('http://localhost:3000/api/auth/ok', {
      headers: { 'x-forwarded-for': CLIENT_IP },
    }),
  );
  return res.status;
}

async function bucketCount(): Promise<number | null> {
  const rows = await pools[0]!.query<{ count: number }>(
    'SELECT count FROM rate_limit WHERE key = $1',
    [BUCKET_KEY],
  );
  return rows.rows[0]?.count ?? null;
}

let authA: ReturnType<typeof makeReplica>;
let authB: ReturnType<typeof makeReplica>;

beforeAll(async () => {
  started = await startPostgres();
  await runMigrations({ databaseUrl: started.connectionString });
  authA = makeReplica(started.connectionString);
  authB = makeReplica(started.connectionString);
}, 180_000);

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await started.stop();
});

describe('DB-backed rate limiting is shared across replicas (saga haynesnetwork-ha plan 05)', () => {
  it('two instances over one DB enforce ONE combined limit', async () => {
    // Spend the budget of 4 SPLIT across the two replicas: 2 through A, 2 through B. A per-pod
    // memory limiter would have each instance at 2 of 4 and let the 5th through on both.
    expect(await hit(authA)).toBe(200);
    expect(await hit(authA)).toBe(200);
    expect(await hit(authB)).toBe(200);
    expect(await hit(authB)).toBe(200);

    // The budget is spent: the 5th combined request is throttled on EITHER instance, because
    // both count against the same shared bucket.
    expect(await hit(authA)).toBe(429);
    expect(await hit(authB)).toBe(429);
  });

  it('keeps the count in Postgres, not per-instance memory', async () => {
    // Exactly one shared bucket row exists, keyed `<ip>|/ok`, and it holds the combined count.
    // The window never elapsed within the test and throttled attempts do not increment past the
    // cap (incrementOne is gated on count < max), so the count settled at exactly MAX.
    const rows = await pools[0]!.query<{ key: string; count: number }>(
      "SELECT key, count FROM rate_limit WHERE key LIKE '%|/ok'",
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.key).toBe(BUCKET_KEY);
    expect(rows.rows[0]!.count).toBe(MAX);
  });

  it('both instances derive their decision from the one shared row (reset frees both)', async () => {
    // Precondition: the shared bucket is exhausted from the first test, so both replicas reject.
    expect(await bucketCount()).toBe(MAX);
    expect(await hit(authA)).toBe(429);
    expect(await hit(authB)).toBe(429);

    // Evict the bucket directly in the shared DB (simulates the window elapsing / a fresh pod
    // with no local state). rate_limit is library-managed operational state, not a domain
    // single-writer table, so this direct write is legitimate (and outside the guard's list).
    await pools[0]!.query('DELETE FROM rate_limit WHERE key = $1', [BUCKET_KEY]);

    // With the sole source of truth cleared, BOTH instances are allowed again — neither carried
    // any per-instance memory of the exhausted state; each read "denied" from that one DB row.
    expect(await hit(authA)).toBe(200); // re-creates the shared bucket (count → 1)
    expect(await hit(authB)).toBe(200); // sees the same row (count → 2)
    expect(await bucketCount()).toBe(2);
  });
});
