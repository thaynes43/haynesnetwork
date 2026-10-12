// ADR-109 C-04 / DESIGN-055 D-02 (PLAN-077 P2) — the Repair Request single writer on embedded Postgres: the pending row
// and its ledger event commit together; the hourly budget is shared with Fix and Force Search; one open repair or fix per
// grain, checked both ways; transitions; completion read from the ingested import; the 48-hour timeout.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixRequests, ledgerEvents, repairRequests } from '@hnet/db/schema';
import {
  FixAlreadyOpenError,
  FixRateLimitError,
  InvalidFixTransitionError,
  assertFixAllowed,
  completeRepairRequests,
  createFixRequest,
  createRepairRequest,
  expireStaleRepairRequests,
  recordRepairTransition,
  recordSearchRequest,
  upsertMediaItemsBatch,
  MEDIA_ACTION_BUDGET_FALLBACK,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('Repair Requests (DESIGN-055 D-02)', () => {
  let t: TestDb;
  let memberId: string;
  let showId: string;
  let movieId: string;

  const importRepair = (o: Partial<Parameters<typeof createRepairRequest>[0]> = {}) =>
    createRepairRequest({
      db: t.db,
      requesterId: memberId,
      mediaItemId: showId,
      kind: 'import_download',
      scope: 'episode',
      seasonNumber: 2,
      targetChildIds: [85215],
      targetLabel: 'S02E06 · 125 Years Young',
      preview: { state: 'import' },
      ...o,
    });

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'repairer@example.com', displayName: 'Repairer' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: 864, tvdbId: 425007, title: 'The Paper (2025)', sortTitle: 'paper', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/tv' }],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [{ arrItemId: 9428, tmdbId: 969681, title: 'Spider-Man: Brand New Day', sortTitle: 'spider', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' }],
    });
    const items = await t.db.query.mediaItems.findMany();
    showId = items.find((i) => i.arrItemId === 864)!.id;
    movieId = items.find((i) => i.arrItemId === 9428)!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.db.delete(repairRequests);
    await t.db.update(fixRequests).set({ status: 'closed_manually' });
  });

  it('opens the pending row and its repair_requested event together, with the requester snapshot', async () => {
    const { repairRequestId } = await importRepair();
    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, repairRequestId));
    expect(row).toMatchObject({ status: 'pending', kind: 'import_download', scope: 'episode', seasonNumber: 2, targetChildIds: [85215] });
    expect(row!.actionsTaken[0]).toMatchObject({ step: 'created', requester: { email: 'repairer@example.com' } });
    const [event] = await t.db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.eventType, 'repair_requested'), eq(ledgerEvents.mediaItemId, showId)));
    expect(event).toMatchObject({ requestedByUserId: memberId, payload: { repairRequestId, kind: 'import_download' } });
  });

  it('one open repair per (series, season), and per movie', async () => {
    await importRepair();
    await expect(importRepair({ targetChildIds: [85216] })).rejects.toBeInstanceOf(FixAlreadyOpenError);
    // Another season of the same show is its own grain.
    await importRepair({ seasonNumber: 1, targetChildIds: [85200] });
    await createRepairRequest({ db: t.db, requesterId: memberId, mediaItemId: movieId, kind: 'import_download', scope: 'item', seasonNumber: null, targetChildIds: [], preview: {} });
    await expect(
      createRepairRequest({ db: t.db, requesterId: memberId, mediaItemId: movieId, kind: 'import_download', scope: 'item', seasonNumber: null, targetChildIds: [], preview: {} }),
    ).rejects.toBeInstanceOf(FixAlreadyOpenError);
  });

  it('the open check is shared both ways with Fix', async () => {
    // An open episode Fix in the season blocks an import there (the caller names the season's episodes).
    await createFixRequest({ db: t.db, requesterId: memberId, mediaItemId: showId, scope: 'episode', targetArrChildId: 85216, reason: 'wont_play_corrupt' });
    await expect(importRepair({ seasonEpisodeIds: [85210, 85215, 85216] })).rejects.toBeInstanceOf(FixAlreadyOpenError);
    // Without the season's episodes (an import onto one episode), a Fix on another episode does not block it.
    const free = await importRepair();
    await t.db.delete(repairRequests).where(eq(repairRequests.id, free.repairRequestId));
    await t.db.update(fixRequests).set({ status: 'closed_manually' });

    // An open import blocks a Fix on its episode, and a season Fix on its season.
    await importRepair();
    await expect(
      createFixRequest({ db: t.db, requesterId: memberId, mediaItemId: showId, scope: 'episode', targetArrChildId: 85215, reason: 'wont_play_corrupt' }),
    ).rejects.toBeInstanceOf(FixAlreadyOpenError);
    await expect(
      assertFixAllowed({ db: t.db, requesterId: memberId, mediaItemId: showId, scope: 'season', targetArrChildId: null, seasonNumber: 2 }),
    ).rejects.toBeInstanceOf(FixAlreadyOpenError);
    // Another season is free.
    await assertFixAllowed({ db: t.db, requesterId: memberId, mediaItemId: showId, scope: 'season', targetArrChildId: null, seasonNumber: 1 });
  });

  it('draws on the one hourly budget with Fix and Force Search (admins bypass)', async () => {
    const user = (await createUser(t.db, { email: 'budget@example.com', displayName: 'Budget' })).id;
    // One repair plus (fallback − 1) searches spends the shared allowance.
    await importRepair({ requesterId: user });
    for (let i = 0; i < MEDIA_ACTION_BUDGET_FALLBACK - 1; i++) {
      await recordSearchRequest({ db: t.db, requesterId: user, mediaItemId: movieId });
    }
    await expect(recordSearchRequest({ db: t.db, requesterId: user, mediaItemId: movieId })).rejects.toBeInstanceOf(
      FixRateLimitError,
    );
    await expect(
      createRepairRequest({ db: t.db, requesterId: user, mediaItemId: movieId, kind: 'import_download', scope: 'item', seasonNumber: null, targetChildIds: [], preview: {} }),
    ).rejects.toBeInstanceOf(FixRateLimitError);
    // Admins bypass the budget (not the one-open rule).
    await createRepairRequest({
      db: t.db, requesterId: user, requesterIsAdmin: true, mediaItemId: movieId, kind: 'import_download', scope: 'item', seasonNumber: null, targetChildIds: [], preview: {},
    });
  });

  it('moves through actioned to completed or failed, with the events; terminal rows do not move', async () => {
    const { repairRequestId } = await importRepair();
    await recordRepairTransition({ db: t.db, repairRequestId, transition: 'actioned', actions: [{ step: 'manual_import', at: 'x', commandId: 77 }] });
    await recordRepairTransition({ db: t.db, repairRequestId, transition: 'completed' });
    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, repairRequestId));
    expect(row!.status).toBe('completed');
    expect(row!.completedAt).not.toBeNull();
    await expect(recordRepairTransition({ db: t.db, repairRequestId, transition: 'failed' })).rejects.toBeInstanceOf(
      InvalidFixTransitionError,
    );
    const failing = await importRepair({ seasonNumber: 3, targetChildIds: [99] });
    await recordRepairTransition({ db: t.db, repairRequestId: failing.repairRequestId, transition: 'failed' });
    const types = (await t.db.select({ type: ledgerEvents.eventType }).from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, showId))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['repair_completed', 'repair_failed']));
  });

  it('an actioned import completes from the ingested import of every target; a stale open one times out', async () => {
    const { repairRequestId } = await importRepair({ targetChildIds: [85215] });
    await recordRepairTransition({ db: t.db, repairRequestId, transition: 'actioned' });
    expect((await completeRepairRequests({ db: t.db })).completed).toEqual([]);
    await t.db.insert(ledgerEvents).values({
      mediaItemId: showId,
      eventType: 'imported',
      source: 'sonarr',
      occurredAt: new Date(Date.now() + 1000),
      payload: { episodeId: 85215 },
    });
    expect((await completeRepairRequests({ db: t.db })).completed).toEqual([repairRequestId]);
    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, repairRequestId));
    expect(row!.status).toBe('completed');

    const stale = await importRepair({ seasonNumber: 4, targetChildIds: [400] });
    expect((await expireStaleRepairRequests({ db: t.db, horizonMs: 60_000 })).timedOut).toEqual([]);
    const later = new Date(Date.now() + 2 * 60_000);
    expect((await expireStaleRepairRequests({ db: t.db, horizonMs: 60_000, asOf: later })).timedOut).toEqual([stale.repairRequestId]);
    // The grain is free again.
    await importRepair({ seasonNumber: 4, targetChildIds: [400] });
  });
});
