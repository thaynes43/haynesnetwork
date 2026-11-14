// DESIGN-008 D-15 / #855. Synthetic household history, stubs and embedded PostgreSQL 16 only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mediaItems, mediaMetadata, plexLibraries, userMediaWatch, type ArrKind } from '@hnet/db';
import {
  upsertMediaItemsBatch,
  syncPlexMatches,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
  upsertUserAccountHandles,
  upsertUserMediaWatchBatch,
} from '@hnet/domain';
import { TautulliClient } from '@hnet/arr/read';
import { loadPlexRatingGuids, plexRatingGuidKey } from '../src/db-reads';
import {
  buildMetadataContext,
  lookupHouseholdWatch,
  runMetadataRefreshForKind,
} from '../src/metadata-refresh';
import { backfillWatchHistory } from '../src/watch-history-backfill';
import { usableWatchGuids, type WatchTarget } from '../src/watch-identity';
import { noopLogger } from '../src/logger';
import { bootMigratedDb, createUser, fixtureArrClients, stubFetch, type TestDb } from './helpers';

const first = '2024-01-01T00:00:00.000Z';
const second = '2025-02-01T00:00:00.000Z';
function source(rows: object[], metadata: Record<string, object>) {
  const stub = stubFetch([
    {
      path: '/api/v2',
      body: (url: URL) => {
        const key = url.searchParams.get('rating_key') ?? '';
        const start = Number(url.searchParams.get('start') ?? 0);
        const length = Number(url.searchParams.get('length') ?? 500);
        return {
          response: {
            result: 'success',
            data:
              url.searchParams.get('cmd') === 'get_metadata'
                ? (metadata[key] ?? {})
                : { data: rows.slice(start, start + length) },
          },
        };
      },
    },
  ]);
  return {
    calls: stub.calls,
    tautulli: [
      {
        slug: 'haynesops',
        client: new TautulliClient({
          baseUrl: 'http://tautulli.test',
          apiKey: 'synthetic',
          fetchImpl: stub.fetchImpl,
        }),
      },
    ],
  };
}
function history(kind: ArrKind, key: string, when: string) {
  return {
    media_type: kind === 'radarr' ? 'movie' : 'episode',
    rating_key: key,
    grandparent_rating_key: kind === 'sonarr' ? key : null,
    stopped: Date.parse(when) / 1000,
    watched_status: 1,
    user_id: 99,
  };
}

