// ADR-123 / DESIGN-025 D-10 — the repair deletes cross-type media_plex_matches rows and nothing else.
// A second run is a no-op. The sync writer does the same delete, including for a library it did not read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mediaItems, mediaMetadata, mediaPlexMatches, plexLibraries, type Database } from '@hnet/db';
import {
  FITTING_PLEX_MEDIA_TYPE,
  judgeAge,
  repairCrossTypePlexMatches,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
} from '../src';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
let movieLib: string;
let showLib: string;
let artistLib: string;
let photoLib: string;
let movieId: string;
let showId: string;
let artistId: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [
      { sectionKey: '1', name: 'Movies', mediaType: 'movie' },
      { sectionKey: '2', name: 'TV', mediaType: 'show' },
      { sectionKey: '3', name: 'Music', mediaType: 'artist' },
      { sectionKey: '9', name: 'Photos', mediaType: 'photo' },
    ],
  });
  const libs = await t.db
    .select({ id: plexLibraries.id, sectionKey: plexLibraries.sectionKey })
    .from(plexLibraries);
  const lib = (key: string) => libs.find((row) => row.sectionKey === key)!.id;
  movieLib = lib('1');
  showLib = lib('2');
  artistLib = lib('3');
  photoLib = lib('9');

  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'radarr',
    items: [item(1, 'Movie', { tmdbId: 501 })],
  });
  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'sonarr',
    items: [item(2, 'Show', { tvdbId: 801 })],
  });
  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'lidarr',
    items: [item(3, 'Artist', { musicbrainzArtistId: 'artist-shared' })],
  });
  movieId = await itemId(t.db, 'radarr', 1);
  showId = await itemId(t.db, 'sonarr', 2);
  artistId = await itemId(t.db, 'lidarr', 3);
});

afterAll(async () => {
  await t?.stop();
});

function item(arrItemId: number, title: string, over: Record<string, unknown>) {
  return {
    arrItemId,
    title,
    sortTitle: title.toLowerCase(),
    monitored: true,
    qualityProfileId: 1,
    qualityProfileName: 'Any',
    rootFolder: '/data/x',
    onDiskFileCount: 1,
    expectedFileCount: 1,
    sizeOnDisk: 1,
    ...over,
  } as Parameters<typeof upsertMediaItemsBatch>[0]['items'][number];
}

async function itemId(
  database: Database,
  arrKind: 'radarr' | 'sonarr' | 'lidarr',
  arrItemId: number,
) {
  const [row] = await database
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(eq(mediaItems.arrKind, arrKind), eq(mediaItems.arrItemId, arrItemId)));
  return row!.id;
}

async function ratingKeys(): Promise<string[]> {
  const rows = await t.db.select({ ratingKey: mediaPlexMatches.ratingKey }).from(mediaPlexMatches);
  return rows.map((row) => row.ratingKey).sort();
}

