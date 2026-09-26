import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { startPostgres } from '@hnet/test-utils';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';
import type { Database } from '@hnet/db';
import {
  EMPTY_WATCHLIST_KEYS,
  createStaticWatchlistSources,
  refreshWatchlistRegistry,
  silentDomainLogger,
  type DeleteWatchlistSnapshot,
  type StaticWatchlistFixture,
  type WatchlistRegistryRefreshReport,
  type WatchlistSnapshot,
} from '../src/index';

export interface TestDb {
  db: Database;
  pool: Pool;
  stop: () => Promise<void>;
}

/** Boot an embedded Postgres 16, apply the @hnet/db migrations, hand back a typed client. */
export async function bootMigratedDb(): Promise<TestDb> {
  const started = await startPostgres();
  await runMigrations({ databaseUrl: started.connectionString });
  const pool = new Pool({ connectionString: started.connectionString });
  // 57P01 teardown-flake hardening (CI protocol note, 2026-07-11): as the embedded PG shuts down it can
  // deliver a late FATAL 57P01 to an idle pool client; pg emits it as an 'error' event, and with no
  // listener vitest flags an UNHANDLED error and fails an otherwise-green run. Swallow ONLY pool-level
  // errors on the throwaway test pool (queries still reject normally).
  pool.on('error', () => {});
  const db = drizzle(pool, { schema }) as Database;
  return {
    db,
    pool,
    stop: async () => {
      await pool.end();
      await started.stop();
    },
  };
}

let emailSeq = 0;

/** Insert a plain user row (user creation is Better Auth's job, not a guarded write). */
export async function createUser(
  db: Database,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): Promise<typeof schema.users.$inferSelect> {
  const [row] = await db
    .insert(schema.users)
    .values({
      email: overrides.email ?? `user-${++emailSeq}@example.com`,
      displayName: overrides.displayName ?? `User ${emailSeq}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('user insert returned no row');
  return row;
}

// ---------------------------------------------------------------------------
// ADR-093 / DESIGN-052 (PLAN-072) — the Watchlist Registry for the Trash tests. Every delete path now takes the
// Registry Gate (D-07), so a test that expedites or sweeps first records a VERIFIED registry run through the real
// single writer, over in-memory sources (no live API, ADR-010). The default fixture is the owner with an empty list:
// nothing is watchlisted and every pool item is evaluable.
// ---------------------------------------------------------------------------

/** A `display` snapshot with nothing listed (walls, shape checks). */
export const TEST_DISPLAY_SNAPSHOT: WatchlistSnapshot = {
  purpose: 'display',
  keys: EMPTY_WATCHLIST_KEYS,
  runId: 'test',
};

/** A verified `delete` snapshot with nothing listed (a direct delete-path helper call). */
export const TEST_DELETE_SNAPSHOT: DeleteWatchlistSnapshot = {
  purpose: 'delete',
  verified: true,
  keys: EMPTY_WATCHLIST_KEYS,
  runId: 'test',
  overlaySince: new Date(0),
};

/** Record a verified registry run now (default: the owner, nothing listed). */
export async function seedVerifiedWatchlistRegistry(
  db: Database,
  fixture: Partial<StaticWatchlistFixture> = {},
): Promise<WatchlistRegistryRefreshReport> {
  const { sources } = createStaticWatchlistSources({ ownerId: '1', ...fixture });
  const report = await refreshWatchlistRegistry({
    db,
    sources,
    trigger: 'manual',
    logger: silentDomainLogger,
    sleep: async () => {},
  });
  if (report.status !== 'ok') throw new Error(`seed registry run failed: ${report.status}`);
  return report;
}
