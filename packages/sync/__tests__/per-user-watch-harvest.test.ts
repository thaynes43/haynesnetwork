// ADR-053 / DESIGN-026 D-07 (PLAN-029 R7) — the metadata harvest's PER-USER watch attribution, end to
// end through the orchestrator. The metadata-refresh pre-step reconciles the Plex Account Map from the
// id_tokens Better Auth stored at each user's last sign-in; the Tautulli harvest then re-keys every play
// by its plex.tv user id into user_media_watch for the MAPPED users only. ADDITIVE (ADR-053 C-03): the
// household aggregate on media_metadata is identical with or without the mapping. Until 2026-09-23 the
// map had no writer wired, so production held 0 rows here. Embedded PG16 + a fetch-stubbed Tautulli.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { account, mediaItems, mediaMetadata, userMediaWatch } from '@hnet/db/schema';
import { TautulliClient } from '@hnet/arr/read';
import { getUserAccountMap, getUserMediaWatch } from '@hnet/domain';
import { runSync } from '../src/index';
import { bootMigratedDb, createUser, fixtureArrClients, stubFetch, type TestDb } from './helpers';

const OWNER_PLEX_ID = 12874060; // Tautulli returns history user_id as a NUMBER
const GUEST_PLEX_ID = 999; // a household Plex account with no app user behind it

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// One Tautulli instance, two titles from the radarr fixture: rating_key 101 = ¡Three Amigos! (tmdb 8388),
// 202 = '71 (tmdb 252178). The third fixture movie (Winner Takes the Cake) has no plays.
const HISTORY = [
  {
    rating_key: 101,
    media_type: 'movie',
    date: unix('2026-09-01T20:00:00Z'),
    stopped: unix('2026-09-01T21:40:00Z'),
    watched_status: 1,
    user_id: OWNER_PLEX_ID,
    user: 'owner',
  },
  {
    rating_key: 101,
    media_type: 'movie',
    date: unix('2026-09-10T20:00:00Z'),
    stopped: unix('2026-09-10T21:40:00Z'),
    watched_status: 1,
    user_id: OWNER_PLEX_ID,
    user: 'owner',
  },
  {
    rating_key: 101,
    media_type: 'movie',
    date: unix('2026-09-15T20:00:00Z'),
    stopped: unix('2026-09-15T21:40:00Z'),
    watched_status: 1,
    user_id: GUEST_PLEX_ID,
    user: 'guest',
  },
  {
    rating_key: 202,
    media_type: 'movie',
    date: unix('2026-09-05T20:00:00Z'),
    stopped: unix('2026-09-05T20:30:00Z'),
    watched_status: 0.5,
    user_id: String(OWNER_PLEX_ID), // the string form is tolerated too
    user: 'owner',
  },
];

const METADATA: Record<string, unknown> = {
  '101': { guids: ['imdb://tt0092086', 'tmdb://8388'], media_type: 'movie' },
  '202': { guids: ['imdb://tt2614684', 'tmdb://252178'], media_type: 'movie' },
};

function tautulliStub(): TautulliClient {
  const { fetchImpl } = stubFetch([
    {
      path: '/api/v2',
      body: (url: URL) => {
        const cmd = url.searchParams.get('cmd');
        if (cmd === 'get_history') {
          const rows = Number(url.searchParams.get('start') ?? 0) === 0 ? HISTORY : [];
          return {
            response: {
              result: 'success',
              message: null,
              data: { data: rows, recordsFiltered: HISTORY.length, recordsTotal: HISTORY.length },
            },
          };
        }
        if (cmd === 'get_metadata') {
          const key = url.searchParams.get('rating_key') ?? '';
          return { response: { result: 'success', message: null, data: METADATA[key] ?? {} } };
        }
        return { response: { result: 'error', message: `unstubbed cmd ${cmd}`, data: {} } };
      },
    },
  ]);
  return new TautulliClient({
    baseUrl: 'http://tautulli.test:8181',
    apiKey: 'test-key',
    retryDelayMs: 0,
    fetchImpl,
  });
}

/** A JWT-shaped id_token whose payload carries `claims` (decode-only — the app never re-verifies it). */
function idTokenWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

