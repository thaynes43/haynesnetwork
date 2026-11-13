// ADR-123 / DESIGN-025 D-10 — the repair deletes cross-type media_plex_matches rows and nothing else.
// A second run is a no-op. The sync writer does the same delete, including for a library it did not read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mediaItems, mediaPlexMatches, plexLibraries, type Database } from '@hnet/db';
import {
  FITTING_PLEX_MEDIA_TYPE,
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
    expect(await ratingKeys()).toEqual(['a1', 'm1', 's1']);
  });
});
