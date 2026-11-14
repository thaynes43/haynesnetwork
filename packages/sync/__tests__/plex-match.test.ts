// ADR-047 / DESIGN-025 (PLAN-028) — the *arr→Plex match sweep: GUID parsing + the fetch/resolve that
// produces the match set (and its match rate) + the reconcile (a title dropping out of a fully-read
// library is removed). Proven against an embedded PG16 with a fake Plex read bundle (no live Plex).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mediaItems, mediaPlexMatches, plexLibraries, SEEDED_PLEX_SERVER_IDS } from '@hnet/db';
import type { Database, PlexServerSlug } from '@hnet/db';
import {
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
  type PlexClientBundle,
} from '@hnet/domain';
import {
  formatCrossTypeRepairReport,
  parseCrossTypeRepairArgs,
} from '../src/scripts/plex-match-type-repair';
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexSectionItem } from '@hnet/plex';
import { lookupHouseholdWatch, type TitleWatch, type WatchIndex } from '../src/metadata-refresh';
import { fetchPlexMatchSnapshot, parsePlexGuids } from '../src/plex-match';
import type { SyncLogger } from '../src/logger';
import { bootMigratedDb, type TestDb } from './helpers';

describe('parsePlexGuids', () => {
  it('parses tmdb/imdb/tvdb/mbid from the Guid array + legacy agent prefixes', () => {
    expect(
      parsePlexGuids({
        Guid: [{ id: 'tmdb://12345' }, { id: 'imdb://tt0111161' }, { id: 'tvdb://78901' }],
      }),
    ).toEqual({ tmdb: '12345', imdb: 'tt0111161', tvdb: '78901' });
    expect(parsePlexGuids({ Guid: [{ id: 'mbid://abc-def' }] })).toEqual({
      musicbrainz: 'abc-def',
    });
    expect(parsePlexGuids({ Guid: [{ id: 'com.plexapp.agents.imdb://tt42?lang=en' }] })).toEqual({
      imdb: 'tt42',
    });
    // The scalar plex:// guid is ignored for matching (no known scheme).
    expect(parsePlexGuids({ guid: 'plex://movie/5d776b', Guid: [] })).toEqual({});
  });
});

/** A fake PlexReadClient serving one Movies section (with GUIDs), one Photos section (skipped by type),
 *  and one unmapped 4K section absent from the registry. */
function fakeRead(): PlexReadClient {
  const movies: PlexSectionItem[] = [
    // DESIGN-052 D-26 — Movie A carries its Plex `addedAt` (epoch seconds); Movie B omits it.
    {
      ratingKey: '9001',
      type: 'movie',
      title: 'Movie A',
      addedAt: 1_780_000_000,
      Guid: [{ id: 'tmdb://500501' }],
    },
    { ratingKey: '9002', type: 'movie', title: 'Movie B', Guid: [{ id: 'imdb://tt999' }] },
  ] as unknown as PlexSectionItem[];
  return {
    machineIdentifier: 'mach-tower',
    async listSections() {
      return [
        { key: '1', title: 'HNet Movies', type: 'movie' },
        { key: '9', title: 'HNet Photos', type: 'photo' },
        { key: '5', title: 'HNet 4K', type: 'movie' }, // NOT in the registry → unmapped, skipped
      ];
    },
    async listSectionContentsPage(sectionKey: string, { start }: { start: number; size: number }) {
      if (sectionKey === '1' && start === 0) return { items: movies, totalSize: 2 };
      return { items: [], totalSize: sectionKey === '1' ? 2 : 0 };
    },
  } as unknown as PlexReadClient;
}

function fakeBundle(): Pick<PlexClientBundle, 'read'> {
  return { read: { haynestower: fakeRead() } as unknown as Record<PlexServerSlug, PlexReadClient> };
}

let t: TestDb;
let moviesLib: string;

