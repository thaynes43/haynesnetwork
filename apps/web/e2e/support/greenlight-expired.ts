// e2e time-travel helper — green-light the OPEN admin_review batch for a media kind with an
// ALREADY-EXPIRED window (windowDays defaults to -1), so the "Expire now" journey can exercise
// the real sweep without waiting a day. Run as a tsx SUBPROCESS from the spec (same CJS-transform
// reason as seed-ledger.ts), with the stack's runtime env:
//
//   DATABASE_URL=… MAINTAINERR_URL=… MAINTAINERR_API_KEY=… tsx e2e/support/greenlight-expired.ts movie
//
// Deliberately goes THROUGH the @hnet/domain single-writer (greenlightBatch drives the real
// Leaving-Soon collection + transition event) — never a direct table write (the
// no-direct-state-writes guard scans this file too). The domain layer accepts any windowDays;
// only the tRPC surface clamps it to 1..365 — exactly how the domain's own sweep tests
// manufacture expired windows.
import { getPool } from '@hnet/db';
import { greenlightBatch, listBatches, maintainerrClientBundleFromEnv } from '@hnet/domain';

async function main(): Promise<void> {
  const kind = process.argv[2];
  if (kind !== 'movie' && kind !== 'tv') {
    throw new Error(`usage: tsx greenlight-expired.ts <movie|tv> [windowDays]  (got '${kind}')`);
  }
  const windowDays = process.argv[3] !== undefined ? Number(process.argv[3]) : -1;
  if (!Number.isInteger(windowDays)) throw new Error(`windowDays must be an integer`);

  const batches = await listBatches({ mediaKind: kind });
  const reviewing = batches.find((b) => b.state === 'admin_review');
  if (!reviewing) {
    throw new Error(`no admin_review ${kind} batch to green-light (states: ${batches.map((b) => b.state).join(', ') || 'none'})`);
  }

  const res = await greenlightBatch({
    maintainerr: maintainerrClientBundleFromEnv(),
    batchId: reviewing.id,
    windowDays,
    actorId: null,
  });
  console.log(
    `[greenlight-expired] batch ${reviewing.id} (${kind}) → leaving_soon, window ${windowDays}d, expires ${res.expiresAt}`,
  );
  await getPool().end();
}

main().catch((err: unknown) => {
  console.error('[greenlight-expired] failed:', err);
  process.exit(1);
});
