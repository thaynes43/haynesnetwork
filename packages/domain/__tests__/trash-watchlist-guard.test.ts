// ADR-093 / DESIGN-052 D-06..D-10, D-14 (PLAN-072 S2) — the Trash guard against watchlists, end to end on embedded
// PG16 with the fetch-stubbed Maintainerr and in-memory registry sources (no live API, ADR-010).
//
// - the proposal: a targeted batch leaves a watchlisted item out; an untargeted batch snapshots it `pending` (never
//   `protected`) and the sweep keeps it; the space policy's minCandidates counts deletable items only (D-08);
// - the sweep: an inline refresh, the gate, `watchlisted` / `not_in_pool` / `live_excluded` / `recently_watched` /
//   `unevaluable` keep reasons written on the skipped rows (D-09); a stale registry pauses the scheduled sweep cleanly
//   (nothing deleted, trash_sweep_status paused_gate, paused_since kept, the banner only after 6 h) and a forced
//   manual Expire now deletes nothing; an ok run clears the pause (D-14);
// - Expedite: item and all refuse on a stale registry; a watchlisted target is kept and never auto-saved (D-09);
// - the typed snapshot: no snapshot ⇒ every item unevaluable (D-06, D-24e);
// - the batch wall: the "On a watchlist" note and the keep reason (D-10).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashSweepStatus,
  watchlistRegistryAccounts,
  watchlistRegistryRuns,
} from '@hnet/db/schema';
import {
  WatchlistRegistryUnverifiedError,
  classifyGuardian,
  createBatchFromPending,
  createStaticWatchlistSources,
  evaluateSpacePolicy,
  expediteDeletion,
  getBatchDetail,
  getTrashSweepStatus,
  listTrashPending,
  refreshTrashCandidates,
  setAppSetting,
  silentDomainLogger,
  sweepExpiredBatches,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  buildArrClientBundle,
  defaultPerKind,
  type DomainLogger,
  type StaticWatchlistFixture,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection, type MaintState } from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

const G1 = '5d776824151a60001f240001';
const G2 = '5d776824151a60001f240002';
const G3 = '5d776824151a60001f240003';
const G4 = '5d776824151a60001f240004';

/** A movie pool of four items, each with its plex guid (ms-9004 is the recently watched one). */
function pool(over: Partial<ReturnType<typeof movieCollection>> = {}) {
  return movieCollection({
    items: [
      {
        mediaServerId: 'ms-9001',
        tmdbId: 9001,
        sizeBytes: 4_000,
        addDate: '2026-06-01T00:00:00Z',
        mediaData: { guid: `plex://movie/${G1}` },
      },
      {
        mediaServerId: 'ms-9002',
        tmdbId: 9002,
        sizeBytes: 3_000,
        addDate: '2026-06-01T00:00:00Z',
        mediaData: { guid: `plex://movie/${G2}` },
      },
      {
        mediaServerId: 'ms-9003',
        tmdbId: 9003,
        sizeBytes: 2_000,
        addDate: '2026-06-01T00:00:00Z',
        mediaData: { guid: `plex://movie/${G3}` },
      },
      {
        mediaServerId: 'ms-9004',
        tmdbId: 9004,
        sizeBytes: 1_000,
        addDate: '2026-06-01T00:00:00Z',
        mediaData: { guid: `plex://movie/${G4}` },
      },
    ],
    ...over,
  });
}

/** The registry: the owner lists G2 (ms-9002); a friend lists nothing. */
const listingG2 = (): StaticWatchlistFixture => ({
  ownerId: '1',
  owner: [{ discoverId: G2, kind: 'movie', tmdbId: 9002 }],
});

