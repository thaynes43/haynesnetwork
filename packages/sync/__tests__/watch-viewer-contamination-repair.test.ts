// Synthetic fixtures only; no household/account production data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mediaItems, plexLibraries, userMediaWatch, type ArrKind } from '@hnet/db';
import {
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
  upsertUserAccountHandles,
  upsertUserMediaWatchBatch,
} from '@hnet/domain';
import { TautulliClient } from '@hnet/arr/read';
import { repairViewerContamination } from '../src/watch-viewer-contamination-repair';
import { buildMetadataContext, runMetadataRefreshForKind } from '../src/metadata-refresh';
import { noopLogger } from '../src/logger';
import { bootMigratedDb, createUser, fixtureArrClients, stubFetch, type TestDb } from './helpers';

const when = new Date('2025-01-01T00:00:00Z');
let sequence = 500000;
function sources(
  rows: object[],
  metadata: object | null,
  fail = false,
  before?: () => Promise<void>,
) {
  const stub = stubFetch([
    {
      path: '/api/v2',
      body: (url: URL) => {
        if (fail) throw new Error('synthetic unavailable');
        return {
          response: {
            result: 'success',
            data:
              url.searchParams.get('cmd') === 'get_metadata' ? (metadata ?? {}) : { data: rows },
          },
        };
      },
    },
  ]);
  let observed = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (!observed && before) {
      observed = true;
      await before();
    }
    return stub.fetchImpl(url, init);
  };
  return {
    tautulli: [
      {
        slug: 'haynesops',
        client: new TautulliClient({
          baseUrl: 'http://synthetic.test',
          apiKey: 'synthetic',
          fetchImpl,
          retryDelayMs: 0,
        }),
      },
    ],
  };
}

