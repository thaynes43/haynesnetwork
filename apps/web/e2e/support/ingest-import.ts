// e2e milestone helper (ADR-028 / PLAN-015) — land the `imported` ledger milestone the
// sync cron would ingest in production, then run the real `completeFixRequests` matcher
// so open fixes flip to their durable terminal. Lets the action-feedback spec walk a
// fix through queued → downloading → importing → COMPLETED without a cron, and leaves
// no forever-open rows behind for later specs. Run as a tsx SUBPROCESS from the spec
// (same CJS-transform reason as seed-ledger.ts):
//
//   DATABASE_URL=… tsx e2e/support/ingest-import.ts <mediaItemId> <sonarr|radarr|lidarr> [childId]
//
// Deliberately goes THROUGH the @hnet/domain single-writers (ingestLedgerEvents +
// completeFixRequests) — never a direct table write (the no-direct-state-writes guard
// scans this file too).
import { getPool } from '@hnet/db';
import { completeFixRequests, ingestLedgerEvents } from '@hnet/domain';

async function main(): Promise<void> {
  const mediaItemId = process.argv[2];
  const source = process.argv[3];
  const childId = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
  if (!mediaItemId || (source !== 'sonarr' && source !== 'radarr' && source !== 'lidarr')) {
    throw new Error(
      `usage: tsx ingest-import.ts <mediaItemId> <sonarr|radarr|lidarr> [childId]  (got '${mediaItemId}' '${source}')`,
    );
  }
  if (childId !== undefined && !Number.isInteger(childId)) {
    throw new Error(`childId must be an integer (got '${process.argv[4]}')`);
  }

  const now = new Date();
  const childPayload =
    childId === undefined
      ? {}
      : source === 'lidarr'
        ? { albumId: childId }
        : { episodeId: childId };
  await ingestLedgerEvents({
    source,
    events: [
      {
        mediaItemId,
        eventType: 'imported',
        source,
        sourceEventId: `e2e:feedback-import:${now.getTime()}`,
        occurredAt: now,
        payload: {
          rawEventType: 'downloadFolderImported',
          sourceTitle: 'E2E.Replacement.1080p.WEB-DL',
          ...childPayload,
        },
      },
    ],
  });
  const { completed } = await completeFixRequests();
  console.log(
    `[ingest-import] imported milestone landed for ${mediaItemId} (${source}${
      childId !== undefined ? `, child ${childId}` : ''
    }); ${completed.length} fix(es) completed`,
  );
  await getPool().end();
}

main().catch((err: unknown) => {
  console.error('[ingest-import] failed:', err);
  process.exit(1);
});
