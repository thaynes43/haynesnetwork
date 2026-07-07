// ADR-031 / DESIGN-014 (PLAN-014) — the RULES-TUNING report (embedded PG16). Proves the rescue-vs-
// delete math per resolution / rating band / collection over seeded batch items + media_metadata, the
// save-rate definition (rescued / (rescued + deleted)), and the skip-gate GRADUATION calc (completed
// policy batches, aggregate save-rate, restores-of-swept, meetsCriteria).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { ledgerEvents, mediaItems, trashBatchItems, trashBatchSaves, trashBatches } from '@hnet/db/schema';
import type { TrashMediaKind } from '@hnet/db';
import {
  getTuningReport,
  ratingBand,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const GB = 1_000_000_000;

interface SeedItem {
  mediaItemId?: string | null;
  state: 'saved' | 'deleted' | 'skipped';
  deletedResolution?: string | null;
  deletedImdbRating?: string | null;
  collectionId?: number | null;
}

describe('getTuningReport (ADR-031 — rescue-vs-delete stats + graduation)', () => {
  let t: TestDb;
  let actorId: string;
  const byTmdb = new Map<number, string>();
  let seq = 0;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'tuning-admin@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [4001, 4002, 4003, 4004].map((tmdb) => ({
        arrItemId: tmdb,
        tmdbId: tmdb,
        title: `T-${tmdb}`,
        sortTitle: `t-${tmdb}`,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/m',
      })),
    });
    for (const r of await t.db.select().from(mediaItems)) byTmdb.set(r.tmdbId!, r.id);
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [
        { mediaItemId: byTmdb.get(4001)!, resolution: '2160p', imdbRating: 8.5 },
        { mediaItemId: byTmdb.get(4002)!, resolution: '720p', imdbRating: 6.0 },
        { mediaItemId: byTmdb.get(4003)!, resolution: '1080p', imdbRating: 4.0 },
        { mediaItemId: byTmdb.get(4004)!, resolution: '720p', imdbRating: 8.2 },
      ],
    });
  });
  afterAll(async () => t?.stop());

  beforeEach(async () => {
    await t.db.delete(trashBatches); // cascades items
    await t.db
      .delete(ledgerEvents)
      .where(inArray(ledgerEvents.eventType, ['trash_space_policy', 'trash_restored']));
  });

  async function seedBatch(opts: {
    mediaKind: TrashMediaKind;
    state: 'deleted' | 'cancelled' | 'admin_review';
    policy: boolean;
    deletedAt?: Date;
    items: SeedItem[];
  }): Promise<string> {
    const [batch] = await t.db
      .insert(trashBatches)
      .values({
        mediaKind: opts.mediaKind,
        state: opts.state,
        greenlitBy: actorId,
        deletedAt: opts.deletedAt ?? (opts.state === 'deleted' ? new Date() : null),
      })
      .returning();
    const bid = batch!.id;
    await t.db.insert(trashBatchItems).values(
      opts.items.map((it) => ({
        batchId: bid,
        maintainerrMediaId: `ms-${++seq}`,
        mediaItemId: it.mediaItemId ?? null,
        title: `item-${seq}`,
        state: it.state,
        collectionId: it.collectionId ?? null,
        deletedResolution: it.deletedResolution ?? null,
        deletedImdbRating: it.deletedImdbRating ?? null,
        sizeBytes: 2 * GB,
      })),
    );
    if (opts.policy) {
      await t.db.insert(ledgerEvents).values({
        mediaItemId: null,
        eventType: 'trash_space_policy',
        source: 'maintainerr',
        occurredAt: opts.deletedAt ?? new Date(),
        payload: { batchId: bid, mediaKind: opts.mediaKind, array: 'haynestower', usedPct: 90, target: 80 },
      });
    }
    return bid;
  }

  it('ratingBand buckets the IMDb scale', () => {
    expect(ratingBand(9)).toBe('8.0+');
    expect(ratingBand(7.4)).toBe('7.0–7.9');
    expect(ratingBand(5)).toBe('5.0–6.9');
    expect(ratingBand(4.9)).toBe('<5.0');
    expect(ratingBand(null)).toBe('unknown');
  });

  it('breakdowns: overall + by resolution + by rating band, save-rate = rescued/(rescued+deleted)', async () => {
    await seedBatch({
      mediaKind: 'movie',
      state: 'deleted',
      policy: true,
      items: [
        { mediaItemId: byTmdb.get(4001), state: 'saved' }, // 2160p, 8.5
        { mediaItemId: byTmdb.get(4002), state: 'deleted', deletedResolution: '720p', deletedImdbRating: '6.0' },
        { mediaItemId: byTmdb.get(4003), state: 'deleted', deletedResolution: '1080p', deletedImdbRating: '4.0' },
        { mediaItemId: byTmdb.get(4004), state: 'skipped' }, // 720p, 8.2 (guardian-kept)
      ],
    });
    const r = await getTuningReport({ db: t.db });

    // Overall: 1 rescued, 2 deleted, 1 skipped ⇒ save-rate 1/(1+2)=33.3%.
    expect(r.overall).toMatchObject({ proposed: 4, rescued: 1, deleted: 2, skipped: 1, saveRatePct: 33.3 });

    const res = (k: string) => r.byResolution.find((c) => c.key === k)!;
    expect(res('2160p')).toMatchObject({ rescued: 1, deleted: 0, saveRatePct: 100 });
    expect(res('720p')).toMatchObject({ rescued: 0, deleted: 1, skipped: 1, saveRatePct: 0 });
    expect(res('1080p')).toMatchObject({ deleted: 1, saveRatePct: 0 });

    const band = (k: string) => r.byRatingBand.find((c) => c.key === k)!;
    expect(band('8.0+')).toMatchObject({ rescued: 1, skipped: 1, saveRatePct: 100 });
    expect(band('5.0–6.9')).toMatchObject({ deleted: 1, saveRatePct: 0 });
    expect(band('<5.0')).toMatchObject({ deleted: 1, saveRatePct: 0 });

    // Only ONE completed policy batch ⇒ graduation not met (needs ≥3).
    expect(r.graduation.completedPolicyBatches).toBe(1);
    expect(r.graduation.meetsCriteria).toBe(false);
  });

  it('rescue-rate is NET: a saved-then-unsaved item that got deleted counts as DELETED, not rescued', async () => {
    // The item churned (a save then an un-save in the audit log) but the sweep ultimately deleted it.
    // The report keys off the item's FINAL state, so the raw save event must never leak into `rescued`.
    const bid = await seedBatch({
      mediaKind: 'movie',
      state: 'deleted',
      policy: true,
      items: [
        { mediaItemId: byTmdb.get(4001), state: 'deleted', deletedResolution: '1080p', deletedImdbRating: '6.0' },
      ],
    });
    const [item] = await t.db
      .select()
      .from(trashBatchItems)
      .where(inArray(trashBatchItems.batchId, [bid]));
    await t.db.insert(trashBatchSaves).values([
      { batchItemId: item!.id, userId: actorId, action: 'save' },
      { batchItemId: item!.id, userId: actorId, action: 'unsave' },
    ]);

    const r = await getTuningReport({ db: t.db });
    expect(r.overall).toMatchObject({ rescued: 0, deleted: 1, saveRatePct: 0 });
    expect(r.graduation.aggregate).toMatchObject({ rescued: 0, deleted: 1 });
  });

  it('graduation MET: ≥3 completed policy batches, ≤10% save-rate, 0 restores', async () => {
    // Three clean policy batches: all deleted, nothing rescued (the rules were trusted).
    await seedBatch({ mediaKind: 'movie', state: 'deleted', policy: true, deletedAt: new Date(Date.now() - 3 * 86_400_000), items: [{ state: 'deleted', deletedResolution: '720p', deletedImdbRating: '5.0' }, { state: 'deleted', deletedResolution: '720p', deletedImdbRating: '5.5' }] });
    await seedBatch({ mediaKind: 'tv', state: 'deleted', policy: true, deletedAt: new Date(Date.now() - 2 * 86_400_000), items: [{ state: 'deleted', deletedResolution: '1080p', deletedImdbRating: '6.0' }] });
    await seedBatch({ mediaKind: 'movie', state: 'deleted', policy: true, deletedAt: new Date(Date.now() - 1 * 86_400_000), items: [{ state: 'deleted', deletedResolution: '2160p', deletedImdbRating: '4.0' }] });

    const r = await getTuningReport({ db: t.db });
    expect(r.graduation.completedPolicyBatches).toBe(3);
    expect(r.graduation.recent).toHaveLength(3);
    expect(r.graduation.aggregate.saveRatePct).toBe(0);
    expect(r.graduation.restoresOfSwept).toBe(0);
    expect(r.graduation.meetsCriteria).toBe(true);
  });

  it('graduation BLOCKED by a restore of a swept item', async () => {
    const bid = await seedBatch({ mediaKind: 'movie', state: 'deleted', policy: true, items: [{ mediaItemId: byTmdb.get(4001), state: 'deleted', deletedResolution: '720p', deletedImdbRating: '5.0' }] });
    await seedBatch({ mediaKind: 'tv', state: 'deleted', policy: true, items: [{ state: 'deleted', deletedResolution: '1080p', deletedImdbRating: '6.0' }] });
    await seedBatch({ mediaKind: 'movie', state: 'deleted', policy: true, items: [{ state: 'deleted', deletedResolution: '2160p', deletedImdbRating: '4.0' }] });
    // A restore of item 4001, which a policy batch swept ⇒ a near-miss that blocks graduation.
    await t.db.insert(ledgerEvents).values({
      mediaItemId: byTmdb.get(4001)!,
      eventType: 'trash_restored',
      source: 'maintainerr',
      occurredAt: new Date(),
      payload: { batchId: bid },
    });

    const r = await getTuningReport({ db: t.db });
    expect(r.graduation.completedPolicyBatches).toBe(3);
    expect(r.graduation.restoresOfSwept).toBe(1);
    expect(r.graduation.meetsCriteria).toBe(false);
  });

  it('a non-completed (admin_review) policy batch does NOT count toward graduation', async () => {
    await seedBatch({ mediaKind: 'movie', state: 'admin_review', policy: true, items: [{ state: 'saved', mediaItemId: byTmdb.get(4001) }] });
    const r = await getTuningReport({ db: t.db });
    expect(r.graduation.completedPolicyBatches).toBe(0);
  });

  it('empty dataset → zeroed report, graduation not met', async () => {
    const r = await getTuningReport({ db: t.db });
    expect(r.overall).toMatchObject({ proposed: 0, rescued: 0, deleted: 0, saveRatePct: null });
    expect(r.byResolution).toEqual([]);
    expect(r.graduation.meetsCriteria).toBe(false);
  });
});
