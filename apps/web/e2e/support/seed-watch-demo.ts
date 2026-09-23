// PLAN-068 S8 — the `pnpm dev:local` Watch Companion demo seed (NOT part of the e2e seed: the e2e walls stay
// exactly as they were). Gives Stub Severance — on the stub owner's plex.tv watchlist and on stub HaynesTower
// (section 2, ratingKey 506), never watched — a Sonarr ledger row with its genres and its Plex match, so the
// local `recommend` has an on-Plex pick and `mark_watched` a real (stub) target. Run as a tsx SUBPROCESS
// (the seed-ledger.ts pattern), THROUGH the domain single writers — never a direct table write.
//
//   DATABASE_URL=… tsx e2e/support/seed-watch-demo.ts
import { getPool, SEEDED_PLEX_SERVER_IDS } from '@hnet/db';
import { syncPlexMatches, upsertMediaItemsBatch, upsertMediaMetadataBatch } from '@hnet/domain';

async function main(): Promise<void> {
  await upsertMediaItemsBatch({
    arrKind: 'sonarr',
    items: [
      {
        arrItemId: 506,
        tvdbId: 990020,
        tmdbId: 95396,
        imdbId: 'tt9900020',
        title: 'Stub Severance',
        sortTitle: 'stub severance',
        year: 2022,
        monitored: true,
        qualityProfileId: 7,
        qualityProfileName: 'HD-1080p',
        rootFolder: '/data/haynestower/Media/TV Shows',
        onDiskFileCount: 3,
        expectedFileCount: 3,
        sizeOnDisk: 6_442_450_944,
        arrAttrs: { seriesType: 'standard', seasonFolder: true, status: 'continuing', ended: false },
      },
    ],
  });
  const pool = getPool();
  const { rows: items } = await pool.query<{ id: string }>(
    `SELECT id FROM media_items WHERE arr_kind = 'sonarr' AND arr_item_id = 506`,
  );
  const { rows: libs } = await pool.query<{ id: string }>(
    `SELECT id FROM plex_libraries WHERE server_id = $1 AND section_key = '2'`,
    [SEEDED_PLEX_SERVER_IDS.haynestower],
  );
  const item = items[0];
  const lib = libs[0];
  if (!item || !lib) throw new Error('seed-watch-demo: the ledger seed must run first (no item or library)');
  await upsertMediaMetadataBatch({
    rows: [{ mediaItemId: item.id, genres: ['Drama', 'Mystery', 'Science Fiction'], imdbRating: 8.7 }],
  });
  await syncPlexMatches({
    matches: [{ mediaItemId: item.id, plexLibraryId: lib.id, ratingKey: '506', matchedVia: 'tvdb' }],
    scopedLibraryIds: [],
  });
  console.log('[seed-watch-demo] Stub Severance: ledger row, genres and Plex match written');
}

main()
  .then(async () => {
    await getPool().end();
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[seed-watch-demo] failed:', error);
    process.exit(1);
  });