describe('repairCrossTypePlexMatches (ADR-123)', () => {
  it('names the three fitting pairs', () => {
    expect(FITTING_PLEX_MEDIA_TYPE).toEqual({ radarr: 'movie', sonarr: 'show', lidarr: 'artist' });
  });

  it('removes exactly the cross-type rows, and a second run removes nothing', async () => {
    await t.db.insert(mediaPlexMatches).values([
      { mediaItemId: movieId, plexLibraryId: movieLib, ratingKey: 'm1', matchedVia: 'tmdb' },
      { mediaItemId: showId, plexLibraryId: showLib, ratingKey: 's1', matchedVia: 'tvdb' },
      {
        mediaItemId: artistId,
        plexLibraryId: artistLib,
        ratingKey: 'a1',
        matchedVia: 'musicbrainz',
      },
      { mediaItemId: movieId, plexLibraryId: showLib, ratingKey: 'bad-show', matchedVia: 'tmdb' },
      { mediaItemId: showId, plexLibraryId: movieLib, ratingKey: 'bad-movie', matchedVia: 'tvdb' },
      {
        mediaItemId: artistId,
        plexLibraryId: movieLib,
        ratingKey: 'bad-artist',
        matchedVia: 'musicbrainz',
      },
      { mediaItemId: movieId, plexLibraryId: photoLib, ratingKey: 'bad-photo', matchedVia: 'imdb' },
    ]);

    const dry = await repairCrossTypePlexMatches({ db: t.db, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.selected).toBe(4);
    expect(dry.removed).toBe(0);
    expect(dry.groups.map((group) => group.rows).reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(dry.titles).toEqual([
      {
        title: 'Artist',
        year: null,
        arrKind: 'lidarr',
        serverSlug: 'haynestower',
        libraryName: 'Movies',
      },
      {
        title: 'Movie',
        year: null,
        arrKind: 'radarr',
        serverSlug: 'haynestower',
        libraryName: 'Photos',
      },
      {
        title: 'Movie',
        year: null,
        arrKind: 'radarr',
        serverSlug: 'haynestower',
        libraryName: 'TV',
      },
      {
        title: 'Show',
        year: null,
        arrKind: 'sonarr',
        serverSlug: 'haynestower',
        libraryName: 'Movies',
      },
    ]);
    expect(await ratingKeys()).toEqual([
      'a1',
      'bad-artist',
      'bad-movie',
      'bad-photo',
      'bad-show',
      'm1',
      's1',
    ]);

    const applied = await repairCrossTypePlexMatches({ db: t.db, dryRun: false });
    expect(applied.selected).toBe(4);
    expect(applied.removed).toBe(4);
    expect(await ratingKeys()).toEqual(['a1', 'm1', 's1']);

    const second = await repairCrossTypePlexMatches({ db: t.db, dryRun: false });
    expect(second.selected).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.groups).toEqual([]);
    expect(second.titles).toEqual([]);
    expect(await ratingKeys()).toEqual(['a1', 'm1', 's1']);
  });

  it('the sync deletes a cross-type row in a library it did not read, and leaves fitting rows there', async () => {
    await t.db.insert(mediaPlexMatches).values({
      mediaItemId: movieId,
      plexLibraryId: showLib,
      ratingKey: 'bad-unscoped',
      matchedVia: 'tmdb',
    });
    const report = await syncPlexMatches({
      db: t.db,
      matches: [
        { mediaItemId: movieId, plexLibraryId: movieLib, ratingKey: 'm1', matchedVia: 'tmdb' },
      ],
      scopedLibraryIds: [movieLib],
    });
    expect(report.removed).toBe(0);
    expect(report.crossTypeRemoved).toBe(1);
    expect(await ratingKeys()).toEqual(['a1', 'm1', 's1']);
  });

  it('a cross-type row handed to the sync does not survive the transaction', async () => {
    const report = await syncPlexMatches({
      db: t.db,
      matches: [
        { mediaItemId: movieId, plexLibraryId: movieLib, ratingKey: 'm1', matchedVia: 'tmdb' },
        { mediaItemId: showId, plexLibraryId: showLib, ratingKey: 's1', matchedVia: 'tvdb' },
        {
          mediaItemId: artistId,
          plexLibraryId: artistLib,
          ratingKey: 'a1',
          matchedVia: 'musicbrainz',
        },
        {
          mediaItemId: movieId,
          plexLibraryId: showLib,
          ratingKey: 'bad-again',
          matchedVia: 'imdb',
        },
      ],
      scopedLibraryIds: [movieLib, showLib, artistLib],
    });
    expect(report.crossTypeRemoved).toBe(1);
    expect(report.crossTypeGroups).toEqual([
      expect.objectContaining({
        serverSlug: 'haynestower',
        libraryName: 'TV',
        mediaType: 'show',
        arrKind: 'radarr',
        matchedVia: 'imdb',
        rows: 1,
      }),
    ]);
    expect(await ratingKeys()).toEqual(['a1', 'm1', 's1']);
  });

  it('a healthy run counts a stale wrong row as crossTypeRemoved, and the Age Guard goes from recent to clear', async () => {
    const recent = new Date('2026-10-01T00:00:00.000Z');
    const old = new Date('2024-01-01T00:00:00.000Z');
    const now = Date.parse('2026-11-13T17:00:00.000Z');
    await t.db
      .update(mediaPlexMatches)
      .set({ plexAddedAt: old })
      .where(
        and(eq(mediaPlexMatches.mediaItemId, movieId), eq(mediaPlexMatches.plexLibraryId, movieLib)),
      );
    await t.db.insert(mediaPlexMatches).values({
      mediaItemId: movieId,
      plexLibraryId: showLib,
      ratingKey: 'stale-wrong',
      matchedVia: 'tmdb',
      plexAddedAt: recent,
      lastSeenAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    await t.db.insert(mediaMetadata).values({
      mediaItemId: movieId,
      playCount: 4,
      lastViewedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(
      judgeAge(
        { newestImportAt: null, newestPlexAddedAt: recent, plexMatches: 2, plexUndated: 0 },
        now,
      ).ageGuard,
    ).toBe('recent');

    const report = await syncPlexMatches({
      db: t.db,
      matches: [
        {
          mediaItemId: movieId,
          plexLibraryId: movieLib,
          ratingKey: 'm1',
          matchedVia: 'tmdb',
          plexAddedAt: old,
        },
        {
          mediaItemId: showId,
          plexLibraryId: showLib,
          ratingKey: 's1',
          matchedVia: 'tvdb',
          plexAddedAt: old,
        },
        {
          mediaItemId: artistId,
          plexLibraryId: artistLib,
          ratingKey: 'a1',
          matchedVia: 'musicbrainz',
        },
      ],
      scopedLibraryIds: [movieLib, showLib, artistLib],
      now: new Date(now),
    });
    expect(report.removed).toBe(0);
    expect(report.crossTypeRemoved).toBe(1);
    expect(report.crossTypeGroups).toEqual([
      expect.objectContaining({ arrKind: 'radarr', mediaType: 'show', rows: 1 }),
    ]);
    expect(await ratingKeys()).toEqual(['a1', 'm1', 's1']);
    expect(
      judgeAge(
        { newestImportAt: null, newestPlexAddedAt: old, plexMatches: 1, plexUndated: 0 },
        now,
      ).ageGuard,
    ).toBe('clear');
    const [stored] = await t.db
      .select({ playCount: mediaMetadata.playCount, lastViewedAt: mediaMetadata.lastViewedAt })
      .from(mediaMetadata)
      .where(eq(mediaMetadata.mediaItemId, movieId));
    expect(stored).toEqual({
      playCount: 4,
      lastViewedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  it('removes a cross-type IMDb row and keeps the fitting IMDb row', async () => {
    await t.db
      .update(mediaPlexMatches)
      .set({ matchedVia: 'imdb', ratingKey: 'show-imdb' })
      .where(
        and(eq(mediaPlexMatches.mediaItemId, showId), eq(mediaPlexMatches.plexLibraryId, showLib)),
      );
    await t.db.insert(mediaPlexMatches).values({
      mediaItemId: showId,
      plexLibraryId: movieLib,
      ratingKey: 'movie-imdb',
      matchedVia: 'imdb',
    });
    const applied = await repairCrossTypePlexMatches({ db: t.db, dryRun: false });
    expect(applied.removed).toBe(1);
    expect(applied.titles).toEqual([
      expect.objectContaining({
        title: 'Show',
        arrKind: 'sonarr',
        libraryName: 'Movies',
      }),
    ]);
    expect(await ratingKeys()).toEqual(['a1', 'm1', 'show-imdb']);
  });

  it('leaves an excluded library out of the cross-type delete', async () => {
    await t.db.insert(mediaPlexMatches).values({
      mediaItemId: movieId,
      plexLibraryId: showLib,
      ratingKey: 'kept-live',
      matchedVia: 'tmdb',
    });
    const report = await syncPlexMatches({
      db: t.db,
      matches: [
        { mediaItemId: movieId, plexLibraryId: movieLib, ratingKey: 'm1', matchedVia: 'tmdb' },
      ],
      scopedLibraryIds: [movieLib],
      excludeCrossTypeLibraryIds: [showLib],
    });
    expect(report.crossTypeRemoved).toBe(0);
    expect(await ratingKeys()).toContain('kept-live');
    await t.db.delete(mediaPlexMatches).where(eq(mediaPlexMatches.ratingKey, 'kept-live'));
  });
});
