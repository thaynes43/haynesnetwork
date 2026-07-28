import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEFAULT_MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsFolder?: string;
}

/**
 * A fixed, app-scoped key for the session-level advisory lock that serializes the migrator
 * (see runMigrations). Its value is the ASCII bytes of "hnet" (0x686e6574 = 1751213940);
 * any constant works since this is the app's own database — it only needs to be STABLE so
 * every migrator process contends on the same lock.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 0x686e6574; // "hnet"

/**
 * Apply the SQL migrations in packages/db/migrations via the drizzle node-postgres
 * migrator. Idempotent: already-applied migrations (tracked in
 * drizzle.__drizzle_migrations) are skipped. In-cluster this runs from a migrator init
 * container (ADR-003); locally/tests via `pnpm --filter @hnet/db migrate` or
 * @hnet/test-utils' withMigratedDb.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    // Serialize concurrent migrators (saga haynesnetwork-ha plan 01 — hardening, no ADR).
    // At replicas > 1, a cold multi-pod start or a simultaneous reschedule after node loss
    // can run two `migrate` init containers at once. The migrations are non-idempotent (bare
    // CREATE TABLE), so racing migrators would make the loser hit `relation already exists`
    // and crashloop into eventual success (hash-guarded, no corruption) — a self-healing race
    // we should not ship as a design. A session-level pg_advisory_lock on a fixed key makes
    // losers BLOCK until the winner commits, then no-op against the satisfied migrations hash
    // table. The lock is taken on the SAME client/session that runs the migrator and freed in
    // finally; if the process dies mid-migrate, the session ends and Postgres releases it.
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
