// ADR-081 C-04 — the boot-triggered first plex-match: it runs the sync ONLY when media_plex_matches is
// empty, exactly once across replicas (a session advisory lock), and never throws into the boot path.
// Proven against an embedded PG16 (no live Plex — the `run` callback is a stub).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mediaItems, mediaPlexMatches, plexLibraries, SEEDED_PLEX_SERVER_IDS } from '@hnet/db';
import type { Database } from '@hnet/db';
import { syncPlexMatches, upsertMediaItemsBatch, upsertPlexLibraries } from '@hnet/domain';
import {
  FIRST_PLEX_MATCH_ADVISORY_LOCK_KEY,
  maybeRunFirstPlexMatch,
} from '../src/first-plex-match';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
let moviesLib: string;

/** Seed one matched item so the reconcile scope + the emptiness flip are realistic. */
async function seedOneMatch(db: Database): Promise<void> {
  await upsertMediaItemsBatch({
    db,
    arrKind: 'radarr',
    items: [
      {
        arrItemId: 7001,
        tmdbId: 7001,
        title: 'Movie A',
        sortTitle: 'movie a',
        year: 2020,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/data/haynestower/Media/Movies',
        onDiskFileCount: 1,
        expectedFileCount: 1,
      },
    ],
  });
  const [mi] = await db.select({ id: mediaItems.id }).from(mediaItems).where(eq(mediaItems.arrItemId, 7001));
  await syncPlexMatches({
    db,
    matches: [{ mediaItemId: mi!.id, plexLibraryId: moviesLib, ratingKey: '9001', matchedVia: 'tmdb' }],
    scopedLibraryIds: [moviesLib],
  });
}

/** Empty the match table through the SINGLE WRITER (reconcile): an empty match set scoped to the library,
 *  stamped in the future, drops every existing row — never a direct guarded delete. */
async function clearMatches(db: Database): Promise<void> {
  await syncPlexMatches({
    db,
    matches: [],
    scopedLibraryIds: [moviesLib],
    now: new Date(Date.now() + 60_000),
  });
}

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [{ sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' }],
  });
  const [row] = await t.db
    .select({ id: plexLibraries.id })
    .from(plexLibraries)
    .where(eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynestower));
  moviesLib = row!.id;
});

afterAll(async () => {
  await t?.stop();
});

describe('maybeRunFirstPlexMatch (ADR-081 C-04)', () => {
  it('runs the sync when the match table is empty', async () => {
    let ran = 0;
    const result = await maybeRunFirstPlexMatch({
      pool: t.pool,
      db: t.db,
      run: async () => {
        ran += 1;
        await seedOneMatch(t.db); // the real sync would populate; the stub does the same effect
      },
    });
    expect(result).toEqual({ ran: true });
    expect(ran).toBe(1);
    expect(await t.db.select().from(mediaPlexMatches)).toHaveLength(1);
  });

  it('skips (never calls run) once any match row exists — the steady-state fast path', async () => {
    let ran = 0;
    const result = await maybeRunFirstPlexMatch({
      pool: t.pool,
      db: t.db,
      run: async () => {
        ran += 1;
      },
    });
    expect(result).toEqual({ ran: false, skipped: 'has-matches' });
    expect(ran).toBe(0);
  });

  it('skips (never blocks) when another session holds the advisory lock, and never throws', async () => {
    // Empty the table so the fast path does not short-circuit — force the lock branch.
    await clearMatches(t.db);

    // Hold the lock on a SEPARATE session (another checked-out client of the same pool), standing in for
    // another replica mid-run; maybeRunFirstPlexMatch's own client is a distinct session, so it contends.
    const client = await t.pool.connect();
    try {
      const locked = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [FIRST_PLEX_MATCH_ADVISORY_LOCK_KEY],
      );
      expect(locked.rows[0]!.locked).toBe(true);

      let ran = 0;
      const result = await maybeRunFirstPlexMatch({
        pool: t.pool,
        db: t.db,
        run: async () => {
          ran += 1;
        },
      });
      expect(result).toEqual({ ran: false, skipped: 'locked' });
      expect(ran).toBe(0);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [FIRST_PLEX_MATCH_ADVISORY_LOCK_KEY]);
      client.release();
    }
  });

  it('returns an error result (never throws) when the sync itself fails', async () => {
    await clearMatches(t.db); // empty ⇒ reach the run() branch
    const result = await maybeRunFirstPlexMatch({
      pool: t.pool,
      db: t.db,
      run: async () => {
        throw new Error('plex unreachable');
      },
    });
    expect(result.ran).toBe(false);
    expect(result.error).toContain('plex unreachable');
  });
});