describe('metadata-refresh per-user watch attribution (ADR-053 / DESIGN-026 D-07)', () => {
  let t: TestDb;
  let amigos: string;
  let seventyOne: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    const full = await runSync({
      mode: 'full',
      sources: ['radarr'],
      db: t.db,
      clients: fixtureArrClients(),
    });
    expect(full.totalFailure).toBe(false);
    const rows = await t.db
      .select({ id: mediaItems.id, tmdbId: mediaItems.tmdbId })
      .from(mediaItems);
    amigos = rows.find((r) => r.tmdbId === 8388)!.id;
    seventyOne = rows.find((r) => r.tmdbId === 252178)!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  /** One metadata-refresh run over radarr; threshold 0 ⇒ every row is stale, so every run re-harvests. */
  const harvest = () =>
    runSync({
      mode: 'metadata-refresh',
      sources: ['radarr'],
      db: t.db,
      clients: fixtureArrClients(),
      metadataSources: { tautulli: [{ slug: 'haynesops', client: tautulliStub() }] },
      metadataStaleThresholdMs: 0,
    });

  /** The household watch signal the Trash walls + item detail read (must never change with R7). */
  const household = () =>
    t.db
      .select({
        mediaItemId: mediaMetadata.mediaItemId,
        playCount: mediaMetadata.playCount,
        lastViewedAt: mediaMetadata.lastViewedAt,
        lastWatchedAt: mediaMetadata.lastWatchedAt,
        lastWatchedServer: mediaMetadata.lastWatchedServer,
      })
      .from(mediaMetadata)
      .orderBy(mediaMetadata.mediaItemId);

  it('maps the signed-in users, attributes their plays, and leaves the household aggregate unchanged', async () => {
    const owner = await createUser(t.db, { email: 'owner@haynesnetwork.com' });
    const claimless = await createUser(t.db, { email: 'old-token@example.com' });

    // 1) Baseline: no stored tokens yet (the production shape before the fix: an empty map).
    const baseline = await harvest();
    expect(baseline.totalFailure).toBe(false);
    expect(baseline.plexAccountMap).toMatchObject({ candidates: 0, mapped: 0 });
    expect(baseline.sources[0]!.stats).toMatchObject({
      tierTautulli: 2,
      userWatchMappedUsers: 0,
      userWatchWritten: 0,
    });
    expect(await t.db.select().from(userMediaWatch)).toEqual([]);
    const householdBefore = await household();
    // The household aggregate counts EVERY play, attributed or not (owner ×2 + guest on Amigos).
    expect(householdBefore.find((r) => r.mediaItemId === amigos)).toMatchObject({
      playCount: 3,
      lastViewedAt: new Date('2026-09-15T21:40:00Z'),
      lastWatchedServer: 'haynesops',
    });

    // 2) The id_tokens Better Auth stored at each user's last sign-in: only the owner's carries the
    //    Authentik plex_user_id claim (the other predates the scope mapping).
    await t.db.insert(account).values([
      {
        userId: owner.id,
        providerId: 'authentik',
        accountId: 'sub-owner',
        idToken: idTokenWith({ sub: 'sub-owner', plex_user_id: String(OWNER_PLEX_ID) }),
      },
      {
        userId: claimless.id,
        providerId: 'authentik',
        accountId: 'sub-claimless',
        idToken: idTokenWith({ sub: 'sub-claimless', email: 'old-token@example.com' }),
      },
    ]);

    const run = await harvest();
    expect(run.totalFailure).toBe(false);
    // The pre-step backfilled the map from the stored token…
    expect(run.plexAccountMap).toMatchObject({
      candidates: 2,
      mapped: 1,
      noClaim: 1,
      conflicts: 0,
      failed: 0,
    });
    expect((await getUserAccountMap(t.db, owner.id))?.plexUserId).toBe(String(OWNER_PLEX_ID));
    // …so this SAME run attributed the owner's plays.
    expect(run.sources[0]!.stats).toMatchObject({ userWatchMappedUsers: 1, userWatchWritten: 2 });

    expect(await getUserMediaWatch(t.db, amigos, owner.id)).toEqual({
      playCount: 2,
      lastViewedAt: new Date('2026-09-10T21:40:00Z'),
      watched: true,
      inProgress: false,
    });
    expect(await getUserMediaWatch(t.db, seventyOne, owner.id)).toEqual({
      playCount: 1,
      lastViewedAt: new Date('2026-09-05T20:30:00Z'),
      watched: false,
      inProgress: true,
    });
    // The guest's play attributes to nobody; the claim-less user gets nothing.
    const perUser = await t.db.select().from(userMediaWatch);
    expect(perUser).toHaveLength(2);
    expect(perUser.every((r) => r.appUserId === owner.id)).toBe(true);
    expect(await getUserMediaWatch(t.db, amigos, claimless.id)).toBeNull();

    // ADDITIVE (ADR-053 C-03): the household signal is exactly what it was with an empty map.
    expect(await household()).toEqual(householdBefore);

    // 3) Idempotent: a later run re-writes the same per-user rows and maps nobody new.
    const again = await harvest();
    expect(again.plexAccountMap).toMatchObject({ candidates: 1, mapped: 0, noClaim: 1 });
    expect(again.sources[0]!.stats).toMatchObject({ userWatchMappedUsers: 1, userWatchWritten: 2 });
    expect(await t.db.select().from(userMediaWatch)).toHaveLength(2);
    expect(await household()).toEqual(householdBefore);
  });

  // DESIGN-008 D-03 amendment (2026-09-23): the CronJob fires every 6h and the threshold was exactly
  // 6h, so the rows a tick wrote (stamped moments AFTER it started) were a few seconds too fresh at
  // the next tick. Live runs alternated 18,460 rows and about 30, so everything refreshed every 12h.
  it('the next 6-hourly tick re-harvests every row the previous tick wrote (default threshold)', async () => {
    const t0 = Date.now();
    const tick1 = await harvest(); // stamps every radarr row's fetched_at (DB now()) just after t0
    expect(tick1.sources[0]!.stats).toMatchObject({ targets: 3 });

    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0 + 6 * 60 * 60 * 1000);
    try {
      const tick2 = await runSync({
        mode: 'metadata-refresh',
        sources: ['radarr'],
        db: t.db,
        clients: fixtureArrClients(),
        metadataSources: { tautulli: [{ slug: 'haynesops', client: tautulliStub() }] },
        // no metadataStaleThresholdMs → the production default
      });
      expect(tick2.sources[0]!.stats).toMatchObject({
        targets: 3,
        written: 3,
        userWatchWritten: 2,
      });
    } finally {
      clock.mockRestore();
    }
  });
});
