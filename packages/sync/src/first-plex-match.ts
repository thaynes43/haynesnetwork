// ADR-081 C-04 — the BOOT-TRIGGERED first plex-match sync. On app start, if `media_plex_matches` is EMPTY
// (the cold-start window before the first sync ever populates), the app triggers ONE plex-match sync itself
// so non-admins are not left staring at an empty Library until the recurring CronJob fires. It is:
//   • asynchronous (the caller fires it without awaiting — it never blocks serving or /api/health),
//   • replica-safe (the app runs 3 replicas — a session-level Postgres ADVISORY LOCK, the PLAN-062 migrator
//     precedent, means at most ONE replica runs it; the others try the lock, miss, and skip — no blocking),
//   • skipped entirely when any match row exists (steady-state boots do NOTHING — one cheap pre-check),
//   • non-throwing (a Plex/DB failure is caught and returned, never propagated into the boot path).
// The recurring CronJob remains the steady-state owner of match freshness; this only closes the FIRST window.
import { mediaPlexMatches, type DbClient } from '@hnet/db';
import type { Pool } from 'pg';
import { noopLogger, type SyncLogger } from './logger';

/**
 * A fixed, app-scoped key for the session-level advisory lock that serializes the boot-triggered first
 * plex-match across replicas (the migrator-lock precedent, packages/db/migrate.ts — a DIFFERENT key so the
 * two never contend). Its value is the ASCII bytes of "plxm" (0x706c786d); any stable constant works.
 */
export const FIRST_PLEX_MATCH_ADVISORY_LOCK_KEY = 0x706c786d; // "plxm"

export interface MaybeRunFirstPlexMatchInput {
  /** The pg Pool the advisory lock is taken on (a dedicated connection, released in finally). */
  pool: Pool;
  /** The DB client the emptiness check runs against (the same pool's Drizzle client in production). */
  db: DbClient;
  /** The actual plex-match sync to run when the table is empty and this replica won the lock. */
  run: () => Promise<void>;
  logger?: SyncLogger;
}

export interface MaybeRunFirstPlexMatchResult {
  /** true iff this call ran the sync. */
  ran: boolean;
  /** Why it was skipped: 'has-matches' (steady state) | 'locked' (another replica is running it). */
  skipped?: 'has-matches' | 'locked';
  /** A caught error (the run threw, or a DB/lock hiccup) — surfaced, never propagated. */
  error?: string;
}

/** Does any media_plex_matches row exist? The cold-start signal (cheap EXISTS — stops at the first row). */
async function hasAnyMatch(db: DbClient): Promise<boolean> {
  const rows = await db.select({ one: mediaPlexMatches.id }).from(mediaPlexMatches).limit(1);
  return rows.length > 0;
}

/**
 * ADR-081 C-04 — run the first plex-match sync IFF `media_plex_matches` is empty, exactly once across
 * replicas, without ever throwing. Fast path: a cheap emptiness pre-check short-circuits every steady-state
 * boot before any lock is taken. Cold path: `pg_try_advisory_lock` (NON-blocking — losers skip, they never
 * queue), a re-check inside the lock (TOCTOU: another replica may have just populated it), then `run()`, with
 * the lock released and the connection returned in `finally`.
 */
export async function maybeRunFirstPlexMatch(
  input: MaybeRunFirstPlexMatchInput,
): Promise<MaybeRunFirstPlexMatchResult> {
  const logger = input.logger ?? noopLogger;
  try {
    // Steady-state fast path: any match row ⇒ do nothing, never contend on the lock.
    if (await hasAnyMatch(input.db)) return { ran: false, skipped: 'has-matches' };

    const client = await input.pool.connect();
    try {
      const res = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [FIRST_PLEX_MATCH_ADVISORY_LOCK_KEY],
      );
      if (res.rows[0]?.locked !== true) {
        // Another replica holds the lock (is running, or just ran) — skip without blocking.
        return { ran: false, skipped: 'locked' };
      }
      try {
        // Re-check inside the lock: the winner of a cold multi-replica start may have populated it already.
        if (await hasAnyMatch(input.db)) return { ran: false, skipped: 'has-matches' };
        logger.info('boot: cold-start plex-match — match table empty, running first sync (ADR-081 C-04)');
        await input.run();
        return { ran: true };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [
          FIRST_PLEX_MATCH_ADVISORY_LOCK_KEY,
        ]);
      }
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('boot: cold-start plex-match failed (isolated — boot continues)', { error: message });
    return { ran: false, error: message };
  }
}
