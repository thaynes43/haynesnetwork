// PLAN-045 owner-correction — a CAPTURE-ONLY seed: one monitored, fileless (0/1 on disk) Radarr movie
// so the Movies wall shows a "Wanted" card for the anatomy side-by-side proof. It runs as a tsx
// SUBPROCESS from the capture harness AFTER startStack (like the goodreads-sync), through the D-12
// single writer — never a direct table write. It is deliberately NOT in the shared seed-ledger.ts:
// that file's exact movie-count assertions (library-grid.spec) must stay green, so the Wanted movie
// lives only in the hermetic capture DB.
//
//   DATABASE_URL=… tsx e2e/support/seed-wanted-movie.ts
import { upsertMediaItemsBatch } from '@hnet/domain';

async function main(): Promise<void> {
  await upsertMediaItemsBatch({
    arrKind: 'radarr',
    items: [
      {
        arrItemId: 603,
        tmdbId: 880003,
        title: 'Wanted Signal',
        sortTitle: 'wanted signal',
        year: 2026,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/data/haynestower/Media/Movies',
        // Monitored + zero files + NOT tombstoned ⇒ the Movies wall's "Wanted" state (the reference card).
        onDiskFileCount: 0,
        expectedFileCount: 1,
        sizeOnDisk: 0,
      },
    ],
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[seed-wanted-movie] failed:', err);
    process.exit(1);
  });
