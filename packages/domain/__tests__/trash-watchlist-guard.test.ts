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
// - the batch wall: the "On a watchlist" note and the keep reason (D-10), matched through the candidate read-model's
//   plex guid (a title known only by discover id), never on a deleted row (D-25w);
// - AC-33: a TV pool, a show listed by its discover id or by its tvdb id, kept by the sweep and by Expedite.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  trashSweepStatus,
  watchAccounts,
  watchMarks,
  watchlistRegistryAccounts,
  watchlistRegistryRuns,
} from '@hnet/db/schema';
import {
  WatchlistRegistryUnverifiedError,
  cancelBatch,
  classifyGuardian,
  createBatchFromPending,
  createStaticWatchlistSources,
  evaluateSpacePolicy,
  expediteDeletion,
  getBatchDetail,
  getTrashSweepStatus,
  listTrashPending,
  listTrashPendingPage,
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
  createStaticReleaseBlockArr,
} from '../src/index';
import {
  baseState,
  makeMaintainerr,
  movieCollection,
  tvCollection,
  type MaintState,
} from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

/** ADR-093 / DESIGN-052 D-14 — the in-memory Release Block *arr (every item synthesized recordable). */
const { arr: releaseArr } = createStaticReleaseBlockArr();

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
    // AC-33 — a TV pool (three shows) for the series cases.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [8001, 8002, 8003].map((tvdbId, i) => ({
        arrItemId: i + 1,
        tvdbId,
        title: `Show ${tvdbId}`,
        sortTitle: `show ${tvdbId}`,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/tv',
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
    await t.db.delete(watchMarks);
    await t.db.delete(watchAccounts);
    await t.db.delete(trashDeletedReleases);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: admin });
  });

  /** D-19 — the owner says "add it to my watchlist" (a Watchlist Change, ADR-092), at `at`. */
  async function ownerAdds(guid: string, at = new Date()) {
    await t.db
      .insert(watchAccounts)
      .values({ plexAccountId: 1, username: 'owner', role: 'owner' })
      .onConflictDoNothing();
    await t.db.insert(watchMarks).values({
      plexAccountId: 1,
      action: 'watchlist_add',
      scope: 'movie',
      titleKey: `plex:plex://movie/${guid}`,
      kind: 'movie',
      title: 'x',
      plexGuid: `plex://movie/${guid}`,
      query: 'q',
      consumer: 'hop',
      plexResult: 'pending',
      createdAt: at,
    });
  }

  /** Create a leaving_soon batch of the whole pool and close its window. */
  async function expiredBatch(
    state: MaintState,
    targeting?: { maxItems: number },
    mediaKind: 'movie' | 'tv' = 'movie',
  ) {
    const { bundle } = makeMaintainerr(state);
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind,
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
      arr: releaseArr,
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
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'gate-only',
      logger,
    });
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
      arr: releaseArr,
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
      arr: releaseArr,
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
      arr: releaseArr,
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

  it('D-19 / D-25ay: a watchlist add made WHILE the sweep runs keeps every item the loop has not reached yet', async () => {
    await seedVerifiedWatchlistRegistry(t.db);
    const state = baseState({ collections: [pool()] });
    const batchId = await expiredBatch(state);
    // The owner adds ms-9003 (G3) to his watchlist while ms-9001 is being deleted: after the gate's snapshot.
    state.onHandle = async (ms) => {
      if (ms === 'ms-9001') await ownerAdds(G3);
    };
    const { bundle, calls } = makeMaintainerr(state);
    const { arr, fixture } = createStaticReleaseBlockArr();
    const report = await sweepExpiredBatches({
      arr,
      db: t.db,
      maintainerr: bundle,
      registry: 'gate-only',
      logger,
    });
    expect(await itemStates(batchId)).toMatchObject({
      'ms-9001': { state: 'deleted' },
      'ms-9002': { state: 'deleted' },
      'ms-9003': { state: 'skipped', keepReason: 'watchlisted' },
    });
    expect(
      calls
        .filter((c) => c.pathname === '/collections/media/handle')
        .map((c) => (c.body as { mediaId: string }).mediaId),
    ).toEqual(['ms-9001', 'ms-9002']);
    expect(report.batches[0]!.keptByReason).toMatchObject({ watchlisted: 1 });
    // Its release record is abandoned and its term leaves the profile (it was never deleted).
    const recs = await t.db.select().from(trashDeletedReleases);
    const kept = recs.find((r) => r.arrItemId === 3)!;
    expect(kept.state).toBe('abandoned');
    expect(fixture.profiles.radarr[0]!.ignored).not.toContain(kept.term);
  });

  it('D-19 / D-25ay: Expedite all re-reads the owner`s watchlist adds before each delete', async () => {
    await seedVerifiedWatchlistRegistry(t.db);
    const state = baseState({ collections: [pool()] });
    state.onHandle = async (ms) => {
      if (ms === 'ms-9001') await ownerAdds(G2);
    };
    const { bundle } = makeMaintainerr(state);
    const res = await expediteDeletion({
      arr: createStaticReleaseBlockArr().arr,
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId: admin,
      snapshotMediaIds: ['ms-9001', 'ms-9002', 'ms-9003'],
      logger,
    });
    expect(res).toMatchObject({ expeditedIds: ['ms-9001', 'ms-9003'], protectedCount: 1 });
    expect(logs.some((l) => l.msg === '[trash] kept' && l.fields?.reason === 'watchlisted')).toBe(true);
  });

  it('D-10 / D-25v: after 6 hours the banner names each reason (the Release Block; an unsafe audit or a down *arr read "the media apps")', async () => {
    const t0 = new Date();
    const at6h = new Date(t0.getTime() + 6 * 3_600_000);
    const scheduled = async (arr: ReturnType<typeof createStaticReleaseBlockArr>['arr'], state: MaintState) =>
      sweepExpiredBatches({
        arr,
        db: t.db,
        maintainerr: makeMaintainerr(state).bundle,
        registry: 'refresh',
        registrySources: createStaticWatchlistSources({ ownerId: '1' }).sources,
        logger,
        now: () => t0,
      });
    const reset = async () => {
      await t.db.delete(trashBatches);
      await t.db.delete(trashSweepStatus);
      await t.db.delete(trashDeletedReleases);
    };

    // The Release Block could not be written.
    let state = baseState({ collections: [pool()] });
    await expiredBatch(state);
    const failingWrite = createStaticReleaseBlockArr({ fail: new Set(['radarr:create']) }).arr;
    expect((await scheduled(failingWrite, state)).outcome).toBe('paused_release_block');
    expect((await getTrashSweepStatus({ db: t.db, now: at6h })).banner).toBe('release_block');
    await reset();

    // Radarr did not answer three identity reads in a row.
    state = baseState({ collections: [pool()] });
    await expiredBatch(state);
    const downArr = createStaticReleaseBlockArr({ fail: new Set(['radarr:find']) }).arr;
    expect((await scheduled(downArr, state)).outcome).toBe('aborted_arr');
    expect((await getTrashSweepStatus({ db: t.db, now: at6h })).banner).toBe('media_apps');
    await reset();

    // Maintainerr's audit is unsafe.
    state = baseState({ collections: [pool()] });
    await expiredBatch(state);
    state.integrations.seerr = false;
    await expect(scheduled(releaseArr, state)).rejects.toThrow(/not in a safe state/);
    const unsafe = await getTrashSweepStatus({ db: t.db, now: at6h });
    expect(unsafe).toMatchObject({ lastOutcome: 'paused_audit_unsafe', banner: 'media_apps' });
    // …and never before 6 hours.
    expect((await getTrashSweepStatus({ db: t.db, now: new Date(at6h.getTime() - 60_000) })).banner).toBeNull();
  });

  it('D-25cg: a scheduled sweep that throws for any other reason records aborted_arr (error), so the banner shows after 6 h', async () => {
    const state = baseState({ collections: [pool()] });
    const batchId = await expiredBatch(state);
    const t0 = new Date();
    const scheduled = (now: Date) =>
      sweepExpiredBatches({
        arr: releaseArr,
        db: t.db,
        maintainerr: makeMaintainerr(state).bundle,
        registry: 'refresh',
        registrySources: createStaticWatchlistSources({ ownerId: '1' }).sources,
        logger,
        now: () => now,
      });
    // Maintainerr answers the audit but its pending crawl fails every hour.
    state.fail.add('GET /collections/media/7/content/1');
    for (let h = 0; h < 7; h += 1) {
      await expect(scheduled(new Date(t0.getTime() + h * 3_600_000))).rejects.toThrow();
    }
    const status = await getTrashSweepStatus({ db: t.db, now: new Date(t0.getTime() + 7 * 3_600_000) });
    expect(status).toMatchObject({ lastOutcome: 'aborted_arr', lastReason: 'error', banner: 'media_apps' });
    expect(status.pausedSince).toBe(t0.toISOString());
    const paused = logs.filter((l) => l.msg === '[trash] sweep_paused');
    expect(paused.at(-1)?.fields).toMatchObject({ reason: 'arr', step: 'error', pausedForH: 6 });
    expect(logs.some((l) => l.msg === '[trash] sweep_failed')).toBe(true);
    expect((await itemStates(batchId))['ms-9001']!.state).toBe('pending');
    // The next ok sweep clears it.
    state.fail.clear();
    await seedVerifiedWatchlistRegistry(t.db);
    const ok = await scheduled(new Date(t0.getTime() + 8 * 3_600_000));
    expect(ok.outcome).toBe('ok');
    expect(await getTrashSweepStatus({ db: t.db, now: new Date(t0.getTime() + 8 * 3_600_000) })).toMatchObject({
      lastOutcome: 'ok',
      pausedSince: null,
      banner: null,
    });
  });

  it('D-25bf: a pause ends when its batch leaves another way (cancelled), and after a clean manual Expire now', async () => {
    const state = baseState({ collections: [pool()] });
    const batchId = await expiredBatch(state);
    const { bundle } = makeMaintainerr(state);
    const t0 = new Date();
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: createStaticWatchlistSources({ ownerId: '1', rosterFails: true }).sources,
      logger,
      now: () => t0,
    });
    expect((await getTrashSweepStatus({ db: t.db, now: new Date(t0.getTime() + 7 * 3_600_000) })).banner).toBe(
      'gate',
    );
    await cancelBatch({ db: t.db, maintainerr: bundle, batchId, actorId: admin });
    const { sources, calls } = createStaticWatchlistSources({ ownerId: '1' });
    const nothing = await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: sources,
      logger,
      now: () => new Date(t0.getTime() + 7 * 3_600_000),
    });
    expect(nothing).toMatchObject({ due: 0, outcome: null });
    expect(calls.roster).toBeUndefined(); // still nothing else is done
    const later = await getTrashSweepStatus({ db: t.db, now: new Date(t0.getTime() + 30 * 86_400_000) });
    expect(later).toMatchObject({ lastOutcome: 'paused_gate', pausedSince: null, banner: null });
    expect(logs.some((l) => l.msg === '[trash] sweep_pause_cleared' && l.fields?.via === 'nothing_due')).toBe(
      true,
    );

    // Paused again; then an admin's Expire now of that batch succeeds (gate-only): the pause ends too.
    const second = await expiredBatch(state);
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'refresh',
      registrySources: createStaticWatchlistSources({ ownerId: '1', rosterFails: true }).sources,
      logger,
      now: () => t0,
    });
    expect((await getTrashSweepStatus({ db: t.db })).pausedSince).not.toBeNull();
    await seedVerifiedWatchlistRegistry(t.db);
    const manual = await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'gate-only',
      batchId: second,
      actorId: admin,
      logger,
    });
    expect(manual.paused).toBeNull();
    expect(await getTrashSweepStatus({ db: t.db, now: new Date(t0.getTime() + 30 * 86_400_000) })).toMatchObject({
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
      arr: releaseArr,
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
      arr: releaseArr,
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
        arr: releaseArr,
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
        arr: releaseArr,
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
      arr: releaseArr,
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
      arr: releaseArr,
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
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'gate-only',
      logger,
    });
    detail = await getBatchDetail({ db: t.db, batchId });
    const kept = detail.items.find((i) => i.maintainerrMediaId === 'ms-9002')!;
    expect(kept).toMatchObject({ state: 'skipped', keepReason: 'watchlisted', onWatchlist: true });
    const gone = detail.items.find((i) => i.maintainerrMediaId === 'ms-9001')!;
    expect(gone).toMatchObject({ state: 'deleted', keepReason: null, onWatchlist: false });

    // D-25w — a DELETED row never carries the note, even once its own title is on a list again (G1 listed now);
    // a kept row of the same listing still does.
    await seedVerifiedWatchlistRegistry(t.db, {
      ownerId: '1',
      owner: [
        { discoverId: G1, kind: 'movie', tmdbId: 9001 },
        { discoverId: G2, kind: 'movie', tmdbId: 9002 },
      ],
    });
    detail = await getBatchDetail({ db: t.db, batchId });
    const byId = Object.fromEntries(detail.items.map((i) => [i.maintainerrMediaId, i]));
    expect(byId['ms-9001']).toMatchObject({ state: 'deleted', onWatchlist: false });
    expect(byId['ms-9002']).toMatchObject({ state: 'skipped', onWatchlist: true });
  });

  it('D-10: the note is matched through the candidate read-model`s plex guid (a title known only by discover id)', async () => {
    // G2 is listed by discover id ONLY (no tmdb id, its discover lookup 404s), next to another unmapped title: the
    // plex guid joined from trash_candidates is the only way to match ms-9002, and without it every item turns not
    // evaluable (an unmapped entry of the kind, D-06).
    const GX = '5d776824151a60001f24ffff';
    await seedVerifiedWatchlistRegistry(t.db, {
      ownerId: '1',
      owner: [
        { discoverId: G2, kind: 'movie' },
        { discoverId: GX, kind: 'movie' },
      ],
    });
    const state = baseState({ collections: [pool()] });
    const { bundle } = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });

    // The pending wall, the Expedite preview (materializeSnapshotPending → readCandidateSnapshot).
    const page = await listTrashPendingPage({ db: t.db, maintainerr: bundle, media: 'movie', limit: 10, offset: 0 });
    const byId = Object.fromEntries(page.items.map((i) => [i.maintainerrMediaId, i]));
    expect(byId['ms-9002']).toMatchObject({ onWatchlist: true, watchlistEvaluable: true });
    expect(byId['ms-9001']).toMatchObject({ onWatchlist: false, watchlistEvaluable: true });
    expect(page.expeditePreview).toMatchObject({ watchlisted: 1, unverifiable: 0 });

    // The batch wall (getBatchDetail's own join).
    const batchId = await expiredBatch(state);
    const detail = await getBatchDetail({ db: t.db, batchId });
    expect(
      Object.fromEntries(detail.items.map((i) => [i.maintainerrMediaId, i.onWatchlist])),
    ).toMatchObject({ 'ms-9001': false, 'ms-9002': true, 'ms-9003': false });
  });

  // AC-33 — "a show on a list keeps its series": the TV pool, matched by the show's discover id and by its tvdb id.
  describe('a TV pool (AC-33)', () => {
    const S1 = '5d9c086fe9d5a1001f4d0001';
    const S2 = '5d9c086fe9d5a1001f4d0002';
    const S3 = '5d9c086fe9d5a1001f4d0003';
    const SX = '5d9c086fe9d5a1001f4d00ff';
    const tvPool = () =>
      tvCollection({
        items: [
          { mediaServerId: 'ms-8001', tvdbId: 8001, sizeBytes: 6_000, addDate: '2026-06-01T00:00:00Z', mediaData: { guid: `plex://show/${S1}` } },
          { mediaServerId: 'ms-8002', tvdbId: 8002, sizeBytes: 5_000, addDate: '2026-06-01T00:00:00Z', mediaData: { guid: `plex://show/${S2}` } },
          { mediaServerId: 'ms-8003', tvdbId: 8003, sizeBytes: 4_000, addDate: '2026-06-01T00:00:00Z', mediaData: { guid: `plex://show/${S3}` } },
        ],
      });
    /** ms-8001 listed by its discover id (the list's tvdb id differs); ms-8002 by its tvdb id only (another id). */
    const showListing = (): StaticWatchlistFixture => ({
      ownerId: '1',
      owner: [
        { discoverId: S1, kind: 'show', tvdbId: 7777 },
        { discoverId: SX, kind: 'show', tvdbId: 8002 },
      ],
    });
    const handledIds = (calls: Array<{ method: string; pathname: string; body: unknown }>) =>
      calls
        .filter((c) => c.method === 'POST' && c.pathname === '/collections/media/handle')
        .map((c) => (c.body as { mediaId: string }).mediaId);

    it('the sweep keeps both listed shows (`watchlisted`) and deletes only the unlisted one', async () => {
      const state = baseState({ collections: [tvPool()] });
      const batchId = await expiredBatch(state, undefined, 'tv');
      const { bundle, calls } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        arr: releaseArr,
        db: t.db,
        maintainerr: bundle,
        registry: 'refresh',
        registrySources: createStaticWatchlistSources(showListing()).sources,
        logger,
      });
      expect(report.outcome).toBe('ok');
      expect(await itemStates(batchId)).toEqual({
        'ms-8001': { state: 'skipped', keepReason: 'watchlisted' },
        'ms-8002': { state: 'skipped', keepReason: 'watchlisted' },
        'ms-8003': { state: 'deleted', keepReason: null },
      });
      expect(handledIds(calls)).toEqual(['ms-8003']);
    });

    it('Expedite item and all protect both listed shows; the pending wall notes them', async () => {
      await seedVerifiedWatchlistRegistry(t.db, showListing());
      const state = baseState({ collections: [tvPool()] });
      const { bundle, calls } = makeMaintainerr(state);
      await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
      const page = await listTrashPendingPage({ db: t.db, maintainerr: bundle, media: 'tv', limit: 10, offset: 0 });
      expect(
        Object.fromEntries(page.items.map((i) => [i.maintainerrMediaId, i.onWatchlist])),
      ).toEqual({ 'ms-8001': true, 'ms-8002': true, 'ms-8003': false });
      const one = await expediteDeletion({
        arr: releaseArr,
        db: t.db,
        maintainerr: bundle,
        scope: 'item',
        media: 'tv',
        actorId: admin,
        item: { collectionId: 8, maintainerrMediaId: 'ms-8001' },
        logger: silentDomainLogger,
      });
      expect(one).toMatchObject({ protectedCount: 1, expeditedCount: 0 });
      const all = await expediteDeletion({
        arr: releaseArr,
        db: t.db,
        maintainerr: bundle,
        scope: 'all',
        media: 'tv',
        actorId: admin,
        snapshotMediaIds: ['ms-8001', 'ms-8002', 'ms-8003'],
        logger: silentDomainLogger,
      });
      expect(all).toMatchObject({ protectedCount: 2, expeditedIds: ['ms-8003'] });
      expect(handledIds(calls)).toEqual(['ms-8003']);
    });
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
