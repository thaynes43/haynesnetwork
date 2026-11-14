// Integration fixtures stay inside the domain's guarded write boundary.
import { eq } from 'drizzle-orm';
import {
  ledgerEvents,
  trashDeletedReleases,
  trashBatches,
  trashBatchItems,
  type DbClient,
  type TrashDeletedReleaseInsert,
} from '@hnet/db';
import { resolveDb } from '../src/db-client';

export async function seedTrashRelease(db: DbClient, record: TrashDeletedReleaseInsert) {
  await resolveDb(db).insert(trashDeletedReleases).values(record);
}
export async function unlinkExpiredTrashRelease(db: DbClient, mediaItemId: string) {
  await resolveDb(db)
    .update(trashDeletedReleases)
    .set({ mediaItemId: null, state: 'expired' })
    .where(eq(trashDeletedReleases.mediaItemId, mediaItemId));
}
export async function seedTrashDeletion(db: DbClient, mediaItemId: string) {
  await resolveDb(db)
    .insert(ledgerEvents)
    .values({
      mediaItemId,
      eventType: 'trash_expedited',
      source: 'maintainerr',
      occurredAt: new Date(),
      payload: {},
    });
}

export async function seedTrashBatchDeletion(db: DbClient, mediaItemId: string, title: string, tmdbId?: number) {
  const [batch] = await resolveDb(db)
    .insert(trashBatches)
    .values({ mediaKind: 'movie', state: 'deleted' })
    .returning();
  await resolveDb(db)
    .insert(trashBatchItems)
    .values({
      batchId: batch!.id,
      mediaItemId: tmdbId ? null : mediaItemId,
      tmdbId,
      maintainerrMediaId: mediaItemId,
      title,
      state: 'deleted',
    });
}