async function seed(db: Database) {
  await upsertPlexLibraries({
    db,
    slug: 'haynestower',
    libraries: [{ sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' }],
  });
  const [lib] = await db
    .select({ id: plexLibraries.id })
    .from(plexLibraries)
    .where(
      and(
        eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynestower),
        eq(plexLibraries.sectionKey, '1'),
      ),
    );
  moviesLib = lib!.id;

  // radarr: A matches tmdb, B matches imdb (its tmdb is a non-hit), C has no matchable GUID; sonarr: no
  // TV section is read at all → unmatched.
  await upsertMediaItemsBatch({
    db,
    arrKind: 'radarr',
    items: [
      row('Movie A', { tmdbId: 500501, arrItemId: 1 }),
      row('Movie B', { tmdbId: 500502, imdbId: 'tt999', arrItemId: 2 }),
      row('Movie C', { tmdbId: 777777, arrItemId: 3 }),
    ],
  });
  await upsertMediaItemsBatch({
    db,
    arrKind: 'sonarr',
    items: [row('Show A', { tvdbId: 4242, arrItemId: 4 })],
  });
}

function row(title: string, over: Record<string, unknown>) {
  return {
    arrItemId: over.arrItemId as number,
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

beforeAll(async () => {
  t = await bootMigratedDb();
  await seed(t.db);
});
afterAll(async () => {
  await t?.stop();
});

describe('fetchPlexMatchSnapshot + syncPlexMatches (ADR-047)', () => {
  it('resolves matches by GUID and reports the per-kind match rate', async () => {
    const snap = await fetchPlexMatchSnapshot({ db: t.db, plex: fakeBundle() });
    // 2 of 3 radarr items matched (A via tmdb, B via imdb); C + the sonarr show unmatched.
    expect(snap.stats.byKind.radarr).toEqual({ total: 3, matched: 2 });
    expect(snap.stats.byKind.sonarr).toEqual({ total: 1, matched: 0 });
    expect(snap.stats.unmappedSections).toBe(1); // the 4K section absent from the registry
    expect(snap.scopedLibraryIds).toEqual([moviesLib]);
    const via = snap.matches.map((m) => m.matchedVia).sort();
    expect(via).toEqual(['imdb', 'tmdb']);
    expect(snap.matches.every((m) => m.plexLibraryId === moviesLib)).toBe(true);

    // Persist + verify the cache.
    const report = await syncPlexMatches({
      db: t.db,
      matches: snap.matches,
      scopedLibraryIds: snap.scopedLibraryIds,
    });
    expect(report.upserted).toBe(2);
    expect(await countMatches(t.db)).toBe(2);

    // DESIGN-052 D-26 — each match carries the title's Plex date added (null when Plex omits it), persisted.
    const byKey = new Map(snap.matches.map((m) => [m.ratingKey, m.plexAddedAt]));
    expect(byKey.get('9001')?.toISOString()).toBe(new Date(1_780_000_000 * 1000).toISOString());
    expect(byKey.get('9002')).toBeNull();
    const rows = await t.db
      .select({ ratingKey: mediaPlexMatches.ratingKey, plexAddedAt: mediaPlexMatches.plexAddedAt })
      .from(mediaPlexMatches);
    const stored = new Map(rows.map((r) => [r.ratingKey, r.plexAddedAt]));
    expect(stored.get('9001')?.toISOString()).toBe(new Date(1_780_000_000 * 1000).toISOString());
    expect(stored.get('9002')).toBeNull();
  });

  it('reconcile removes a match whose title dropped out of a fully-read library', async () => {
    // Re-run with only Movie A still present (Movie B vanished from Plex).
    const [movieA] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, 'radarr'), eq(mediaItems.arrItemId, 1)));
    await syncPlexMatches({
      db: t.db,
      matches: [
        {
          mediaItemId: movieA!.id,
          plexLibraryId: moviesLib,
          ratingKey: '9001',
          matchedVia: 'tmdb',
          plexAddedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ],
      scopedLibraryIds: [moviesLib],
    });
    expect(await countMatches(t.db)).toBe(1); // Movie B's stale match reconciled away
    // D-26 — a re-run re-stamps the date added (a replaced file Plex re-dated is picked up).
    const [a] = await t.db
      .select({ plexAddedAt: mediaPlexMatches.plexAddedAt })
      .from(mediaPlexMatches);
    expect(a!.plexAddedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('matches a shared id only inside the fitting library type, and a second run keeps the right pairs', async () => {
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynestower',
      libraries: [
        { sectionKey: '2', name: 'HNet TV', mediaType: 'show' },
        { sectionKey: '3', name: 'HNet Music', mediaType: 'artist' },
        // Registered as a movie library, but the live section says show — must not be indexed or scoped.
        { sectionKey: '4', name: 'Mislabeled', mediaType: 'movie' },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [row('Show 801', { tvdbId: 801, imdbId: 'tt801', arrItemId: 5 })],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'lidarr',
      items: [row('Artist Shared', { musicbrainzArtistId: 'artist-shared', arrItemId: 6 })],
    });
    const libs = await t.db
      .select({ id: plexLibraries.id, sectionKey: plexLibraries.sectionKey })
      .from(plexLibraries);
    const lib = (key: string) => libs.find((l) => l.sectionKey === key)!.id;
    const showLib = lib('2');
    const artistLib = lib('3');
    const mislabeled = lib('4');

    const [before] = await t.db
      .select({
        firstSeenAt: mediaPlexMatches.firstSeenAt,
        ratingKey: mediaPlexMatches.ratingKey,
        matchedVia: mediaPlexMatches.matchedVia,
      })
      .from(mediaPlexMatches)
      .innerJoin(mediaItems, eq(mediaItems.id, mediaPlexMatches.mediaItemId))
      .where(and(eq(mediaItems.arrKind, 'radarr'), eq(mediaItems.arrItemId, 1)));

    const plex = collidingBundle();
    const snap = await fetchPlexMatchSnapshot({ db: t.db, plex });
    const byItem = new Map<
      string,
      { ratingKey: string; matchedVia: string; plexLibraryId: string }[]
    >();
    for (const match of snap.matches) {
      const list = byItem.get(match.mediaItemId) ?? [];
      list.push({
        ratingKey: match.ratingKey,
        matchedVia: match.matchedVia,
        plexLibraryId: match.plexLibraryId,
      });
      byItem.set(match.mediaItemId, list);
    }
    const idOf = async (kind: 'radarr' | 'sonarr' | 'lidarr', arrItemId: number) => {
      const [item] = await t.db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(and(eq(mediaItems.arrKind, kind), eq(mediaItems.arrItemId, arrItemId)));
      return item!.id;
    };
    const movieA = await idOf('radarr', 1);
    const movieB = await idOf('radarr', 2);
    const show = await idOf('sonarr', 5);
    const artist = await idOf('lidarr', 6);

    // Movie A shares tmdb 500501 with the show, and its imdb is not the collision. Show library is refused.
    expect(byItem.get(movieA)).toEqual([
      { ratingKey: '9001', matchedVia: 'tmdb', plexLibraryId: moviesLib },
    ]);
    // Movie B's imdb tt999 is also on the show. Only the movie library matches.
    expect(byItem.get(movieB)).toEqual([
      { ratingKey: '9100', matchedVia: 'imdb', plexLibraryId: moviesLib },
    ]);
    // The show's tvdb 801 is also on the movie item. Only the show library matches, via tvdb (before imdb).
    expect(byItem.get(show)).toEqual([
      { ratingKey: '9200', matchedVia: 'tvdb', plexLibraryId: showLib },
    ]);
    // The artist's musicbrainz id is also on the movie item. Only the artist library matches.
    expect(byItem.get(artist)).toEqual([
      { ratingKey: '9300', matchedVia: 'musicbrainz', plexLibraryId: artistLib },
    ]);
    expect(snap.scopedLibraryIds.sort()).toEqual([moviesLib, showLib, artistLib].sort());
    expect(snap.scopedLibraryIds).not.toContain(mislabeled);
    expect(snap.stats.typeDisagreements).toBe(1);
    expect(snap.typeDisagreementLibraryIds).toEqual([mislabeled]);

    const report = await syncPlexMatches({
      db: t.db,
      matches: snap.matches,
      scopedLibraryIds: snap.scopedLibraryIds,
    });
    expect(report.crossTypeRemoved).toBe(0);
    const stored = await matchPairs(t.db);
    expect(stored).toEqual([
      {
        arrItemId: 6,
        arrKind: 'lidarr',
        mediaType: 'artist',
        ratingKey: '9300',
        matchedVia: 'musicbrainz',
      },
      {
        arrItemId: 1,
        arrKind: 'radarr',
        mediaType: 'movie',
        ratingKey: '9001',
        matchedVia: 'tmdb',
      },
      {
        arrItemId: 2,
        arrKind: 'radarr',
        mediaType: 'movie',
        ratingKey: '9100',
        matchedVia: 'imdb',
      },
      { arrItemId: 5, arrKind: 'sonarr', mediaType: 'show', ratingKey: '9200', matchedVia: 'tvdb' },
    ]);

    const again = await fetchPlexMatchSnapshot({ db: t.db, plex });
    await syncPlexMatches({
      db: t.db,
      matches: again.matches,
      scopedLibraryIds: again.scopedLibraryIds,
    });
    expect(await matchPairs(t.db)).toEqual(stored);
    const [after] = await t.db
      .select({
        firstSeenAt: mediaPlexMatches.firstSeenAt,
        ratingKey: mediaPlexMatches.ratingKey,
        matchedVia: mediaPlexMatches.matchedVia,
      })
      .from(mediaPlexMatches)
      .innerJoin(mediaItems, eq(mediaItems.id, mediaPlexMatches.mediaItemId))
      .where(and(eq(mediaItems.arrKind, 'radarr'), eq(mediaItems.arrItemId, 1)));
    expect(after).toEqual(before);
  });
});

describe('a library whose live type disagrees with the registry', () => {
  it('logs the skip, returns the library id, and leaves fitting rows in place', async () => {
    const before = await matchPairs(t.db);
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynestower',
      libraries: [{ sectionKey: '8', name: 'Stale type', mediaType: 'show' }],
    });
    const [lib] = await t.db
      .select({ id: plexLibraries.id })
      .from(plexLibraries)
      .where(
        and(
          eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynestower),
          eq(plexLibraries.sectionKey, '8'),
        ),
      );
    const errors: string[] = [];
    const logger: SyncLogger = {
      info: () => {},
      warn: () => {},
      error: (message) => {
        errors.push(message);
      },
    };
    const plex = {
      read: {
        haynestower: {
          machineIdentifier: 'mach-tower',
          async listSections() {
            return [{ key: '8', title: 'Stale type', type: 'movie' }];
          },
          async listSectionContentsPage() {
            return { items: [], totalSize: 0 };
          },
        },
      },
    } as unknown as Pick<PlexClientBundle, 'read'>;
    const snap = await fetchPlexMatchSnapshot({ db: t.db, plex, logger });
    expect(snap.stats.typeDisagreements).toBe(1);
    expect(snap.typeDisagreementLibraryIds).toEqual([lib!.id]);
    expect(snap.scopedLibraryIds).not.toContain(lib!.id);
    expect(errors).toEqual([
      'plex-match: section type disagrees with the registry (skipped, not scoped)',
    ]);
    const report = await syncPlexMatches({
      db: t.db,
      matches: snap.matches,
      scopedLibraryIds: snap.scopedLibraryIds,
      excludeCrossTypeLibraryIds: snap.typeDisagreementLibraryIds,
    });
    expect(report.crossTypeRemoved).toBe(0);
    expect(await matchPairs(t.db)).toEqual(before);
  });
});

