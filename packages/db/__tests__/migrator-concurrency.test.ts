import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { startPostgres } from '@hnet/test-utils';
import { runMigrations } from '../src/migrate';

// saga haynesnetwork-ha plan 01 — the migrator advisory lock. Two migrators against ONE
// fresh database is exactly the scenario a cold multi-replica start (or a simultaneous
// reschedule after node loss) produces once the app runs > 1 replica. Without the
// session-level pg_advisory_lock in runMigrations, the loser races into a bare
// `CREATE TABLE` that already exists (SQLSTATE 42P07) and crashloops; with it, the loser
// blocks until the winner commits, then no-ops against the satisfied migrations ledger.

describe('migrator advisory lock — concurrent runs (saga haynesnetwork-ha plan 01)', () => {
  it('serializes two racing migrators on a fresh DB: both exit 0, schema applied exactly once', async () => {
    const pg = await startPostgres();
    try {
      const results = await Promise.allSettled([
        runMigrations({ databaseUrl: pg.connectionString }),
        runMigrations({ databaseUrl: pg.connectionString }),
      ]);

      // Acceptance: both concurrent runs succeed — no `relation already exists`, no crash.
      const failed = results.filter((r) => r.status === 'rejected');
      expect(
        failed,
        failed.map((r) => String((r as PromiseRejectedResult).reason)).join('\n'),
      ).toHaveLength(0);

      const client = new Client({ connectionString: pg.connectionString });
      await client.connect();
      try {
        // The migrations ledger recorded every migration exactly once (no duplicate
        // application by the loser).
        const ledger = await client.query(
          'SELECT count(*)::int AS n, count(DISTINCT hash)::int AS distinct_n FROM drizzle.__drizzle_migrations',
        );
        expect(ledger.rows[0].n).toBeGreaterThan(0);
        expect(ledger.rows[0].n).toBe(ledger.rows[0].distinct_n);

        // The schema applied exactly once: a core table exists a single time...
        const users = await client.query(
          `SELECT count(*)::int AS n FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'users'`,
        );
        expect(users.rows[0].n).toBe(1);

        // ...and the idempotent 0002 catalog seed did not double-apply under the race.
        const seeded = await client.query('SELECT count(*)::int AS n FROM app_catalog');
        expect(seeded.rows[0].n).toBe(7);
      } finally {
        await client.end();
      }
    } finally {
      await pg.stop();
    }
  });
});
