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
    const db = drizzle(client);
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}