describe('the Trash watchlist guard (ADR-093 / DESIGN-052)', () => {
  let t: TestDb;
  let admin: string;
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: DomainLogger = {
    info: (msg, fields) => logs.push({ msg, fields }),
    warn: (msg, fields) => logs.push({ msg, fields }),
    error: (msg, fields) => logs.push({ msg, fields }),
  };

  beforeAll(async () => {
    t = await bootMigratedDb();
    admin = (await createUser(t.db, { email: 'wl-guard@example.com', displayName: 'Guard Admin' }))
      .id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [9001, 9002, 9003, 9004].map((tmdbId, i) => ({
        arrItemId: i + 1,
        tmdbId,
        title: `Movie ${tmdbId}`,
        sortTitle: `movie ${tmdbId}`,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      })),
    });
    const [watched] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 9004));
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [{ mediaItemId: watched!.id, lastViewedAt: new Date(Date.now() - 2 * 86_400_000) }],
    });
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    logs.length = 0;
    await t.db.delete(trashBatches);
    await t.db.delete(trashSweepStatus);
    await t.db.delete(watchlistRegistryAccounts);
    await t.db.delete(watchlistRegistryRuns);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: admin });
  });

  /** Create a leaving_soon batch of the whole pool and close its window. */
  async function expiredBatch(state: MaintState, targeting?: { maxItems: number }) {
    const { bundle } = makeMaintainerr(state);
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId: admin,
      ...(targeting ? { targeting } : {}),
    });
    await t.db
      .update(trashBatches)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(trashBatches.id, created.batchId));
    return created.batchId;
  }
  const itemStates = async (batchId: string) =>
    Object.fromEntries(
      (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId))).map(
        (r) => [r.maintainerrMediaId, { state: r.state, keepReason: r.keepReason }],
      ),
    );

  it('D-08: an untargeted batch snapshots the watchlisted item pending; a targeted one leaves it out', async () => {
    await seedVerifiedWatchlistRegistry(t.db, listingG2());
    const untargeted = await expiredBatch(baseState({ collections: [pool()] }));
    expect((await itemStates(untargeted))['ms-9002']).toEqual({
      state: 'pending',
      keepReason: null,
    });
    await t.db.delete(trashBatches);
    const targeted = await expiredBatch(baseState({ collections: [pool()] }), { maxItems: 4 });
    expect(Object.keys(await itemStates(targeted)).sort()).toEqual([
      'ms-9001',
      'ms-9003',
      'ms-9004',
    ]);
  });

  it('the scheduled sweep refreshes inline, keeps the watchlisted item (`watchlisted`) and every other keep reason', async () => {
    const state = baseState({ collections: [pool()] });
    // ms-9003 is flagged by Maintainerr (ruleEvaluationFailed) ⇒ unevaluable.
    state.collections[0]!.items[2]!.ruleEvaluationFailed = true;
    const batchId = await expiredBatch(state);
    const { bundle, calls } = makeMaintainerr(state);
    const { sources, calls: reads } = createStaticWatchlistSources(listingG2());
    const report = await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: sources,
      logger,
    });
    expect(reads.roster).toBe(1); // the inline refresh ran
    expect(report.registryRefresh?.status).toBe('ok');
    expect(report.paused).toBeNull();
    expect(report.outcome).toBe('ok');
    expect(await itemStates(batchId)).toEqual({
      'ms-9001': { state: 'deleted', keepReason: null },
      'ms-9002': { state: 'skipped', keepReason: 'watchlisted' },
      'ms-9003': { state: 'skipped', keepReason: 'unevaluable' },
      'ms-9004': { state: 'skipped', keepReason: 'recently_watched' },
    });
    const handled = calls.filter(
      (c) => c.method === 'POST' && c.pathname === '/collections/media/handle',
    );
    expect(handled.map((c) => (c.body as { mediaId: string }).mediaId)).toEqual(['ms-9001']);
    expect(report.batches[0]!.keptByReason).toEqual({
      watchlisted: 1,
      unevaluable: 1,
      recently_watched: 1,
    });
    expect(logs.some((l) => l.msg === '[trash] kept' && l.fields?.reason === 'watchlisted')).toBe(
      true,
    );
    const status = await getTrashSweepStatus({ db: t.db });
    expect(status).toMatchObject({ lastOutcome: 'ok', pausedSince: null, banner: null });
  });

  it('pre-guardian keeps record `not_in_pool` and `live_excluded`', async () => {
    await seedVerifiedWatchlistRegistry(t.db);
    const state = baseState({ collections: [pool()] });
    const batchId = await expiredBatch(state);
    state.collections[0]!.items = state.collections[0]!.items.filter(
      (i) => i.mediaServerId !== 'ms-9001',
    );
    state.exclusions.add('ms-9003');
    const { bundle } = makeMaintainerr(state);
    await sweepExpiredBatches({ db: t.db, maintainerr: bundle, registry: 'gate-only', logger });
    const states = await itemStates(batchId);
    expect(states['ms-9001']).toEqual({ state: 'skipped', keepReason: 'not_in_pool' });
    expect(states['ms-9003']).toEqual({ state: 'skipped', keepReason: 'live_excluded' });
    expect(states['ms-9002']).toEqual({ state: 'deleted', keepReason: null });
  });

  it('a stale registry pauses the scheduled sweep cleanly: nothing deleted, paused_gate recorded, banner after 6 h', async () => {
    const state = baseState({ collections: [pool()] });
    const batchId = await expiredBatch(state);
    const { bundle, calls } = makeMaintainerr(state);
    const failing = createStaticWatchlistSources({ ownerId: '1', rosterFails: true });
    const t0 = new Date();
    const report = await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: failing.sources,
      logger,
      now: () => t0,
    });
    expect(report).toMatchObject({
      paused: { reason: 'gate', step: 'stale' },
      outcome: 'paused_gate',
      batchesSwept: 0,
    });
    expect(Object.values(await itemStates(batchId)).every((i) => i.state === 'pending')).toBe(true);
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
    const [batch] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(batch!.state).toBe('leaving_soon');
    expect(logs.some((l) => l.msg === '[trash] sweep_paused' && l.fields?.reason === 'gate')).toBe(
      true,
    );

    // A second paused run keeps paused_since; the banner shows only once the pause is 6 hours old.
    const t1 = new Date(t0.getTime() + 5 * 3_600_000);
    await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: failing.sources,
      logger,
      now: () => t1,
    });
    const [row] = await t.db.select().from(trashSweepStatus);
    expect(row).toMatchObject({ lastOutcome: 'paused_gate', lastReason: 'stale', pausedSince: t0 });
    expect((await getTrashSweepStatus({ db: t.db, now: t1 })).banner).toBeNull();
    expect(
      (await getTrashSweepStatus({ db: t.db, now: new Date(t0.getTime() + 6 * 3_600_000) })).banner,
    ).toBe('gate');

    // The next ok sweep clears the pause.
    const ok = createStaticWatchlistSources({ ownerId: '1' });
    await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: ok.sources,
      logger,
    });
    expect(await getTrashSweepStatus({ db: t.db })).toMatchObject({
      lastOutcome: 'ok',
      pausedSince: null,
      banner: null,
    });
  });

  it('a forced manual Expire now (gate-only) with a stale registry deletes nothing and writes no status row', async () => {
    const state = baseState({ collections: [pool()] });
    const { bundle } = makeMaintainerr(state);
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId: admin,
    });
    const report = await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      registry: 'gate-only',
      batchId: created.batchId,
      forceOverride: true,
      actorId: admin,
      logger,
    });
    expect(report.paused).toEqual({ reason: 'gate', step: 'stale' });
    expect(
      Object.values(await itemStates(created.batchId)).every((i) => i.state === 'pending'),
    ).toBe(true);
    expect(await t.db.select().from(trashSweepStatus)).toEqual([]);
  });

  it('nothing due ⇒ the sweep does nothing and records nothing (not even a refresh)', async () => {
    const { sources, calls } = createStaticWatchlistSources({ ownerId: '1' });
    const { bundle } = makeMaintainerr(baseState({ collections: [pool()] }));
    const report = await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: sources,
    });
    expect(report).toMatchObject({ due: 0, outcome: null, paused: null });
    expect(calls.roster).toBeUndefined();
    expect(await t.db.select().from(trashSweepStatus)).toEqual([]);
  });

  it('an unsafe audit still throws, and the scheduled sweep records paused_audit_unsafe', async () => {
    await seedVerifiedWatchlistRegistry(t.db);
    const state = baseState({ collections: [pool()] });
    await expiredBatch(state);
    state.integrations.seerr = false;
    const { bundle } = makeMaintainerr(state);
    const { sources } = createStaticWatchlistSources({ ownerId: '1' });
    await expect(
      sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        registry: 'refresh',
        registrySources: sources,
        logger,
      }),
    ).rejects.toThrow(/not in a safe state/);
    expect((await getTrashSweepStatus({ db: t.db })).lastOutcome).toBe('paused_audit_unsafe');
  });

  it('Expedite refuses on a stale registry (nothing handled) and keeps a watchlisted target, never auto-saving it', async () => {
    const state = baseState({ collections: [pool()] });
    const { bundle, calls } = makeMaintainerr(state);
    await expect(
      expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        scope: 'all',
        media: 'movie',
        actorId: admin,
        snapshotMediaIds: ['ms-9001'],
        logger: silentDomainLogger,
      }),
    ).rejects.toBeInstanceOf(WatchlistRegistryUnverifiedError);
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);

    await seedVerifiedWatchlistRegistry(t.db, listingG2());
    const item = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'movie',
      actorId: admin,
      item: { collectionId: 7, maintainerrMediaId: 'ms-9002' },
      logger: silentDomainLogger,
    });
    expect(item).toMatchObject({ protectedCount: 1, expeditedCount: 0 });
    const all = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId: admin,
      snapshotMediaIds: ['ms-9001', 'ms-9002'],
      logger: silentDomainLogger,
    });
    expect(all).toMatchObject({ protectedCount: 1, expeditedCount: 1, expeditedIds: ['ms-9001'] });
    // A watchlist is not a Save: no exclusion was ever written for the watchlisted title.
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/rules/exclusion')).toBe(false);
    expect(state.exclusions.has('ms-9002')).toBe(false);
  });

  it('D-06 / D-24e: with NO snapshot every item is unevaluable (kept), never "not listed, deletable"', async () => {
    const { bundle } = makeMaintainerr(baseState({ collections: [pool()] }));
    const res = await listTrashPending({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      watchlist: null,
    });
    expect(res.items).toHaveLength(4);
    for (const item of res.items) {
      expect(item.watchlistEvaluable).toBe(false);
      expect(classifyGuardian(item).keep).toBe(true);
    }
    expect(classifyGuardian(res.items.find((i) => i.maintainerrMediaId === 'ms-9001')!)).toEqual({
      keep: true,
      reason: 'unevaluable',
    });
  });

  it('D-10: the batch wall carries the "On a watchlist" note and the keep reason', async () => {
    await seedVerifiedWatchlistRegistry(t.db, listingG2());
    const state = baseState({ collections: [pool()] });
    const { bundle } = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    const batchId = await expiredBatch(state);
    let detail = await getBatchDetail({ db: t.db, batchId });
    const noted = Object.fromEntries(
      detail.items.map((i) => [i.maintainerrMediaId, i.onWatchlist]),
    );
    expect(noted).toEqual({
      'ms-9001': false,
      'ms-9002': true,
      'ms-9003': false,
      'ms-9004': false,
    });
    await sweepExpiredBatches({ db: t.db, maintainerr: bundle, registry: 'gate-only', logger });
    detail = await getBatchDetail({ db: t.db, batchId });
    const kept = detail.items.find((i) => i.maintainerrMediaId === 'ms-9002')!;
    expect(kept).toMatchObject({ state: 'skipped', keepReason: 'watchlisted', onWatchlist: true });
    const gone = detail.items.find((i) => i.maintainerrMediaId === 'ms-9001')!;
    expect(gone).toMatchObject({ state: 'deleted', keepReason: null, onWatchlist: false });
  });

  it('D-08: the space policy counts deletable candidates only (not watchlisted, not dnd)', async () => {
    await seedVerifiedWatchlistRegistry(t.db, listingG2());
    await setAppSetting({
      db: t.db,
      key: 'space_targets',
      value: { haynestower: 80 },
      actorId: admin,
    });
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        enabled: true,
        mode: 'continuous',
        minCandidates: 4,
        perArray: { haynestower: { enabled: true } },
        perKind: defaultPerKind(),
      },
      actorId: admin,
    });
    const TB = 1_000_000_000_000;
    const disk = [{ path: '/data/haynestower', freeSpace: 100 * TB, totalSpace: 1000 * TB }];
    const fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/diskspace')
        ? new Response(JSON.stringify(disk), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{}', { status: 404 });
    }) as typeof fetch;
    const opts = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
    const arr = buildArrClientBundle({
      sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
      radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
      lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
      bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
    });
    const { bundle } = makeMaintainerr(baseState({ collections: [pool()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr,
      actorId: admin,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie).toMatchObject({ outcome: 'skipped_min_candidates', candidateCount: 3 });
    const open = await t.db
      .select()
      .from(trashBatches)
      .where(and(eq(trashBatches.mediaKind, 'movie'), eq(trashBatches.state, 'leaving_soon')));
    expect(open).toEqual([]);
  });
});