describe('one-off viewer contamination repair', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t?.stop();
  });
  async function item(kind: ArrKind, tmdbId: number, tvdbId?: number) {
    const n = ++sequence;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: kind,
      arrInstanceId: `repair-${n}`,
      items: [
        {
          arrItemId: n,
          tmdbId,
          tvdbId,
          title: `Synthetic ${n}`,
          sortTitle: `synthetic ${n}`,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Synthetic',
          rootFolder: '/synthetic',
        },
      ],
    });
    return (
      await t.db
        .select()
        .from(mediaItems)
        .where(eq(mediaItems.arrInstanceId, `repair-${n}`))
    )[0]!;
  }
  async function fixture(zero = false) {
    const n = ++sequence;
    const target = await item(zero ? 'sonarr' : 'radarr', zero ? 0 : n, n + 100000);
    const owner = await item('sonarr', zero ? 0 : n, n + 200000);
    const viewer = await createUser(t.db);
    await upsertUserAccountHandles({ db: t.db, userId: viewer.id, plexUserId: String(n) });
    await upsertUserMediaWatchBatch({
      db: t.db,
      rows: [
        {
          mediaItemId: target.id,
          appUserId: viewer.id,
          playCount: 1,
          lastViewedAt: when,
          watched: true,
          inProgress: false,
        },
      ],
    });
    return {
      n,
      target,
      owner,
      viewer,
      rows: [
        {
          media_type: 'episode',
          rating_key: String(n + 1),
          grandparent_rating_key: String(n),
          stopped: when.getTime() / 1000,
          user_id: n,
          watched_status: 1,
        },
      ],
    };
  }
  it.each(['unavailable', 'refused', 'empty', 'unmapped', 'changed', 'missing-user', 'incomplete'])(
    'preserves absent viewer evidence for %s in the harvest and repair',
    async (mode) => {
      const f = await fixture();
      if (mode === 'unmapped' || mode === 'changed')
        await upsertUserAccountHandles({
          db: t.db,
          userId: f.viewer.id,
          plexUserId: mode === 'unmapped' ? null : String(f.n + 1),
        });
      const rows =
        mode === 'empty'
          ? []
          : mode === 'missing-user'
            ? f.rows.map((r) => ({ ...r, user_id: null }))
            : mode === 'changed'
              ? f.rows.map((r) => ({ ...r, user_id: f.n + 1 }))
              : f.rows;
      const stub = sources(
        rows,
        mode === 'unavailable'
          ? null
          : { media_type: mode === 'refused' ? 'clip' : 'show', guids: [`tmdb://${f.n}`] },
        mode === 'incomplete',
      );
      const context = await buildMetadataContext({ sources: stub, logger: noopLogger });
      await runMetadataRefreshForKind({
        db: t.db,
        clients: fixtureArrClients(),
        sources: stub,
        context,
        arrKind: 'radarr',
        logger: noopLogger,
        staleThresholdMs: -1,
      });
      const report = await repairViewerContamination({
        db: t.db,
        tautulli: stub.tautulli,
        apply: true,
      });
      expect(report.rowsCleared).toBe(0);
      if (['empty', 'unavailable', 'refused', 'missing-user', 'incomplete'].includes(mode))
        expect(report.complete).toBe(false);
      expect(
        (
          await t.db
            .select()
            .from(userMediaWatch)
            .where(eq(userMediaWatch.mediaItemId, f.target.id))
        )[0],
      ).toMatchObject({ playCount: 1, watched: true, lastViewedAt: when });
    },
  );
  it.each([false, true])(
    'clears proved contamination only with apply; zero-id=%s; second apply is inert',
    async (zero) => {
      const f = await fixture(zero);
      if (zero) {
        await upsertPlexLibraries({
          db: t.db,
          slug: 'haynesops',
          libraries: [{ sectionKey: 'repair', name: 'Synthetic', mediaType: 'show' }],
        });
        const [lib] = await t.db
          .select()
          .from(plexLibraries)
          .where(eq(plexLibraries.sectionKey, 'repair'));
        await syncPlexMatches({
          db: t.db,
          scopedLibraryIds: [],
          matches: [
            {
              mediaItemId: f.owner.id,
              plexLibraryId: lib!.id,
              ratingKey: String(f.n),
              matchedVia: 'tvdb',
            },
          ],
        });
      }
      const stub = sources(f.rows, {
        media_type: 'show',
        guids: [`tmdb://${zero ? 0 : f.n}`, `tvdb://${f.owner.tvdbId}`],
      });
      const dry = await repairViewerContamination({
        db: t.db,
        tautulli: stub.tautulli,
        apply: false,
      });
      expect(dry).toMatchObject({
        complete: true,
        rowsToClear: 1,
        rowsCleared: 0,
        titlesTouched: 1,
        viewersTouched: 1,
      });
      const applied = await repairViewerContamination({
        db: t.db,
        tautulli: stub.tautulli,
        apply: true,
      });
      expect(applied.rowsCleared).toBe(1);
      expect(
        (
          await t.db
            .select()
            .from(userMediaWatch)
            .where(eq(userMediaWatch.mediaItemId, f.target.id))
        )[0],
      ).toMatchObject({ playCount: 0, lastViewedAt: null, watched: false, inProgress: false });
      expect(
        (await repairViewerContamination({ db: t.db, tautulli: stub.tautulli, apply: true }))
          .rowsCleared,
      ).toBe(0);
    },
  );
  it.each(['aggregate-mismatch', 'own-play', 'unaccounted-play'])(
    'preserves a row without full positive proof: %s',
    async (mode) => {
      const f = await fixture();
      const rows: object[] = [...f.rows];
      if (mode === 'own-play')
        rows.push({ ...f.rows[0], media_type: 'movie', rating_key: String(f.n + 2) });
      if (mode === 'unaccounted-play') rows.push({ ...f.rows[0], user_id: null });
      if (mode === 'aggregate-mismatch')
        await upsertUserMediaWatchBatch({
          db: t.db,
          rows: [
            {
              mediaItemId: f.target.id,
              appUserId: f.viewer.id,
              playCount: 2,
              lastViewedAt: when,
              watched: true,
              inProgress: false,
            },
          ],
        });
      // With own-play, absent cached ids force movie metadata; the show is refused, so no clear is proved.
      const stub = sources(rows, {
        media_type: mode === 'own-play' ? 'movie' : 'show',
        guids: [`tmdb://${f.n}`],
      });
      expect(
        (await repairViewerContamination({ db: t.db, tautulli: stub.tautulli, apply: true }))
          .rowsCleared,
      ).toBe(0);
    },
  );

  it.each(['unavailable', 'refused', 'missing-user'])(
    'preserves a proved-looking row when another history group is %s',
    async (mode) => {
      const f = await fixture();
      const rows = [
        ...f.rows,
        {
          ...f.rows[0],
          media_type: 'movie',
          rating_key: 'unresolved',
          user_id: mode === 'missing-user' ? null : f.n,
        },
      ];
      const stub = stubFetch([
        {
          path: '/api/v2',
          body: (url: URL) => ({
            response: {
              result: 'success',
              data:
                url.searchParams.get('cmd') !== 'get_metadata'
                  ? { data: rows }
                  : url.searchParams.get('rating_key') === String(f.n)
                    ? { media_type: 'show', guids: [`tmdb://${f.n}`] }
                    : mode === 'refused'
                      ? { media_type: 'clip', guids: [`tmdb://${f.n}`] }
                      : {},
            },
          }),
        },
      ]);
      const tautulli = [
        {
          slug: 'haynesops',
          client: new TautulliClient({
            baseUrl: 'http://synthetic.test',
            apiKey: 'synthetic',
            fetchImpl: stub.fetchImpl,
          }),
        },
      ];
      expect(
        (await repairViewerContamination({ db: t.db, tautulli, apply: true })).rowsCleared,
      ).toBe(0);
    },
  );

  it.each(['viewer-row', 'title-identity'])(
    'refuses inputs changed during the read: %s',
    async (mode) => {
      const f = await fixture();
      const before = async () => {
        if (mode === 'viewer-row') {
          await upsertUserMediaWatchBatch({
            db: t.db,
            rows: [
              {
                mediaItemId: f.target.id,
                appUserId: f.viewer.id,
                playCount: 1,
                lastViewedAt: when,
                watched: true,
                inProgress: false,
              },
            ],
          });
        } else {
          await upsertMediaItemsBatch({
            db: t.db,
            arrKind: 'radarr',
            arrInstanceId: f.target.arrInstanceId,
            items: [
              {
                arrItemId: f.target.arrItemId,
                tmdbId: f.n + 1,
                title: 'Synthetic changed identity',
                sortTitle: 'synthetic changed',
                monitored: true,
                qualityProfileId: 1,
                qualityProfileName: 'Synthetic',
                rootFolder: '/synthetic',
              },
            ],
          });
        }
      };
      const stub = sources(f.rows, { media_type: 'show', guids: [`tmdb://${f.n}`] }, false, before);
      const report = await repairViewerContamination({
        db: t.db,
        tautulli: stub.tautulli,
        apply: true,
      });
      expect(report.rowsCleared).toBe(0);
      if (mode === 'title-identity') expect(report.complete).toBe(false);
    },
  );

  it('documents main behavior: a partial present viewer can overwrite a larger row', async () => {
    const f = await fixture();
    const one = sources(
      [{ ...f.rows[0], media_type: 'movie', rating_key: String(f.n), watched_status: 0.5 }],
      { media_type: 'movie', guids: [`tmdb://${f.n}`] },
    );
    const failed = sources([], null, true);
    const stub = { tautulli: [...one.tautulli, { ...failed.tautulli[0]!, slug: 'haynestower' }] };
    await upsertUserMediaWatchBatch({
      db: t.db,
      rows: [
        {
          mediaItemId: f.target.id,
          appUserId: f.viewer.id,
          playCount: 7,
          lastViewedAt: when,
          watched: true,
          inProgress: false,
        },
      ],
    });
    const context = await buildMetadataContext({ sources: stub, logger: noopLogger });
    expect(context.watchComplete).toBe(false);
    await runMetadataRefreshForKind({
      db: t.db,
      clients: fixtureArrClients(),
      sources: stub,
      context,
      arrKind: 'radarr',
      logger: noopLogger,
      staleThresholdMs: -1,
    });
    expect(
      (
        await t.db.select().from(userMediaWatch).where(eq(userMediaWatch.mediaItemId, f.target.id))
      )[0],
    ).toMatchObject({ playCount: 1, watched: false, inProgress: true });
  });
});
