// Domain-owned fixtures for authenticated API boundary tests. Not exported by the package or used by app code.
// Routine request setup uses real writers; valid carry and corrupt-overlap fixtures require an injected test DB.
import type { Database } from '@hnet/db';
import { repairRequests, watchCarries } from '@hnet/db/schema';

function assertTestRuntime() {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Synthetic owned-import fixtures require the test runtime');
}

export async function seedVerifiedOwnedCarryForTest(input: {
  testDb: Database;
  mediaItemId: string;
  seriesId: number;
  fixRequestId: string;
  title: string;
  episodeIds: number[];
  originalFile: { id: number; name: string; size: number };
}) {
  assertTestRuntime();
  await input.testDb.insert(watchCarries).values({
    kind: 'wrong_content',
    mediaItemId: input.mediaItemId,
    seriesId: input.seriesId,
    status: 'verified',
    takenAt: new Date(),
    scope: {
      moved: [],
      deleted: [input.originalFile.size],
      deletedNames: [input.originalFile.name],
      pendingDeletes: [],
    },
    detail: {
      fixRequestId: input.fixRequestId,
      releases: [input.title],
      wrongContentDeletion: {
        version: 1,
        grabStarted: true,
        files: [{ ...input.originalFile, episodeIds: input.episodeIds, sameAs: [] }],
        scope: {
          moved: [],
          pendingDeletes: [{ name: input.originalFile.name, size: input.originalFile.size }],
        },
      },
    },
  });
}

export async function seedOverlappingOwnedRemapForTest(input: {
  testDb: Database;
  mediaItemId: string;
  requesterId: string;
  seasonNumber: number;
  episodeIds: number[];
}) {
  assertTestRuntime();
  // Existing overlapping requests cannot be created through the normal one-open-grain guard.
  await input.testDb.insert(repairRequests).values({
    mediaItemId: input.mediaItemId,
    requesterId: input.requesterId,
    kind: 'remap',
    scope: 'season',
    seasonNumber: input.seasonNumber,
    targetChildIds: input.episodeIds,
    status: 'pending',
  });
}
