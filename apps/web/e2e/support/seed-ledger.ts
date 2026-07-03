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
import { getPool } from '@hnet/db';
import { ingestLedgerEvents, upsertMediaItemsBatch } from '@hnet/domain';

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
    ],
  });

  // A little history so the detail timeline has something to show (R-41).
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM media_items WHERE arr_kind = 'sonarr' AND arr_item_id = 501`,
  );
  const mediaItemId = rows[0]?.id;
  if (!mediaItemId) throw new Error('seed-ledger: sonarr row not found after upsert');
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

  await getPool().end();
  console.log('[seed-ledger] seeded 2 media items + 2 ledger events');
}

main().catch((err: unknown) => {
  console.error('[seed-ledger] failed:', err);
  process.exit(1);
});
