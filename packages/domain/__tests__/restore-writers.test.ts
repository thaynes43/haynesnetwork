import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, mediaItems, restoreRuns, users } from '@hnet/db/schema';
import {
  NotFoundError,
  finishRestoreRun,
  recordRestoreResult,
  startRestoreRun,
  tombstoneMissingItems,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('restore_runs single-writers (DESIGN-005 D-10/D-12/D-16)', () => {
  let t: TestDb;
  let adminId: string;
  let lostIds: string[]; // tombstoned radarr items — the disaster Restore undoes

  beforeAll(async () => {
    t = await bootMigratedDb();
    adminId = (await createUser(t.db, { email: 'restore-admin@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [1, 2].map((n) => ({
        arrItemId: n,
        tmdbId: 600 + n,
        title: `Lost Movie ${n}`,
        sortTitle: `lost movie ${n}`,
        monitored: true,
        qualityProfileId: 9,
        qualityProfileName: 'FHD-UHD',
        rootFolder: '/movies',
      })),
    });
    // The wiped Radarr reports nothing; both rows tombstone (2 rows — under the guard).
    await tombstoneMissingItems({ db: t.db, arrKind: 'radarr', seenArrItemIds: [] });
    lostIds = (
      await t.db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(eq(mediaItems.arrKind, 'radarr'))
    ).map((r) => r.id);
    expect(lostIds).toHaveLength(2);
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('startRestoreRun persists the approved preview before any *arr POST (R-52)', async () => {
    const { runId } = await startRestoreRun({
      db: t.db,
      arrKind: 'radarr',
      initiatedBy: adminId,
      preview: lostIds.map((id, i) => ({
        mediaItemId: id,
        title: `Lost Movie ${i + 1}`,
        externalId: String(601 + i),
        tombstoned: true,
      })),
    });
    const [run] = await t.db.select().from(restoreRuns).where(eq(restoreRuns.id, runId));
    expect(run).toMatchObject({
      arrKind: 'radarr',
      arrInstanceId: 'main',
      initiatedBy: adminId,
      status: 'running',
      itemCount: 2,
      successCount: 0,
      results: [],
      finishedAt: null,
    });
    expect(run!.preview).toHaveLength(2);
  });

  describe('recordRestoreResult → finishRestoreRun', () => {
    let runId: string;

    beforeAll(async () => {
      ({ runId } = await startRestoreRun({
        db: t.db,
        arrKind: 'radarr',
        initiatedBy: adminId,
        preview: lostIds.map((id) => ({ mediaItemId: id, title: 'Lost Movie' })),
      }));
    });

    it('a success appends the result, bumps the count, un-tombstones, updates arr_item_id, and writes restored', async () => {
      const restoredId = lostIds[0]!;
      const { successCount } = await recordRestoreResult({
        db: t.db,
        runId,
        result: { mediaItemId: restoredId, ok: true, newArrItemId: 5001 },
      });
      expect(successCount).toBe(1);

      const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.id, restoredId));
      expect(item!.deletedFromArrAt).toBeNull(); // tombstone cleared (D-16)
      expect(item!.arrItemId).toBe(5001); // rebuilt *arr's new internal id

      const events = await t.db
        .select()
        .from(ledgerEvents)
        .where(
          and(eq(ledgerEvents.mediaItemId, restoredId), eq(ledgerEvents.eventType, 'restored')),
        );
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ restoreRunId: runId, newArrItemId: 5001 });
    });

    it('a failure is recorded per item without touching the media row', async () => {
      const failedId = lostIds[1]!;
      const { successCount } = await recordRestoreResult({
        db: t.db,
        runId,
        result: { mediaItemId: failedId, ok: false, error: 'RESTORE_PROFILE_UNMAPPED: FHD-UHD' },
      });
      expect(successCount).toBe(1); // unchanged

      const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.id, failedId));
      expect(item!.deletedFromArrAt).not.toBeNull(); // still tombstoned

      const [run] = await t.db.select().from(restoreRuns).where(eq(restoreRuns.id, runId));
      expect(run!.results).toHaveLength(2);
      expect(run!.results[1]).toMatchObject({ mediaItemId: failedId, ok: false });
    });

    it('finishRestoreRun derives completed_with_errors from the counts (AC-09 report)', async () => {
      const { status } = await finishRestoreRun({ db: t.db, runId });
      expect(status).toBe('completed_with_errors');
      const [run] = await t.db.select().from(restoreRuns).where(eq(restoreRuns.id, runId));
      expect(run!.finishedAt).not.toBeNull();
    });

    it('a finished run is closed: no more results, no double finish', async () => {
      await expect(
        recordRestoreResult({
          db: t.db,
          runId,
          result: { mediaItemId: lostIds[0]!, ok: true },
        }),
      ).rejects.toThrow(NotFoundError);
      await expect(finishRestoreRun({ db: t.db, runId })).rejects.toThrow(NotFoundError);
    });
  });

  it('an all-success run derives status completed', async () => {
    const { runId } = await startRestoreRun({
      db: t.db,
      arrKind: 'radarr',
      initiatedBy: adminId,
      preview: [{ mediaItemId: lostIds[0]!, title: 'Lost Movie 1' }],
    });
    await recordRestoreResult({
      db: t.db,
      runId,
      result: { mediaItemId: lostIds[0]!, ok: true, newArrItemId: 5002 },
    });
    const { status } = await finishRestoreRun({ db: t.db, runId });
    expect(status).toBe('completed');
  });

  it('the audit row outlives the initiating admin (initiated_by SET NULL)', async () => {
    await t.db.delete(users).where(eq(users.id, adminId));
    const runs = await t.db.select().from(restoreRuns);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.initiatedBy === null)).toBe(true);
  });
});
