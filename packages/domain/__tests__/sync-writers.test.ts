import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, mediaItems, syncRuns, syncState } from '@hnet/db/schema';
import {
  MassTombstoneAbortedError,
  NotFoundError,
  backfillEventAttribution,
  finishSyncRun,
  ingestLedgerEvents,
  startSyncRun,
  tombstoneMissingItems,
  upsertMediaItemsBatch,
  type MediaItemSyncFields,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

function sonarrItem(n: number, overrides: Partial<MediaItemSyncFields> = {}): MediaItemSyncFields {
  return {
    arrItemId: n,
    tvdbId: 100_000 + n,
    title: `Series ${n}`,
    sortTitle: `series ${n}`,
    monitored: true,
    qualityProfileId: 1,
    qualityProfileName: 'Any',
    rootFolder: '/data/haynestower/Media/TV Shows',
    expectedFileCount: 10,
    onDiskFileCount: 10,
    sizeOnDisk: 1_000,
    arrTags: ['mediarequests'],
    arrAttrs: { seriesType: 'standard', seasonFolder: true },
    ...overrides,
  };
}

describe('sync single-writers (DESIGN-005 D-11/D-12/D-14)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  describe('startSyncRun / finishSyncRun', () => {
    it('brackets a run: running → succeeded with stats, finished_at set', async () => {
      const { runId } = await startSyncRun({ db: t.db, source: 'sonarr', runKind: 'full' });
      const [running] = await t.db.select().from(syncRuns).where(eq(syncRuns.id, runId));
      expect(running).toMatchObject({ status: 'running', finishedAt: null });

      await finishSyncRun({
        db: t.db,
        runId,
        status: 'succeeded',
        stats: { itemsSeen: 3, upserted: 3 },
      });
      const [done] = await t.db.select().from(syncRuns).where(eq(syncRuns.id, runId));
      expect(done).toMatchObject({ status: 'succeeded', stats: { itemsSeen: 3, upserted: 3 } });
      expect(done!.finishedAt).not.toBeNull();
    });

    it('a run finishes exactly once (append-only after finish)', async () => {
      const { runId } = await startSyncRun({ db: t.db, source: 'radarr', runKind: 'incremental' });
      await finishSyncRun({ db: t.db, runId, status: 'failed', error: 'boom' });
      await expect(finishSyncRun({ db: t.db, runId, status: 'succeeded' })).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('upsertMediaItemsBatch (D-14 full sync steps 3a-3c)', () => {
    const instance = { arrKind: 'sonarr' as const, arrInstanceId: 'main' };
    const rows = () =>
      t.db
        .select()
        .from(mediaItems)
        .where(and(eq(mediaItems.arrKind, 'sonarr'), eq(mediaItems.arrInstanceId, 'main')));

    it('inserts new items and stamps sync_state.last_full_sync_at in the same tx', async () => {
      const result = await upsertMediaItemsBatch({
        db: t.db,
        ...instance,
        items: [sonarrItem(1), sonarrItem(2), sonarrItem(3)],
      });
      expect(result).toEqual({ inserted: 3, updated: 0, rematched: 0 });
      expect(await rows()).toHaveLength(3);

      const [state] = await t.db.select().from(syncState).where(eq(syncState.source, 'sonarr'));
      expect(state?.lastFullSyncAt).not.toBeNull();
    });

    it('re-running the same batch updates in place (idempotent, no duplicates)', async () => {
      const before = await rows();
      const result = await upsertMediaItemsBatch({
        db: t.db,
        ...instance,
        items: [sonarrItem(1, { monitored: false }), sonarrItem(2), sonarrItem(3)],
      });
      expect(result).toEqual({ inserted: 0, updated: 3, rematched: 0 });
      const after = await rows();
      expect(after).toHaveLength(3);
      const one = after.find((r) => r.arrItemId === 1)!;
      expect(one.monitored).toBe(false);
      expect(one.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
        before.find((r) => r.arrItemId === 1)!.lastSeenAt.getTime(),
      );
    });

    it('rebuilt-*arr simulation: same external ids, new internal ids → re-matched in place (D-14 3b)', async () => {
      const result = await upsertMediaItemsBatch({
        db: t.db,
        ...instance,
        // A rebuilt Sonarr assigned fresh ids 501-503 to the same tvdb identities.
        items: [
          sonarrItem(501, { tvdbId: 100_001 }),
          sonarrItem(502, { tvdbId: 100_002 }),
          sonarrItem(503, { tvdbId: 100_003 }),
        ],
      });
      expect(result).toEqual({ inserted: 0, updated: 0, rematched: 3 });
      const after = await rows();
      expect(after).toHaveLength(3); // no duplicates
      expect(after.map((r) => r.arrItemId).sort()).toEqual([501, 502, 503]);
    });
  });

  describe('tombstoneMissingItems + the D-14 mass-tombstone guard', () => {
    it('tombstones vanished rows and writes deleted(item_removed) events', async () => {
      await upsertMediaItemsBatch({
        db: t.db,
        arrKind: 'sonarr',
        arrInstanceId: 'small',
        items: [sonarrItem(11), sonarrItem(12), sonarrItem(13)],
      });
      const result = await tombstoneMissingItems({
        db: t.db,
        arrKind: 'sonarr',
        arrInstanceId: 'small',
        seenArrItemIds: [11, 12], // 13 vanished (1 of 3 — under both guard bounds)
      });
      expect(result).toEqual({ tombstoned: 1, liveCount: 3 });

      const [gone] = await t.db
        .select()
        .from(mediaItems)
        .where(and(eq(mediaItems.arrInstanceId, 'small'), eq(mediaItems.arrItemId, 13)));
      expect(gone!.deletedFromArrAt).not.toBeNull();

      const events = await t.db
        .select()
        .from(ledgerEvents)
        .where(and(eq(ledgerEvents.mediaItemId, gone!.id), eq(ledgerEvents.eventType, 'deleted')));
      expect(events).toHaveLength(1);
      expect(events[0]!.source).toBe('sonarr');
      expect(events[0]!.payload).toMatchObject({ kind: 'item_removed', arrItemId: 13 });
    });

    it('aborts at the threshold (> 20% AND > 10 rows) and writes NOTHING', async () => {
      await upsertMediaItemsBatch({
        db: t.db,
        arrKind: 'sonarr',
        arrInstanceId: 'guard',
        items: Array.from({ length: 20 }, (_, i) => sonarrItem(200 + i)),
      });
      // 15 of 20 missing: 75% > 20% and 15 > 10 → abort
      await expect(
        tombstoneMissingItems({
          db: t.db,
          arrKind: 'sonarr',
          arrInstanceId: 'guard',
          seenArrItemIds: [200, 201, 202, 203, 204],
        }),
      ).rejects.toThrow(MassTombstoneAbortedError);

      const tombstoned = await t.db
        .select()
        .from(mediaItems)
        .where(eq(mediaItems.arrInstanceId, 'guard'));
      expect(tombstoned.every((r) => r.deletedFromArrAt === null)).toBe(true); // tx rolled back
    });

    it('force: true overrides the guard (--force-tombstones, Q-03)', async () => {
      const result = await tombstoneMissingItems({
        db: t.db,
        arrKind: 'sonarr',
        arrInstanceId: 'guard',
        seenArrItemIds: [200, 201, 202, 203, 204],
        force: true,
      });
      expect(result).toEqual({ tombstoned: 15, liveCount: 20 });
    });

    it('exactly 10 missing rows is NOT "more than 10" — proceeds even at a high percentage', async () => {
      await upsertMediaItemsBatch({
        db: t.db,
        arrKind: 'sonarr',
        arrInstanceId: 'edge',
        items: Array.from({ length: 12 }, (_, i) => sonarrItem(300 + i)),
      });
      const result = await tombstoneMissingItems({
        db: t.db,
        arrKind: 'sonarr',
        arrInstanceId: 'edge',
        seenArrItemIds: [300, 301], // 10 of 12 missing (83%) but not > 10 rows
      });
      expect(result).toEqual({ tombstoned: 10, liveCount: 12 });
    });

    it('a force-tombstoned row is un-tombstoned when sync sees it again', async () => {
      const result = await upsertMediaItemsBatch({
        db: t.db,
        arrKind: 'sonarr',
        arrInstanceId: 'guard',
        items: [sonarrItem(205)],
      });
      expect(result).toEqual({ inserted: 0, updated: 1, rematched: 0 });
      const [row] = await t.db
        .select()
        .from(mediaItems)
        .where(and(eq(mediaItems.arrInstanceId, 'guard'), eq(mediaItems.arrItemId, 205)));
      expect(row!.deletedFromArrAt).toBeNull();
    });
  });

  describe('ingestLedgerEvents (D-14 incremental: cursor + dedupe)', () => {
    const grabbed = (id: string, occurredAt: Date) => ({
      eventType: 'grabbed' as const,
      source: 'radarr' as const,
      sourceEventId: id,
      occurredAt,
      payload: { rawEventType: 'grabbed', sourceTitle: `Release ${id}` },
    });
    const radarrEvents = () =>
      t.db.select().from(ledgerEvents).where(eq(ledgerEvents.source, 'radarr'));

    it('inserts a batch and advances the cursor in the same tx', async () => {
      const cursor = new Date('2026-07-01T10:00:00Z');
      const result = await ingestLedgerEvents({
        db: t.db,
        source: 'radarr',
        events: [
          grabbed('r-1', new Date('2026-07-01T08:00:00Z')),
          grabbed('r-2', new Date('2026-07-01T09:00:00Z')),
          grabbed('r-3', cursor),
        ],
        cursor,
      });
      expect(result).toEqual({ inserted: 3, skipped: 0 });
      const [state] = await t.db.select().from(syncState).where(eq(syncState.source, 'radarr'));
      expect(state!.historyCursor!.getTime()).toBe(cursor.getTime());
    });

    it('overlap re-delivery is a no-op on the dedupe index (event count stable)', async () => {
      const cursor = new Date('2026-07-01T11:00:00Z');
      const result = await ingestLedgerEvents({
        db: t.db,
        source: 'radarr',
        events: [
          grabbed('r-2', new Date('2026-07-01T09:00:00Z')), // duplicate
          grabbed('r-3', new Date('2026-07-01T10:00:00Z')), // duplicate
          grabbed('r-4', cursor), // new
        ],
        cursor,
      });
      expect(result).toEqual({ inserted: 1, skipped: 2 });
      expect(await radarrEvents()).toHaveLength(4);
      const [state] = await t.db.select().from(syncState).where(eq(syncState.source, 'radarr'));
      expect(state!.historyCursor!.getTime()).toBe(cursor.getTime());
    });

    it('the cursor never moves backwards (GREATEST)', async () => {
      await ingestLedgerEvents({
        db: t.db,
        source: 'radarr',
        events: [],
        cursor: new Date('2026-06-01T00:00:00Z'),
      });
      const [state] = await t.db.select().from(syncState).where(eq(syncState.source, 'radarr'));
      expect(state!.historyCursor!.getTime()).toBe(new Date('2026-07-01T11:00:00Z').getTime());
    });
  });

  describe('backfillEventAttribution (D-14 Seerr attribution)', () => {
    it('links a request that preceded the *arr add, and its user, once both appear', async () => {
      // 1. Seerr request lands before Radarr knows the movie and before the user exists.
      await ingestLedgerEvents({
        db: t.db,
        source: 'seerr',
        events: [
          {
            eventType: 'requested',
            source: 'seerr',
            sourceEventId: 'seerr-42',
            occurredAt: new Date('2026-07-02T00:00:00Z'),
            payload: {
              mediaType: 'movie',
              tmdbId: 42_000,
              requestedBy: { email: 'Requester@Example.com', plexUsername: 'requester' },
            },
          },
        ],
        cursor: new Date('2026-07-02T00:00:00Z'),
      });
      const eventBefore = await t.db
        .select()
        .from(ledgerEvents)
        .where(eq(ledgerEvents.sourceEventId, 'seerr-42'));
      expect(eventBefore[0]).toMatchObject({ mediaItemId: null, requestedByUserId: null });

      // 2. The movie syncs in and the user logs in (case-differing email).
      await upsertMediaItemsBatch({
        db: t.db,
        arrKind: 'radarr',
        items: [
          {
            arrItemId: 9001,
            tmdbId: 42_000,
            title: 'Requested Movie',
            sortTitle: 'requested movie',
            monitored: true,
            qualityProfileId: 1,
            qualityProfileName: 'Any',
            rootFolder: '/movies',
          },
        ],
      });
      const user = await createUser(t.db, { email: 'requester@example.com' });

      // 3. Backfill resolves both FKs.
      const result = await backfillEventAttribution({ db: t.db });
      expect(result).toEqual({ itemsLinked: 1, usersLinked: 1 });

      const [after] = await t.db
        .select()
        .from(ledgerEvents)
        .where(eq(ledgerEvents.sourceEventId, 'seerr-42'));
      expect(after!.requestedByUserId).toBe(user.id);
      const [item] = await t.db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(eq(mediaItems.tmdbId, 42_000));
      expect(after!.mediaItemId).toBe(item!.id);
    });

    it('leaves unresolvable events unattributed (ADR-008 C-05)', async () => {
      await ingestLedgerEvents({
        db: t.db,
        source: 'seerr',
        events: [
          {
            eventType: 'requested',
            source: 'seerr',
            sourceEventId: 'seerr-43',
            occurredAt: new Date('2026-07-02T01:00:00Z'),
            payload: {
              mediaType: 'movie',
              tmdbId: 43_000, // no such item
              requestedBy: { email: 'stranger@nowhere.test' },
            },
          },
        ],
      });
      const result = await backfillEventAttribution({ db: t.db });
      expect(result).toEqual({ itemsLinked: 0, usersLinked: 0 });
      const [row] = await t.db
        .select()
        .from(ledgerEvents)
        .where(eq(ledgerEvents.sourceEventId, 'seerr-43'));
      expect(row).toMatchObject({ mediaItemId: null, requestedByUserId: null });
    });
  });
});
