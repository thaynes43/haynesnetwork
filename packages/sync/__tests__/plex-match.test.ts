// ADR-047 / DESIGN-025 (PLAN-028) — the *arr→Plex match sweep: GUID parsing + the fetch/resolve that
// produces the match set (and its match rate) + the reconcile (a title dropping out of a fully-read
// library is removed). Proven against an embedded PG16 with a fake Plex read bundle (no live Plex).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mediaItems, mediaPlexMatches, plexLibraries, SEEDED_PLEX_SERVER_IDS } from '@hnet/db';
import type { Database, PlexServerSlug } from '@hnet/db';
import { syncPlexMatches, upsertMediaItemsBatch, upsertPlexLibraries, type PlexClientBundle } from '@hnet/domain';
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexSectionItem } from '@hnet/plex';
import { fetchPlexMatchSnapshot, parsePlexGuids } from '../src/plex-match';
import { bootMigratedDb, type TestDb } from './helpers';

describe('parsePlexGuids', () => {
  it('parses tmdb/imdb/tvdb/mbid from the Guid array + legacy agent prefixes', () => {
    expect(
      parsePlexGuids({
        Guid: [{ id: 'tmdb://12345' }, { id: 'imdb://tt0111161' }, { id: 'tvdb://78901' }],
      }),
    ).toEqual({ tmdb: '12345', imdb: 'tt0111161', tvdb: '78901' });
    expect(parsePlexGuids({ Guid: [{ id: 'mbid://abc-def' }] })).toEqual({ musicbrainz: 'abc-def' });
    expect(
      parsePlexGuids({ Guid: [{ id: 'com.plexapp.agents.imdb://tt42?lang=en' }] }),
    ).toEqual({ imdb: 'tt42' });
    // The scalar plex:// guid is ignored for matching (no known scheme).
    expect(parsePlexGuids({ guid: 'plex://movie/5d776b', Guid: [] })).toEqual({});
  });
});

/** A fake PlexReadClient serving one Movies section (with GUIDs), one Photos section (skipped by type),
 *  and one unmapped 4K section absent from the registry. */
function fakeRead(): PlexReadClient {
  const movies: PlexSectionItem[] = [
    { ratingKey: '9001', type: 'movie', title: 'Movie A', Guid: [{ id: 'tmdb://500501' }] },
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
  });

  it('reconcile removes a match whose title dropped out of a fully-read library', async () => {
    // Re-run with only Movie A still present (Movie B vanished from Plex).
    const [movieA] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, 'radarr'), eq(mediaItems.arrItemId, 1)));
    await syncPlexMatches({
      db: t.db,
      matches: [{ mediaItemId: movieA!.id, plexLibraryId: moviesLib, ratingKey: '9001', matchedVia: 'tmdb' }],
      scopedLibraryIds: [moviesLib],
    });
    expect(await countMatches(t.db)).toBe(1); // Movie B's stale match reconciled away
  });
});

async function countMatches(database: Database): Promise<number> {
  return (await database.select({ id: mediaPlexMatches.id }).from(mediaPlexMatches)).length;
}