describe('kind-qualified watch join', () => {
  let t: TestDb;
  let sequence = 100;
  let viewer: Awaited<ReturnType<typeof createUser>>;
  const libraries = new Map<string, string>();
  beforeAll(async () => {
    t = await bootMigratedDb();
    viewer = await createUser(t.db);
    await upsertUserAccountHandles({ db: t.db, userId: viewer.id, plexUserId: '99' });
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [
        { sectionKey: '1', name: 'Movies', mediaType: 'movie' },
        { sectionKey: '2', name: 'Shows', mediaType: 'show' },
      ],
    });
    for (const lib of await t.db.select().from(plexLibraries)) libraries.set(lib.mediaType, lib.id);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it.each(['cached', 'get_metadata'])(
    'persists the identity matrix via %s and repairs old aggregates',
    async (route) => {
      const rows: object[] = [];
      const metadata: Record<string, object> = {};
      const expected: {
        id: string;
        target: WatchTarget;
        plays: number | null;
        last: string | null;
      }[] = [];
      const add = async (
        target: WatchTarget,
        plays: number | null,
        when: string | null,
        rawGuids?: string[],
        withMatch = true,
      ) => {
        const n = ++sequence;
        // Distinct synthetic instances let the normal ledger writer retain duplicate/sentinel
        // external ids rather than treating a later fixture as an arr rebuild of the first.
        const fixtureInstance = `${route}-${n}`;
        await upsertMediaItemsBatch({
          db: t.db,
          arrKind: target.arrKind,
          arrInstanceId: fixtureInstance,
          items: [
            {
              arrItemId: n,
              tmdbId: target.tmdbId ?? (target.arrKind === 'radarr' ? 0 : null),
              tvdbId: target.tvdbId ?? (target.arrKind === 'sonarr' ? 0 : null),
              imdbId: target.imdbId,
              title: `Synthetic title ${n}`,
              sortTitle: `synthetic ${n}`,
              monitored: true,
              qualityProfileId: 1,
              qualityProfileName: 'Synthetic',
              rootFolder: '/synthetic',
            },
          ],
        });
        const [item] = await t.db
          .select()
          .from(mediaItems)
          .where(eq(mediaItems.arrInstanceId, fixtureInstance));
        const storedTarget = { ...target, tmdbId: item!.tmdbId, tvdbId: item!.tvdbId };
        expected.push({ id: item!.id, target: storedTarget, plays, last: when });
        await upsertMediaMetadataBatch({
          db: t.db,
          rows: [
            {
              mediaItemId: item!.id,
              playCount: 999,
              lastViewedAt: new Date(second),
              lastWatchedAt: new Date(second),
              lastWatchedServer: 'haynesops',
              imdbRating: 7.5,
              sources: { arr: true, tautulli: true },
              extra: { retained: true, tautulli: {} },
            },
          ],
        });
        if (withMatch)
          await syncPlexMatches({
            db: t.db,
            scopedLibraryIds: [],
            matches: [
              {
                mediaItemId: item!.id,
                plexLibraryId: libraries.get(target.arrKind === 'radarr' ? 'movie' : 'show')!,
                ratingKey: String(n),
                matchedVia: 'tmdb',
              },
            ],
          });
        const ids = usableWatchGuids(storedTarget);
        const guids =
          rawGuids ??
          [
            ids.tmdbId && `tmdb://${ids.tmdbId}`,
            ids.tvdbId && `tvdb://${ids.tvdbId}`,
            ids.imdbId && `imdb://${ids.imdbId}`,
          ].filter((x): x is string => typeof x === 'string');
        metadata[String(n)] = { guids, media_type: target.arrKind === 'radarr' ? 'movie' : 'show' };
        if (plays && when)
          for (let i = 0; i < plays; i++) rows.push(history(target.arrKind, String(n), when));
        return item!.id;
      };
      // Every id namespace is kind qualified. IMDb is one namespace, but a history row still
      // attributes only within its kind; a same-kind duplicate intentionally represents the same work.
      for (const field of ['tmdbId', 'tvdbId', 'imdbId'] as const) {
        const shared = field === 'imdbId' ? 'tt700003' : field === 'tmdbId' ? 700001 : 700002;
        await add({ arrKind: 'radarr', [field]: shared }, 1, first);
        await add({ arrKind: 'sonarr', [field]: shared }, 2, second);
      }
      // Same-kind duplicate IMDb: no extra history row, but the same work receives its one play.
      const duplicateId = await add({ arrKind: 'radarr', imdbId: 'tt700003' }, 0, null);
      Object.assign(
        expected.find((r) => r.id === duplicateId)!,
        { plays: 1, last: first },
      );

      for (const field of ['tmdbId', 'tvdbId', 'imdbId'] as const) {
        for (const invalid of ['zero', 'empty', 'missing', 'whitespace']) {
          const kind = field === 'tmdbId' ? 'sonarr' : 'radarr';
          const alternate = field === 'tmdbId' ? 'tvdbId' : 'tmdbId';
          for (const [plays, when] of [
            [1, first],
            [2, second],
          ] as const) {
            const value =
              invalid === 'zero'
                ? field === 'imdbId'
                  ? '0'
                  : 0
                : invalid === 'missing'
                  ? null
                  : field === 'imdbId'
                    ? invalid === 'empty'
                      ? ''
                      : ' '
                    : null;
            const unique = 800000 + sequence;
            const target = { arrKind: kind, [field]: value, [alternate]: unique } as WatchTarget;
            const badGuid =
              invalid === 'missing'
                ? []
                : [
                    `${field === 'imdbId' ? 'imdb' : field === 'tvdbId' ? 'tvdb' : 'tmdb'}://${invalid === 'zero' ? '0' : invalid === 'empty' ? '' : ' '}`,
                  ];
            await add(target, plays, when, [
              ...badGuid,
              `${alternate === 'tmdbId' ? 'tmdb' : 'tvdb'}://${unique}`,
            ]);
            // A play with only this invalid id cannot join either title.
            const key = String(++sequence);
            rows.push(history(kind, key, second));
            metadata[key] = { guids: badGuid, media_type: kind === 'radarr' ? 'movie' : 'show' };
          }
        }
      }
      const unchanged = await add(
        { arrKind: 'radarr', tmdbId: 900001, imdbId: 'tt900001', tvdbId: 900001 },
        3,
        first,
      );
      await add({ arrKind: 'radarr', tmdbId: 900002 }, 0, null);
      await add({ arrKind: 'radarr', tmdbId: 0, imdbId: '' }, null, null);
      // No usable cached id: get_metadata must still be tried, then the target remains unknown.
      const unknownCached = await add(
        { arrKind: 'sonarr', tmdbId: 0, tvdbId: 0, imdbId: 'tt0' },
        null,
        null,
      );
      const unknownKey = String(sequence);
      rows.push(history('sonarr', unknownKey, first));
      metadata[unknownKey] = { guids: ['tmdb://0', 'tvdb://', 'imdb://tt0'], media_type: 'show' };

      const stub = source(rows, metadata);
      const cached = await loadPlexRatingGuids(t.db);
      expect(cached.has(plexRatingGuidKey('haynesops', unknownKey))).toBe(false);
      const context = await buildMetadataContext({
        sources: stub,
        logger: noopLogger,
        ratingKeyGuids: route === 'cached' ? cached : new Map(),
      });
      expect(context.watchComplete).toBe(true);
      for (const item of expected) {
        const watch = lookupHouseholdWatch(context.watchIndex, item.target);
        expect(watch?.household.playCount ?? (item.plays === null ? null : 0)).toBe(item.plays);
        expect(watch?.household.lastViewedAt?.toISOString() ?? null).toBe(item.last);
      }
      // An absent viewer is preserved even when this row may be contaminated.
      const zeroId = expected.find((r) => r.plays === 0)!.id;
      await upsertUserMediaWatchBatch({
        db: t.db,
        rows: [
          {
            mediaItemId: zeroId,
            appUserId: viewer.id,
            playCount: 99,
            lastViewedAt: new Date(second),
            watched: true,
            inProgress: false,
          },
        ],
      });
      await upsertUserMediaWatchBatch({
        db: t.db,
        rows: [
          {
            mediaItemId: unknownCached,
            appUserId: viewer.id,
            playCount: 99,
            lastViewedAt: new Date(second),
            watched: true,
            inProgress: false,
          },
        ],
      });

      await runMetadataRefreshForKind({
        db: t.db,
        clients: fixtureArrClients(),
        sources: stub,
        context: { ...context, watchComplete: false },
        arrKind: 'radarr',
        logger: noopLogger,
        staleThresholdMs: -1,
      });
      const [notCleared] = await t.db
        .select()
        .from(userMediaWatch)
        .where(eq(userMediaWatch.mediaItemId, zeroId));
      expect(notCleared).toMatchObject({ playCount: 99, watched: true });
      for (const arrKind of ['radarr', 'sonarr'] as const)
        await runMetadataRefreshForKind({
          db: t.db,
          clients: fixtureArrClients(),
          sources: stub,
          context,
          arrKind,
          logger: noopLogger,
          staleThresholdMs: -1,
        });
      for (const item of expected) {
        const [stored] = await t.db
          .select()
          .from(mediaMetadata)
          .where(eq(mediaMetadata.mediaItemId, item.id));
        expect(stored!.playCount, item.id).toBe(item.plays);
        expect(stored!.lastViewedAt?.toISOString() ?? null).toBe(item.last);
        expect(stored!.lastWatchedAt?.toISOString() ?? null).toBe(item.last);
        expect(stored!.lastWatchedServer).toBe(item.last ? 'haynesops' : null);
      }
      const [retained] = await t.db
        .select()
        .from(userMediaWatch)
        .where(eq(userMediaWatch.mediaItemId, zeroId));
      expect(retained).toMatchObject({ playCount: 99, watched: true });
      const [unknown] = await t.db
        .select()
        .from(userMediaWatch)
        .where(eq(userMediaWatch.mediaItemId, unknownCached));
      expect(unknown).toMatchObject({ playCount: 99, watched: true });

      // Exercise the existing dry run against the contaminated baseline, then apply in embedded PG only.
      await upsertMediaMetadataBatch({
        db: t.db,
        rows: [
          { mediaItemId: unchanged, playCount: 999, imdbRating: 7.5, extra: { retained: true } },
        ],
      });
      const dry = await backfillWatchHistory({
        db: t.db,
        tautulli: stub.tautulli,
        logger: noopLogger,
        apply: false,
      });
      expect(dry).toMatchObject({ complete: true, written: 0 });
      expect(dry.played + (dry.zeros ?? 0) + dry.unknown).toBe(dry.candidates);
      expect(
        (
          await t.db.select().from(mediaMetadata).where(eq(mediaMetadata.mediaItemId, unchanged))
        )[0]!.playCount,
      ).toBe(999);
      const applied = await backfillWatchHistory({
        db: t.db,
        tautulli: stub.tautulli,
        logger: noopLogger,
        apply: true,
      });
      expect(applied.written).toBeGreaterThan(0);
      for (const item of expected) {
        const [corrected] = await t.db
          .select()
          .from(mediaMetadata)
          .where(eq(mediaMetadata.mediaItemId, item.id));
        expect(corrected!.playCount, `backfill ${item.id}`).toBe(item.plays);
        expect(corrected!.lastViewedAt?.toISOString() ?? null).toBe(item.last);
      }
      const [preserved] = await t.db
        .select()
        .from(mediaMetadata)
        .where(eq(mediaMetadata.mediaItemId, unchanged));
      expect(preserved).toMatchObject({
        playCount: 3,
        imdbRating: '7.5',
        extra: { retained: true },
      });
      // The household backfill also preserves absent viewer evidence.
      await upsertUserMediaWatchBatch({
        db: t.db,
        rows: [
          {
            mediaItemId: zeroId,
            appUserId: viewer.id,
            playCount: 99,
            lastViewedAt: new Date(second),
            watched: true,
            inProgress: false,
          },
        ],
      });
      const userOnly = await backfillWatchHistory({
        db: t.db,
        tautulli: stub.tautulli,
        logger: noopLogger,
        apply: true,
      });
      expect(userOnly).toMatchObject({ changed: 0, written: 0, userWatchWritten: 0 });
      const again = await backfillWatchHistory({
        db: t.db,
        tautulli: stub.tautulli,
        logger: noopLogger,
        apply: true,
      });
      expect(again).toMatchObject({ changed: 0, written: 0, userWatchWritten: 0 });
    },
  );

  it.each(['tmdb', 'tvdb'])(
    'rejects malformed raw %s metadata before conversion',
    async (scheme) => {
      for (const raw of ['0x10', '1.6e1']) {
        const stub = source([history('radarr', 'malformed', first)], {
          malformed: { media_type: 'movie', guids: [`${scheme}://${raw}`] },
        });
        const context = await buildMetadataContext({ sources: stub, logger: noopLogger });
        expect(
          lookupHouseholdWatch(context.watchIndex, { arrKind: 'radarr', tmdbId: 16, tvdbId: 16 }),
        ).toBeNull();
        expect(context.watchInstances[0]!.unjoined).toBe(1);
      }
    },
  );

  it('skips unknown history kinds and rejects conflicting metadata; cache kind disagreement falls back', async () => {
    const stub = source(
      [
        { rating_key: '1', stopped: Date.parse(first) / 1000 },
        history('radarr', '2', first),
        history('sonarr', '3', second),
        // A rating key reused across row kinds must be grouped separately.
        history('radarr', '3', first),
      ],
      { '2': { media_type: 'show', guids: ['tmdb://91'] }, '3': { guids: ['tmdb://92'] } },
    );
    const context = await buildMetadataContext({
      sources: stub,
      logger: noopLogger,
      ratingKeyGuids: new Map([
        [plexRatingGuidKey('haynesops', '3'), { arrKind: 'radarr', tmdbId: 93 }],
      ]),
    });
    expect(lookupHouseholdWatch(context.watchIndex, { arrKind: 'radarr', tmdbId: 91 })).toBeNull();
    expect(
      lookupHouseholdWatch(context.watchIndex, { arrKind: 'sonarr', tmdbId: 92 })?.household
        .playCount,
    ).toBe(1);
    expect(
      lookupHouseholdWatch(context.watchIndex, {
        arrKind: 'radarr',
        tmdbId: 93,
      })?.household.lastViewedAt?.toISOString(),
    ).toBe(first);
    expect(
      stub.calls
        .filter((c) => c.url.searchParams.get('cmd') === 'get_metadata')
        .map((c) => c.url.searchParams.get('rating_key')),
    ).not.toContain('1');
  });
});
