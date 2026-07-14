// fix/live-status-precedence — the hermetic STALE-SNAPSHOT seed: force the synced Scott Pilgrim COMIC request's
// comic_status to 'missing' (reproducing the drift the owner reported — the hourly goodreads-sync reconcile
// lagging behind a fresh Kapowarr grab) and print its kapowarr_volume_id so the e2e can stage a matching LIVE
// download. It goes through the D-12 single writer (`markComicRouted`, the sync's own comic-status setter),
// never a raw table write — it merely stamps the state the reconcile would eventually hold. Existing only to
// manufacture the snapshot-vs-live disagreement the fix resolves.
//
//   DATABASE_URL=… tsx e2e/support/seed-comic-missing.ts
import { getWantedBookRequests, markComicRouted } from '@hnet/domain';

async function main(): Promise<void> {
  const comics = await getWantedBookRequests({ format: 'comic' });
  const sp = comics.find((c) => /scott pilgrim/i.test(c.title) && c.kapowarrVolumeId != null);
  if (!sp || sp.kapowarrVolumeId == null) {
    throw new Error('seed-comic-missing: no routed Scott Pilgrim comic request found (run goodreads-sync first)');
  }
  await markComicRouted({
    requestId: sp.requestId,
    kapowarrVolumeId: sp.kapowarrVolumeId,
    comicvineId: null,
    comicStatus: 'missing',
  });
  // The e2e parses this line to stage a live Kapowarr download for the same volume.
  process.stdout.write(`KAPOWARR_VOLUME_ID=${sp.kapowarrVolumeId}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[seed-comic-missing] failed:', err);
    process.exit(1);
  });
