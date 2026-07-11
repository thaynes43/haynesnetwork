import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { startPostgres } from '@hnet/test-utils';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';
import type { Database } from '@hnet/db';

export interface TestDb {
  db: Database;
  pool: Pool;
  stop: () => Promise<void>;
}

/**
 * Boot an embedded Postgres 16 (ADR-010 — real PG, no Docker), apply the @hnet/db
 * migrations, hand back a typed client. Same shape as @hnet/test-utils withMigratedDb,
 * held open across a test file's beforeAll/afterAll.
 */
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
