// e2e ledger seed — run as a tsx SUBPROCESS by the stack harness (the Playwright
// CJS transform can't load the @hnet/domain → @hnet/db ESM chain in-process; same
// reason migrations run as a subprocess). Seeds the media_items rows the /library
// specs browse, THROUGH the D-12 single writers — never direct table writes (the
// no-direct-writes guard scans this file too).
//
//   DATABASE_URL=… tsx e2e/support/seed-ledger.ts
//
// The Sonarr row mirrors what the stub *arr serves (stub-arr.ts): series 501
// "Breaking Prod", 9/10 episodes on disk, profile HD-1080p.
import { getPool, SEEDED_ROLE_IDS } from '@hnet/db';
import {
  ingestLedgerEvents,
  setRoleLibraries,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
} from '@hnet/domain';

async function main(): Promise<void> {
  await upsertMediaItemsBatch({
    arrKind: 'sonarr',
    items: [
      {
        arrItemId: 501,
        tvdbId: 990001,
        title: 'Breaking Prod',
        sortTitle: 'breaking prod',
        year: 2019,
        monitored: true,
        qualityProfileId: 7,
        qualityProfileName: 'HD-1080p',
        rootFolder: '/data/haynestower/Media/TV Shows',
        arrTags: ['mediarequests'],
        onDiskFileCount: 9,
        expectedFileCount: 10,
        sizeOnDisk: 21_474_836_480,
        arrAttrs: { seriesType: 'standard', seasonFolder: true, monitorNewItems: 'all' },
      },
    ],
  });
  await upsertMediaItemsBatch({
    arrKind: 'radarr',
    items: [
      {
        arrItemId: 601,
        tmdbId: 880001,
        title: 'The Fixture',
        sortTitle: 'fixture',
        year: 2022,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/data/haynestower/Media/Movies',
        onDiskFileCount: 1,
        expectedFileCount: 1,
        sizeOnDisk: 4_294_967_296,
      },
      // A SECOND movie with disjoint metadata (genres/rating/requester) so the D-11 grid
      // journeys can prove a filter/sort actually CHANGES the result set (library-grid.spec).
      {
        arrItemId: 602,
        tmdbId: 880002,
        title: 'Stub Runner',
        sortTitle: 'stub runner',
        year: 2020,
        monitored: true,
        qualityProfileId: 7,
        qualityProfileName: 'HD-1080p',
        rootFolder: '/data/haynestower/Media/Movies',
        onDiskFileCount: 1,
        expectedFileCount: 1,
        sizeOnDisk: 8_589_934_592,
      },
    ],
  });
  // A Music (Lidarr) artist with an on-disk album so the detail offers Fix — used to assert
  // the Fix dialog offers NO 'Missing subtitles' radio for Music (ADR-016 / D-19). Mirrors
  // the stub-arr `/album?artistId=701` handler.
  await upsertMediaItemsBatch({
    arrKind: 'lidarr',
    items: [
      {
        arrItemId: 701,
        musicbrainzArtistId: '11111111-2222-3333-4444-555555550701',
        title: 'The Stub Band',
        sortTitle: 'stub band',
        year: null,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Standard',
        metadataProfileId: 1,
        metadataProfileName: 'Standard',
        rootFolder: '/data/media/music',
        onDiskFileCount: 10,
        expectedFileCount: 10,
        sizeOnDisk: 1_073_741_824,
        arrAttrs: { artistType: 'Group', monitorNewItems: 'all' },
      },
    ],
  });

  // A little history so the detail timeline has something to show (R-41).
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM media_items WHERE arr_kind = 'sonarr' AND arr_item_id = 501`,
  );
  const mediaItemId = rows[0]?.id;
  if (!mediaItemId) throw new Error('seed-ledger: sonarr row not found after upsert');

  // ADR-018 / DESIGN-008 D-14 — seed media_metadata through the single writer so the poster
  // route (posterSource='arr' → stub-arr MediaCover) and the metadata blocks are exercisable
  // hermetically. Ratings/genres/resolution/requesters mirror what the stub *arr would harvest.
  const { rows: radarrRows } = await getPool().query<{ id: string }>(
    `SELECT id FROM media_items WHERE arr_kind = 'radarr' AND arr_item_id = 601`,
  );
  const radarrItemId = radarrRows[0]?.id;
  const { rows: runnerRows } = await getPool().query<{ id: string }>(
    `SELECT id FROM media_items WHERE arr_kind = 'radarr' AND arr_item_id = 602`,
  );
  const runnerItemId = runnerRows[0]?.id;
  await upsertMediaMetadataBatch({
    rows: [
      {
        mediaItemId,
        tmdbRating: 8.2,
        tmdbVotes: 4321,
        runtimeMinutes: 44,
        resolution: '1080p',
        genres: ['Drama', 'Crime'],
        requesters: ['manofoz'],
        sourceCollections: ['emmycollection'],
        posterSource: 'arr',
        posterRef: '/MediaCover/501/poster.jpg?lastWrite=1',
        playCount: 3,
        sources: { arr: true, tautulli: true },
        extra: { tautulli: { haynestower: { playCount: 3, lastViewedAt: null } } },
      },
      ...(radarrItemId
        ? [
            {
              mediaItemId: radarrItemId,
              imdbRating: 7.7,
              imdbVotes: 12345,
              tmdbRating: 7.9,
              rtTomatometer: 88,
              runtimeMinutes: 106,
              resolution: 'sd' as const, // 'Any' profile → 'unknown' normally; pin a value the facet can show
              genres: ['Comedy', 'Drama'],
              requesters: ['manofoz'],
              posterSource: 'arr' as const,
              posterRef: '/MediaCover/601/poster.jpg?lastWrite=1',
              sources: { arr: true },
            },
          ]
        : []),
      // Disjoint from The Fixture on every facet (genre/requester/resolution) and LOWER-rated,
      // so Genre=Action keeps only this row and a rating sort flips the order (D-11 e2e).
      ...(runnerItemId
        ? [
            {
              mediaItemId: runnerItemId,
              imdbRating: 6.4,
              imdbVotes: 4321,
              tmdbRating: 6.8,
              runtimeMinutes: 118,
              resolution: '1080p' as const,
              genres: ['Action', 'Thriller'],
              requesters: ['helmu15'],
              sourceCollections: ['traktrecommended'],
              posterSource: 'arr' as const,
              posterRef: '/MediaCover/602/poster.jpg?lastWrite=1',
              sources: { arr: true },
            },
          ]
        : []),
    ],
  });
  await ingestLedgerEvents({
    source: 'sonarr',
    events: [
      {
        mediaItemId,
        eventType: 'grabbed',
        source: 'sonarr',
        sourceEventId: 'e2e:grab:1',
        occurredAt: new Date('2026-06-30T21:00:00Z'),
        payload: {
          rawEventType: 'grabbed',
          sourceTitle: 'Breaking.Prod.S01E02.MULTi.1080p.WEB-DL',
          episodeId: 50102,
        },
      },
      {
        mediaItemId,
        eventType: 'imported',
        source: 'sonarr',
        sourceEventId: 'e2e:import:1',
        occurredAt: new Date('2026-06-30T22:00:00Z'),
        payload: {
          rawEventType: 'downloadFolderImported',
          sourceTitle: 'Breaking.Prod.S01E02.MULTi.1080p.WEB-DL',
          episodeId: 50102,
        },
      },
    ],
  });

  // ADR-017 / DESIGN-007 — the Plex registry + role grants the /library/plex specs use. The
  // seed runs BEFORE the stub Plex is up, so it can't refresh; upsertPlexLibraries seeds the
  // same libraries stub-plex.ts serves (so a later admin refresh is idempotent). Default gets
  // the non-family set; Family additionally gets HNet Photos.
  await upsertPlexLibraries({
    slug: 'haynestower',
    libraries: [
      { sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' },
      { sectionKey: '4', name: 'HNet Photos', mediaType: 'photo' },
    ],
  });
  await upsertPlexLibraries({
    slug: 'haynesops',
    libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
  });
  await upsertPlexLibraries({
    slug: 'hayneskube',
    libraries: [{ sectionKey: '2', name: 'HOps Music', mediaType: 'artist' }],
  });

  const { rows: libRows } = await getPool().query<{ id: string; slug: string; key: string }>(
    `SELECT l.id, s.slug, l.section_key AS key
       FROM plex_libraries l JOIN plex_servers s ON s.id = l.server_id`,
  );
  const libId = (slug: string, key: string) =>
    libRows.find((r) => r.slug === slug && r.key === key)!.id;
  const nonFamily = [libId('haynestower', '1'), libId('haynesops', '1')];
  await setRoleLibraries({ roleId: SEEDED_ROLE_IDS.default, libraryIds: nonFamily, actorId: null });
  const { rows: familyRows } = await getPool().query<{ id: string }>(
    `SELECT id FROM roles WHERE name = 'Family'`,
  );
  if (familyRows[0]) {
    await setRoleLibraries({
      roleId: familyRows[0].id,
      libraryIds: [...nonFamily, libId('haynestower', '4')],
      actorId: null,
    });
  }

  await getPool().end();
  console.log('[seed-ledger] seeded 4 media items + 2 ledger events + Plex libraries/grants');
}

main().catch((err: unknown) => {
  console.error('[seed-ledger] failed:', err);
  process.exit(1);
});
