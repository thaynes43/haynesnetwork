import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ledgerEvents,
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashRestoreKeeps,
} from '@hnet/db/schema';
import {
  classifyGuardian,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  expediteDeletion,
  removeRestoreKeep,
  setAppSetting,
  silentDomainLogger,
  startRestoreRun,
  sweepExpiredBatches,
  upsertMediaItemsBatch,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection } from './maintainerr-stub';
import {
  bootMigratedDb,
  createUser,
  seedVerifiedWatchlistRegistry,
  stampOldPlexMatches,
  type TestDb,
} from './helpers';

/** PG16: the keep is the app's restore record, not a copied *arr tag or an age. */
describe('ADR-121 Restore Keep at every guardian decision', () => {
  let t: TestDb;
  let actor: string;
  let id: string;
  beforeAll(async () => {
    t = await bootMigratedDb();
    actor = (await createUser(t.db)).id;
    const result = await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 1,
          tmdbId: 9201,
          title: 'Restored One',
          sortTitle: 'restored one',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
          arrTags: [],
        },
      ],
    });
    expect(result).toBeDefined();
    id = (await t.db.select().from(mediaItems))[0]!.id;
    await stampOldPlexMatches(t.db);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: actor });
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashBatches);
    await t.db.delete(trashRestoreKeeps);
    await seedVerifiedWatchlistRegistry(t.db);
  });
  const pool = () =>
    baseState({
      collections: [
        movieCollection({
          items: [
            {
              mediaServerId: 'ms-9201',
              tmdbId: 9201,
              sizeBytes: 1000000000,
              addDate: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      ],
    });
  const keep = () =>
    startRestoreRun({
      db: t.db,
      arrKind: 'radarr',
      initiatedBy: actor,
      preview: [{ mediaItemId: id, title: 'Restored One' }],
      trashRestore: true,
    });

  it('leaves restored titles out of targeted and untargeted batches', async () => {
    await keep();
    for (const targeting of [undefined, { maxItems: 1 }]) {
      await expect(
        createBatchFromPending({
          db: t.db,
          maintainerr: makeMaintainerr(pool()).bundle,
          mediaKind: 'movie',
          actorId: actor,
          targeting,
        }),
      ).rejects.toThrow();
    }
  });
  it.each([false, true])(
    'a keep acquired after batch creation survives the sweep (Expire now=%s)',
    async (force) => {
      const state = pool();
      const { bundle } = makeMaintainerr(state);
      const { batchId } = await createBatchFromPending({
        db: t.db,
        maintainerr: bundle,
        mediaKind: 'movie',
        actorId: actor,
      });
      await keep();
      if (!force)
        await t.db
          .update(trashBatches)
          .set({ expiresAt: new Date(Date.now() - 60000) })
          .where(eq(trashBatches.id, batchId));
      const { arr } = createStaticReleaseBlockArr();
      await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'gate-only',
        logger: silentDomainLogger,
        ...(force ? { batchId, forceOverride: true, actorId: actor } : {}),
      });
      expect(
        (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId)))[0],
      ).toMatchObject({ state: 'skipped', keepReason: 'admin_restored' });
      expect(
        (await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, id))).filter(
          (e) => e.eventType === 'trash_expedited',
        ),
      ).toHaveLength(0);
    },
  );
  it('both Expedite scopes keep it without writing a Save, and admin removal preserves other keeps', async () => {
    await keep();
    const state = pool();
    const { bundle } = makeMaintainerr(state);
    const { arr } = createStaticReleaseBlockArr();
    for (const scope of ['item', 'all'] as const) {
      const result = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope,
        media: 'movie',
        actorId: actor,
        item: { collectionId: 7, maintainerrMediaId: 'ms-9201' },
        snapshotMediaIds: ['ms-9201'],
        logger: silentDomainLogger,
      });
      expect(result).toMatchObject({ protectedCount: 1, expeditedCount: 0 });
    }
    expect(state.exclusions.size).toBe(0);
    expect(await removeRestoreKeep({ db: t.db, mediaItemId: id, actorId: actor })).toEqual({
      removed: true,
    });
    expect(
      classifyGuardian({
        mediaItemId: id,
        protectedByTag: false,
        recentlyWatched: false,
        onWatchlist: false,
        watchlistEvaluable: true,
        ruleEvaluationFailed: false,
        ageGuard: 'clear',
        saveIntent: false,
        restoreKeep: false,
        arrTags: ['mediarequests'],
      }),
    ).toEqual({ keep: true, reason: 'media_request' });
    expect(
      (await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, id))).some(
        (e) => e.payload.action === 'remove_restore_keep',
      ),
    ).toBe(true);
  });
});
