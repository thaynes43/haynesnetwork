import { runMigrations } from '@hnet/db/migrate';
import { startPostgres } from './postgres';

/**
 * Boot an embedded Postgres 16, apply all @hnet/db migrations, run `fn` against the
 * migrated database, then tear everything down (also on failure).
 */
export async function withMigratedDb<T>(fn: (connectionString: string) => Promise<T>): Promise<T> {
  const pg = await startPostgres();
  try {
    await runMigrations({ databaseUrl: pg.connectionString });
    return await fn(pg.connectionString);
  } finally {
    await pg.stop();
  }
}
