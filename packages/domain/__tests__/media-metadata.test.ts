import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaItems, mediaMetadata } from '@hnet/db/schema';
import { parseArrTags, upsertMediaMetadataBatch, upsertMediaItemsBatch } from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

describe('parseArrTags (DESIGN-008 D-07 — *arr tag semantics)', () => {
  it('splits requester tags (\\d+-<user>) from collection tags, de-duping each', () => {
    const { requesters, sourceCollections } = parseArrTags([
      '1-manofoz',
      '23-helmu15',
      'emmycollection',
      'kometa-added',
      '1-manofoz', // dup requester
      'showcollection',
      'showcollection', // dup collection
    ]);
    expect(requesters).toEqual(['manofoz', 'helmu15']);
    expect(sourceCollections).toEqual(['emmycollection', 'kometa-added', 'showcollection']);
  });

  it('handles the empty / no-requester cases', () => {
    expect(parseArrTags([])).toEqual({ requesters: [], sourceCollections: [] });
    expect(parseArrTags(['tmdbpopular', 'traktrecommended'])).toEqual({
      requesters: [],
      sourceCollections: ['tmdbpopular', 'traktrecommended'],
    });
  });
});

describe('upsertMediaMetadataBatch (ADR-018 / DESIGN-008 D-12)', () => {
  let t: TestDb;
  let mediaItemId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 42,
          tmdbId: 550,
          title: 'Fight Club',
          sortTitle: 'fight club',
          year: 1999,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'HD-1080p',
          rootFolder: '/data/movies',
        },
      ],
    });
    const [row] = await t.db.select({ id: mediaItems.id }).from(mediaItems);
    mediaItemId = row!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('inserts a metadata row 1:1 with the media item', async () => {
    const { written } = await upsertMediaMetadataBatch({
      db: t.db,
      rows: [
        {
          mediaItemId,
          imdbRating: 8.8,
          imdbVotes: 2_300_000,
          tmdbRating: 8.4,
          rtTomatometer: 79,
          runtimeMinutes: 139,
          resolution: '1080p',
          genres: ['Drama', 'Thriller'],
          requesters: ['manofoz'],
          sourceCollections: ['imdbtop250'],
          posterSource: 'arr',
          posterRef: '/MediaCover/42/poster.jpg?lastWrite=1',
          playCount: 3,
          lastViewedAt: new Date('2024-05-01T00:00:00Z'),
          // DESIGN-010 D-12 — the cross-server watch-visibility pair.
          lastWatchedAt: new Date('2024-05-01T00:00:00Z'),
          lastWatchedServer: 'hayneskube',
          sources: { arr: true, tautulli: true },
          extra: { tautulli: { haynesops: { playCount: 3, lastViewedAt: null } } },
        },
      ],
    });
    expect(written).toBe(1);
    const [meta] = await t.db
      .select()
      .from(mediaMetadata)
      .where(eq(mediaMetadata.mediaItemId, mediaItemId));
    expect(meta).toMatchObject({
      imdbRating: '8.8', // numeric renders as a string
      imdbVotes: 2_300_000,
      rtTomatometer: 79,
      resolution: '1080p',
      genres: ['Drama', 'Thriller'],
      requesters: ['manofoz'],
      posterSource: 'arr',
      lastWatchedServer: 'hayneskube',
    });
    expect(meta!.lastWatchedAt?.toISOString()).toBe('2024-05-01T00:00:00.000Z');
    expect(meta!.sources).toEqual({ arr: true, tautulli: true });
  });

  it('upserts on media_item_id (ON CONFLICT → replace) and advances fetched_at', async () => {
    const [before] = await t.db
      .select({ fetchedAt: mediaMetadata.fetchedAt })
      .from(mediaMetadata)
      .where(eq(mediaMetadata.mediaItemId, mediaItemId));
    await new Promise((r) => setTimeout(r, 15));
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [{ mediaItemId, imdbRating: 9.0, genres: ['Drama'], sources: { arr: true } }],
    });
    const rows = await t.db
      .select()
      .from(mediaMetadata)
      .where(eq(mediaMetadata.mediaItemId, mediaItemId));
    expect(rows).toHaveLength(1); // still 1:1 — replaced, not duplicated
    expect(rows[0]!.imdbRating).toBe('9.0');
    expect(rows[0]!.rtTomatometer).toBeNull(); // full replace cleared the prior RT value
    // The full replace also clears the prior watch-visibility pair (D-12) — synced-copy semantics.
    expect(rows[0]!.lastWatchedAt).toBeNull();
    expect(rows[0]!.lastWatchedServer).toBeNull();
    expect(rows[0]!.fetchedAt.getTime()).toBeGreaterThan(before!.fetchedAt.getTime());
  });

  it('no-ops cleanly on an empty batch', async () => {
    expect(await upsertMediaMetadataBatch({ db: t.db, rows: [] })).toEqual({ written: 0 });
  });
});