describe('household plays are joined by kind and id', () => {
  it('does not give a movie the play of a show sharing its TMDB number', () => {
    const played: TitleWatch = {
      arrKind: 'sonarr',
      instanceSlug: 'haynestower',
      guids: { tmdbId: 500501 },
      playCount: 7,
      lastViewedAt: new Date('2026-09-28T00:00:00.000Z'),
      perUser: new Map(),
    };
    const index: WatchIndex = {
      byTmdb: new Map([[500501, new Set([played])]]),
      byImdb: new Map(),
      byTvdb: new Map(),
    };
    const movie = lookupHouseholdWatch(index, {
      arrKind: 'radarr',
      tmdbId: 500501,
      imdbId: null,
      tvdbId: null,
    });
    const show = lookupHouseholdWatch(index, {
      arrKind: 'sonarr',
      tmdbId: 500501,
      imdbId: null,
      tvdbId: 801,
    });
    expect(movie).toBeNull();
    expect(show?.household.playCount).toBe(7);
    expect(show?.household.lastViewedAt?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('parseCrossTypeRepairArgs', () => {
  it('requires exactly one of --dry-run or --apply', () => {
    expect(parseCrossTypeRepairArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(parseCrossTypeRepairArgs(['--apply'])).toEqual({ dryRun: false });
    expect(parseCrossTypeRepairArgs(['--help'])).toBe('help');
    expect(() => parseCrossTypeRepairArgs([])).toThrow(/exactly one/);
    expect(() => parseCrossTypeRepairArgs(['--dry-run', '--apply'])).toThrow(/exactly one/);
    expect(() => parseCrossTypeRepairArgs(['--dry-run', '--extra'])).toThrow(/exactly one/);
  });

  it('prints title, year, kind and library for each selected row', () => {
    const text = formatCrossTypeRepairReport({
      dryRun: true,
      selected: 1,
      removed: 0,
      groups: [],
      titles: [
        {
          title: 'A Simple Plan',
          year: 1998,
          arrKind: 'radarr',
          serverSlug: 'haynesops',
          libraryName: 'HOps TV Shows',
        },
      ],
    });
    expect(text.split('\n')[0]).toBe('A Simple Plan\t1998\tradarr\thaynesops/HOps TV Shows');
    expect(text).toContain('"selected":1');
    expect(text).toContain('"dryRun":true');
  });
});

/** Movie and show (and artist) items that share id numbers, plus a section whose type disagrees. */
function collidingBundle(): Pick<PlexClientBundle, 'read'> {
  const movies = [
    {
      ratingKey: '9001',
      type: 'movie',
      title: 'Movie A',
      addedAt: 1_780_000_000,
      Guid: [{ id: 'tmdb://500501' }],
    },
    {
      ratingKey: '9100',
      type: 'movie',
      title: 'Collision movie',
      Guid: [{ id: 'imdb://tt999' }, { id: 'tvdb://801' }, { id: 'mbid://artist-shared' }],
    },
  ] as unknown as PlexSectionItem[];
  const shows = [
    {
      ratingKey: '9200',
      type: 'show',
      title: 'Collision show',
      addedAt: 1_700_000_000,
      Guid: [{ id: 'tmdb://500501' }, { id: 'tvdb://801' }, { id: 'imdb://tt999' }],
    },
  ] as unknown as PlexSectionItem[];
  const artists = [
    {
      ratingKey: '9300',
      type: 'artist',
      title: 'Collision artist',
      Guid: [{ id: 'mbid://artist-shared' }],
    },
  ] as unknown as PlexSectionItem[];
  const mislabeled = [
    { ratingKey: '9400', type: 'show', title: 'Wrong section', Guid: [{ id: 'tmdb://500501' }] },
  ] as unknown as PlexSectionItem[];
  return {
    read: {
      haynestower: {
        machineIdentifier: 'mach-tower',
        async listSections() {
          return [
            { key: '1', title: 'HNet Movies', type: 'movie' },
            { key: '2', title: 'HNet TV', type: 'show' },
            { key: '3', title: 'HNet Music', type: 'artist' },
            { key: '4', title: 'Mislabeled', type: 'show' },
          ];
        },
        async listSectionContentsPage(
          sectionKey: string,
          { start }: { start: number; size: number },
        ) {
          if (start !== 0) return { items: [], totalSize: 0 };
          if (sectionKey === '1') return { items: movies, totalSize: movies.length };
          if (sectionKey === '2') return { items: shows, totalSize: shows.length };
          if (sectionKey === '3') return { items: artists, totalSize: artists.length };
          if (sectionKey === '4') return { items: mislabeled, totalSize: mislabeled.length };
          return { items: [], totalSize: 0 };
        },
      } as unknown as PlexReadClient,
    } as unknown as Record<PlexServerSlug, PlexReadClient>,
  };
}

async function matchPairs(database: Database) {
  const rows = await database
    .select({
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      mediaType: plexLibraries.mediaType,
      ratingKey: mediaPlexMatches.ratingKey,
      matchedVia: mediaPlexMatches.matchedVia,
    })
    .from(mediaPlexMatches)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaPlexMatches.mediaItemId))
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId));
  return rows.sort((a, b) => a.arrKind.localeCompare(b.arrKind) || a.arrItemId - b.arrItemId);
}

async function countMatches(database: Database): Promise<number> {
  return (await database.select({ id: mediaPlexMatches.id }).from(mediaPlexMatches)).length;
}
