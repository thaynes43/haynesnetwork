// ADR-031 / DESIGN-014 (PLAN-014); ADR-073 (2026-07-18) — the SPACE-DRIVEN POLICY orchestrator (embedded
// PG16 + fetch-stubbed *arr /diskspace + fetch-stubbed Maintainerr). Proves the AUTONOMOUS evaluation
// MATRIX (over/under target · disabled · per-array off · open-batch skip · min-candidates · empty), the
// auto-promote to leaving_soon (no admin-review gate, no cooldown), the SELF-HEAL of a stuck batch
// (the prod stall), the trash_space_policy ledger event + space_policy notification writes, the settings
// audit, and the ledger-derived status read.
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  ledgerEvents,
  mediaItems,
  notifications,
  permissionAudit,
  trashBatchItems,
  trashBatches,
} from '@hnet/db/schema';
import {
  DYNAMIC_PACE_CEILING_BYTES,
  DYNAMIC_PACE_FLOOR_BYTES,
  DYNAMIC_PACE_HORIZON_DAYS,
  buildArrClientBundle,
  createBatchFromPending,
  defaultPerKind,
  evaluateSpacePolicy,
  getSpacePolicy,
  getSpacePolicyStatus,
  measureTrashYield,
  recordedSweepDeletions,
  measureDeletableSnapshotPools,
  forecastQueryRange,
  saveExclusion,
  setAppSetting,
  type ArrClientBundle,
  type SpacePolicy,
} from '../src/index';
import * as trashFlow from '../src/trash-flow';
import { baseState, makeMaintainerr, movieCollection, tvCollection } from './maintainerr-stub';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const TB = 1_000_000_000_000;

// --- *arr /diskspace stub (from the storage-metrics test) --------------------------------------------
type DiskSpec = { path: string; freeSpace: number; totalSpace: number }[] | 'fail';
function makeArrBundle(cfg: {
  radarr?: DiskSpec;
  sonarr?: DiskSpec;
  lidarr?: DiskSpec;
}): ArrClientBundle {
  const byHost: Record<string, DiskSpec | undefined> = {
    'radarr.test': cfg.radarr,
    'sonarr.test': cfg.sonarr,
    'lidarr.test': cfg.lidarr,
  };
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/diskspace')) {
      const spec = byHost[url.hostname];
      if (spec === 'fail' || spec === undefined)
        return new Response('{"m":"down"}', { status: 500 });
      return new Response(JSON.stringify(spec), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"m":"no stub"}', { status: 404 });
  }) as typeof fetch;
  const opts = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  return buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
    radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
  });
}

// HaynesTower at 90% used (100 free / 1000 total) — OVER an 80% target; and at 70% — UNDER.
const TOWER_OVER: DiskSpec = [
  { path: '/data/haynestower', freeSpace: 100 * TB, totalSpace: 1000 * TB },
];
const TOWER_UNDER: DiskSpec = [
  { path: '/data/haynestower', freeSpace: 300 * TB, totalSpace: 1000 * TB },
];
const MUSIC: DiskSpec = [{ path: '/data/cephfs-hdd', freeSpace: 130 * TB, totalSpace: 175 * TB }];

const overBundle = () => makeArrBundle({ radarr: TOWER_OVER, sonarr: TOWER_OVER, lidarr: MUSIC });
const underBundle = () =>
  makeArrBundle({ radarr: TOWER_UNDER, sonarr: TOWER_UNDER, lidarr: MUSIC });

const ENABLED: SpacePolicy = {
  enabled: true,
  mode: 'over-target',
  minCandidates: 1,
  perArray: { haynestower: { enabled: true } },
  perKind: defaultPerKind(),
};

/** ENABLED with the movie kind's caps overridden (DESIGN-014 amendment 2026-07-09, build A). */
const withMovieCaps = (movie: Partial<SpacePolicy['perKind']['movie']>): SpacePolicy => ({
  ...ENABLED,
  perKind: { ...defaultPerKind(), movie: { ...defaultPerKind().movie, ...movie } },
});

describe('evaluateSpacePolicy (ADR-031 — propose-only, never deletes)', () => {
  let t: TestDb;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (
      await createUser(t.db, { email: 'policy-admin@example.com', displayName: 'Policy Admin' })
    ).id;
    await setAppSetting({ db: t.db, key: 'space_targets', value: { haynestower: 80 }, actorId });
  });
  afterAll(async () => t?.stop());

  // Clean slate between tests (in packages/domain — the no-direct-writes guard does not apply here).
  beforeEach(async () => {
    await setAppSetting({ db: t.db, key: 'trash_default_window_days', value: 7, actorId });
    await setAppSetting({ db: t.db, key: 'space_targets', value: { haynestower: 80 }, actorId });
    await t.db.delete(trashBatches); // cascades items + saves
    await t.db
      .delete(ledgerEvents)
      .where(
        inArray(ledgerEvents.eventType, [
          'trash_space_policy',
          'trash_batch_transition',
          'trash_restored',
        ]),
      );
    await t.db.delete(notifications);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: false, actorId });
  });
  afterEach(async () => {
    await t.db.delete(trashBatches);
    await t.db.delete(mediaItems);
  });

  const setPolicy = (p: SpacePolicy) =>
    setAppSetting({ db: t.db, key: 'space_policy', value: p, actorId });

  it('over target + enabled + candidates → PROPOSES AND PROMOTES a movie batch (leaving_soon) + event + notification', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });

    expect(report.enabled).toBe(true);
    expect(report.proposedCount).toBe(1);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.overTarget).toBe(true);
    expect(tower.usedPct).toBe(90);
    expect(tower.target).toBe(80);

    const movie = tower.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('proposed');
    expect(movie.batchId).not.toBeNull();
    // ADR-073 — the autonomous engine promotes its own batch straight to Leaving Soon (gate_skipped).
    expect(movie.gateSkipped).toBe(true);
    expect(movie.candidateCount).toBe(3);
    // No TV rule collection ⇒ the TV kind proposes nothing (empty), NOT an error.
    expect(tower.proposals.find((p) => p.mediaKind === 'tv')!.outcome).toBe('skipped_empty');
    // CephFS (music) has no target and no batchable kinds — no proposals.
    expect(report.arrays.find((a) => a.key === 'cephfs')!.proposals).toEqual([]);

    // The batch went STRAIGHT to leaving_soon with the save window open (no admin-review gate, ADR-073).
    const [batch] = await t.db
      .select()
      .from(trashBatches)
      .where(eq(trashBatches.id, movie.batchId!));
    expect(batch!.state).toBe('leaving_soon');
    expect(batch!.gateSkipped).toBe(true);
    expect(batch!.expiresAt).not.toBeNull();
    expect(batch!.mediaKind).toBe('movie');

    // The WHY: a trash_space_policy ledger event carrying the array/usedPct/target/candidates.
    const [evt] = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_space_policy'));
    const payload = evt!.payload as Record<string, unknown>;
    expect(payload.batchId).toBe(movie.batchId);
    expect(payload.mediaKind).toBe('movie');
    expect(payload.array).toBe('haynestower');
    expect(payload.usedPct).toBe(90);
    expect(payload.target).toBe(80);
    expect(payload.candidateCount).toBe(3);

    // The Activity/Bulletin notification (source 'trash', type 'space_policy').
    const [note] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'space_policy'));
    expect(note!.source).toBe('trash');
    expect(note!.title).toContain('Movies');
  });

  it('heals an open leaving_soon batch whose Maintainerr record vanished (re-drives + re-points on the tick)', async () => {
    await setPolicy(ENABLED);
    const state = baseState({ collections: [movieCollection()] });
    const { bundle } = makeMaintainerr(state);
    // Tick 1: proposes + promotes — the drive creates the Leaving-Soon record (id 555) + its shell.
    const first = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const batchId = first.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!.batchId!;
    const [before] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(before!.maintainerrCollectionId).toBe(555);

    // The record vanishes underneath the live batch (a manual delete in Maintainerr's UI;
    // historically the nightly rule-less purge).
    state.collections = state.collections.filter((c) => c.id !== 555);
    state.ruleGroups = state.ruleGroups.filter((g) => g.collectionId !== 555);

    // Tick 2: the open batch is left alone BUT its collection is healed — re-driven + re-pointed.
    const second = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const proposal = second.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(proposal.outcome).toBe('skipped_open_batch');
    expect(proposal.reason).toContain('Re-drove its missing Leaving-Soon collection');
    const [after] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(after!.state).toBe('leaving_soon');
    expect(after!.maintainerrCollectionId).toBe(556);
    const healed = state.collections.find((c) => c.id === 556);
    expect(healed?.title).toBe('Leaving Soon — Movies');
    expect(state.ruleGroups.some((g) => g.collectionId === 556)).toBe(true);
  });

  // ── per-kind composition caps (DESIGN-014 amendment 2026-07-09, build A) ─────────────────────
  // movieCollection: 9001(4e9), 9002(3e9), 9003(2e9), all UNRATED — so worst-rated (the policy default)
  // ranks by size desc (unrated tie-break), i.e. 9001 → 9002 → 9003.
  const proposeMovie = async (policy: SpacePolicy) => {
    await setPolicy(policy);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    return report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
  };
  const batchIds = async (batchId: string) =>
    (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId)))
      .map((i) => i.maintainerrMediaId)
      .sort();

  it('per-kind targetBytes cap trims the batch to the reclaim target (worst-rated/size-first)', async () => {
    // Target 6e9 ⇒ 4e9+3e9 crosses ⇒ {9001,9002} (the crossing item is included).
    const movie = await proposeMovie(
      withMovieCaps({ targetBytes: { enabled: true, value: 6_000_000_000 } }),
    );
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(2);
    expect(await batchIds(movie.batchId!)).toEqual(['ms-9001', 'ms-9002']);
  });

  it('per-kind maxItems cap trims the batch to the item count', async () => {
    const movie = await proposeMovie(withMovieCaps({ maxItems: { enabled: true, value: 2 } }));
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(2);
    expect(await batchIds(movie.batchId!)).toEqual(['ms-9001', 'ms-9002']);
  });

  it('both caps combine — the batch stops at the FIRST cap hit (maxItems 1 beats a 6e9 target)', async () => {
    const movie = await proposeMovie(
      withMovieCaps({
        maxItems: { enabled: true, value: 1 },
        targetBytes: { enabled: true, value: 6_000_000_000 },
      }),
    );
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(1); // maxItems:1 hits before the 6e9 target (4e9)
    expect(await batchIds(movie.batchId!)).toEqual(['ms-9001']);
  });

  it('a DISABLED cap is ignored — the whole pool is proposed', async () => {
    const movie = await proposeMovie(
      withMovieCaps({
        maxItems: { enabled: false, value: 1 },
        targetBytes: { enabled: false, value: 1 },
      }),
    );
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(3); // both caps off ⇒ all three
  });

  it('proposes BOTH movie and tv when both rule collections have candidates', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(
      baseState({ collections: [movieCollection(), tvCollection()] }),
    );
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    expect(report.proposedCount).toBe(2);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.proposals.find((p) => p.mediaKind === 'movie')!.outcome).toBe('proposed');
    expect(tower.proposals.find((p) => p.mediaKind === 'tv')!.outcome).toBe('proposed');
    const kinds = await t.db.select({ k: trashBatches.mediaKind }).from(trashBatches);
    expect(new Set(kinds.map((r) => r.k))).toEqual(new Set(['movie', 'tv']));
  });

  it('UNDER target (over-target mode) → nothing proposed (skipped_under_target), no batch created', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: underBundle(),
      actorId,
    });
    expect(report.proposedCount).toBe(0);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.overTarget).toBe(false);
    expect(tower.usedPct).toBe(70);
    // Opted in but under target ⇒ each kind reports skipped_under_target (no NEW batch), never []).
    expect(tower.proposals.find((p) => p.mediaKind === 'movie')!.outcome).toBe(
      'skipped_under_target',
    );
    expect(tower.proposals.find((p) => p.mediaKind === 'tv')!.outcome).toBe('skipped_under_target');
    expect(await t.db.select().from(trashBatches)).toHaveLength(0);
  });

  it('DISABLED policy → a no-op run (no utilization read, no proposals, no writes)', async () => {
    await setPolicy({ ...ENABLED, enabled: false });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    expect(report.enabled).toBe(false);
    expect(report.proposedCount).toBe(0);
    expect(report.arrays).toEqual([]);
    expect(await t.db.select().from(trashBatches)).toHaveLength(0);
  });

  it('per-array OFF (global on) → array reported but never proposes', async () => {
    await setPolicy({ ...ENABLED, perArray: { haynestower: { enabled: false } } });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    expect(report.proposedCount).toBe(0);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.enabled).toBe(false);
    expect(tower.overTarget).toBe(true); // still over — it just isn't opted in
    expect(tower.proposals).toEqual([]);
  });

  it('open batch for the kind → skipped_open_batch (idempotence, no error, no duplicate)', async () => {
    await setPolicy(ENABLED);
    // Seed an OPEN movie batch directly (the one-open-per-kind slot is taken).
    await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'admin_review', createdBy: actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    expect(report.proposedCount).toBe(0);
    expect(await t.db.select().from(trashBatches)).toHaveLength(1); // no second batch created
  });

  it('SELF-HEAL (ADR-073) → a system batch stuck in admin_review is promoted to leaving_soon on the next run', async () => {
    // Reproduces the prod stall (2026-07-18): a policy-created batch left sitting in admin_review because
    // the old flow required a human green-light. The autonomous engine must converge it on the next tick.
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    // A SYSTEM batch (createdBy null via actorId:null) proposed by the OLD flow → admin_review, stuck.
    const stuck = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId: null,
    });
    expect(stuck.state).toBe('admin_review');
    expect(stuck.gateSkipped).toBe(false);

    // Next run: no cooldown, no admin gate — the stuck batch self-heals to leaving_soon.
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('promoted');
    expect(movie.batchId).toBe(stuck.batchId);
    expect(report.proposedCount).toBe(1);

    const [batch] = await t.db
      .select()
      .from(trashBatches)
      .where(eq(trashBatches.id, stuck.batchId));
    expect(batch!.state).toBe('leaving_soon');
    expect(batch!.gateSkipped).toBe(true);
    expect(batch!.expiresAt).not.toBeNull();
    // Idempotence: no duplicate batch was created — the one stuck batch is now the one open batch.
    const open = await t.db
      .select()
      .from(trashBatches)
      .where(inArray(trashBatches.state, ['draft', 'admin_review', 'leaving_soon']));
    expect(open).toHaveLength(1);
  });

  it('SELF-HEAL does NOT touch a MANUAL admin_review batch (createdBy set) — left for the admin', async () => {
    await setPolicy(ENABLED);
    // A human-created admin_review batch (createdBy = a real user) is the admin's to curate.
    await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'admin_review', createdBy: actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    const [batch] = await t.db
      .select()
      .from(trashBatches)
      .where(eq(trashBatches.mediaKind, 'movie'));
    expect(batch!.state).toBe('admin_review'); // untouched
  });

  it('a healthy open leaving_soon batch is left alone (skipped_open_batch, no duplicate)', async () => {
    await setPolicy(ENABLED);
    await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'leaving_soon', createdBy: null });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    expect(report.proposedCount).toBe(0);
    expect(await t.db.select().from(trashBatches)).toHaveLength(1);
  });

  it('min-candidates → too few pending is skipped', async () => {
    await setPolicy({ ...ENABLED, minCandidates: 10 }); // the movie collection has only 3
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_min_candidates');
    expect(movie.candidateCount).toBe(3);
    expect(report.proposedCount).toBe(0);
  });

  it('an unenforced Save does not satisfy the minimum or contribute candidate bytes', async () => {
    await setPolicy({ ...ENABLED, minCandidates: 3 });
    const state = baseState({ collections: [movieCollection()] });
    const { bundle } = makeMaintainerr(state);
    const [saved] = await t.db
      .insert(mediaItems)
      .values({
        arrKind: 'radarr',
        arrItemId: 1,
        tmdbId: 9001,
        title: 'Saved movie',
        sortTitle: 'saved movie',
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      })
      .returning();
    state.fail.add('GET /rules/exclusion');
    const save = await saveExclusion({
      db: t.db,
      maintainerr: bundle,
      mediaItemId: saved!.id,
      maintainerrMediaId: 'ms-9001',
      actorId,
    });
    state.fail.clear();
    expect(save).toMatchObject({ recorded: true, exclusion: 'pending' });
    expect(state.exclusions.has('ms-9001')).toBe(false);

    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie).toMatchObject({
      outcome: 'skipped_min_candidates',
      candidateCount: 2,
      candidateBytes: 5_000_000_000,
    });
    expect(report.proposedCount).toBe(0);
    expect(await t.db.select().from(trashBatches)).toHaveLength(0);
    expect(
      await t.db
        .select()
        .from(ledgerEvents)
        .where(eq(ledgerEvents.eventType, 'trash_space_policy')),
    ).toHaveLength(0);
    expect(
      await t.db.select().from(notifications).where(eq(notifications.type, 'space_policy')),
    ).toHaveLength(0);

    // Lowering the minimum admits the same two unsaved titles; the pending Save still takes no slot.
    await setPolicy({ ...ENABLED, minCandidates: 2 });
    const next = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const proposed = next.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(proposed).toMatchObject({
      outcome: 'proposed',
      candidateCount: 2,
      candidateBytes: 5_000_000_000,
    });
    expect(await batchIds(proposed.batchId!)).toEqual(['ms-9002', 'ms-9003']);
  });

  it('skip-gate ON → the proposed batch flows straight to leaving_soon (not special-cased)', async () => {
    await setPolicy(ENABLED);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('proposed');
    expect(movie.gateSkipped).toBe(true);
    const [batch] = await t.db
      .select()
      .from(trashBatches)
      .where(eq(trashBatches.id, movie.batchId!));
    expect(batch!.state).toBe('leaving_soon');
    expect(batch!.gateSkipped).toBe(true);
  });

  // ── continuous mode (DESIGN-014 amendment 2026-07-09, build A) ───────────────────────────────
  const CONTINUOUS: SpacePolicy = { ...ENABLED, mode: 'continuous' };

  it('continuous mode PROPOSES under target (the disk target is not required)', async () => {
    await setPolicy(CONTINUOUS);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    // underBundle ⇒ 70% used, UNDER the 80% target — over-target mode would skip; continuous proposes.
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: underBundle(),
      actorId,
    });
    expect(report.proposedCount).toBe(1);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.overTarget).toBe(false); // utilization is still read for reporting
    expect(tower.usedPct).toBe(70);
    expect(tower.proposals.find((p) => p.mediaKind === 'movie')!.outcome).toBe('proposed');
  });

  it('continuous mode STILL requires the array to be opted in (per-array off ⇒ no proposal)', async () => {
    await setPolicy({ ...CONTINUOUS, perArray: { haynestower: { enabled: false } } });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: underBundle(),
      actorId,
    });
    expect(report.proposedCount).toBe(0);
    expect(report.arrays.find((a) => a.key === 'haynestower')!.proposals).toEqual([]);
  });

  it('continuous mode skips when a batch is already open (idempotence)', async () => {
    await setPolicy(CONTINUOUS);
    await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'admin_review', createdBy: actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: underBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    expect(report.proposedCount).toBe(0);
  });

  it('continuous mode still respects min-candidates', async () => {
    await setPolicy({ ...CONTINUOUS, minCandidates: 10 }); // only 3 pending
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: underBundle(),
      actorId,
    });
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_min_candidates');
    expect(report.proposedCount).toBe(0);
  });

  it('setAppSetting(space_policy) writes an update_app_setting audit row (audited config)', async () => {
    const before = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    await setPolicy(ENABLED);
    const after = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(after.length).toBeGreaterThan(before.length);
    const last = after.at(-1)!;
    expect((last.detail as Record<string, unknown>).key).toBe('space_policy');
  });

  it('getSpacePolicy merges defaults over a partial/absent row (fail-safe OFF; mode+perKind filled)', async () => {
    await t.db.delete(trashBatches);
    // A pre-build-A row with no `mode`/`perKind` ⇒ getSpacePolicy fills mode='over-target' + empty caps.
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: { enabled: true, minCandidates: 2, perArray: {} } as unknown as SpacePolicy,
      actorId,
    });
    const p = await getSpacePolicy(t.db);
    expect(p).toMatchObject({ enabled: true, mode: 'over-target', minCandidates: 2 });
    // A retired `cooldownDays` key on an old stored row is simply ignored (ADR-073).
    expect('cooldownDays' in p).toBe(false);
    expect(p.perKind.movie.targetBytes.enabled).toBe(false);
    expect(p.perKind.tv.maxItems.enabled).toBe(false);
  });

  // The prod break: the retired `cooldownDays` survived INSIDE a perArray entry (only the top-level
  // retired keys were dropped) and `perArray` was passed through verbatim, so the settings card handed
  // it straight back to the strict storage.policy.set input — every Trash-settings save died on
  // `unrecognized_keys` at perArray.haynestower.cooldownDays.
  it('getSpacePolicy NORMALIZES perArray — a retired nested cooldownDays is dropped, the opt-in survives', async () => {
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        ...ENABLED,
        perArray: {
          haynestower: { enabled: true, minCandidates: 3, cooldownDays: 7 },
          cephfs: { enabled: false, cooldownDays: 14 },
        },
      } as unknown as SpacePolicy,
      actorId,
    });
    const p = await getSpacePolicy(t.db);
    expect(p.perArray.haynestower).toEqual({ enabled: true, minCandidates: 3 });
    expect(p.perArray.cephfs).toEqual({ enabled: false });
  });

  it('getSpacePolicy guards a garbage perArray entry (non-object dropped, bad types fail safe)', async () => {
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        ...ENABLED,
        perArray: {
          haynestower: { enabled: 'yes', minCandidates: 'lots' },
          cephfs: null,
          bogus: 42,
        },
      } as unknown as SpacePolicy,
      actorId,
    });
    const p = await getSpacePolicy(t.db);
    // A non-boolean `enabled` reads as opted OUT; a non-numeric override is dropped (top-level applies).
    expect(p.perArray.haynestower).toEqual({ enabled: false });
    expect('cephfs' in p.perArray).toBe(false);
    expect('bogus' in p.perArray).toBe(false);
  });

  it('getSpacePolicy MIGRATES a legacy flat targetBytesPerBatch to movie+tv targetBytes caps', async () => {
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        enabled: true,
        cooldownDays: 7,
        minCandidates: 1,
        perArray: { haynestower: { enabled: true } },
        targetBytesPerBatch: 5_000_000_000,
      } as unknown as SpacePolicy,
      actorId,
    });
    const p = await getSpacePolicy(t.db);
    expect(p.perKind.movie.targetBytes).toEqual({ enabled: true, value: 5_000_000_000 });
    expect(p.perKind.tv.targetBytes).toEqual({ enabled: true, value: 5_000_000_000 });
    // The new perKind shape (when present) wins over the legacy key.
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        ...ENABLED,
        perKind: {
          ...defaultPerKind(),
          movie: { ...defaultPerKind().movie, maxItems: { enabled: true, value: 4 } },
        },
        targetBytesPerBatch: 5_000_000_000,
      } as unknown as SpacePolicy,
      actorId,
    });
    const p2 = await getSpacePolicy(t.db);
    expect(p2.perKind.movie.maxItems).toEqual({ enabled: true, value: 4 });
    expect(p2.perKind.movie.targetBytes.enabled).toBe(false); // legacy IGNORED once perKind is present
  });

  it('getSpacePolicyStatus reflects a fresh proposal (last proposal + open-batch slot)', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const status = await getSpacePolicyStatus({ db: t.db });
    expect(status.policy.enabled).toBe(true);
    expect(status.lastProposalAt).not.toBeNull();
    const movieKind = status.kinds.find((k) => k.mediaKind === 'movie')!;
    expect(movieKind.lastProposal).not.toBeNull();
    // A movie batch is now open (leaving_soon, auto-promoted) — the status reflects the slot being held.
    expect(movieKind.hasOpenBatch).toBe(true);
  });

  // ADR-120 / DESIGN-014 D-16. The switch ships off. While it is off the reader is not called and
  // the per-kind caps decide the batch. While it is on and the series can be sized, the byte ask
  // replaces those caps. movieCollection is 4e9 + 3e9 + 2e9, so a 5e9 ask takes two titles and a
  // maxItems of 1 takes one.
  const DAY = 86_400;
  const paceNow = new Date('2026-11-13T18:43:26Z');
  const paceNowSec = Math.floor(paceNow.getTime() / 1000);
  const paceSeries = (perDay: number) => {
    const start = paceNowSec - 90 * DAY;
    const out: { t: number; freeBytes: number }[] = [];
    for (let i = 0; i <= 30; i++) {
      out.push({ t: start + i * 3 * DAY, freeBytes: 400 * TB + perDay * i * 3 });
    }
    return out;
  };
  const pacePolicy = (enabled: boolean, maxItems: number): SpacePolicy => ({
    ...withMovieCaps({ maxItems: { enabled: true, value: maxItems } }),
    dynamicPace: {
      enabled,
      horizonDays: 60,
      floorBytes: 1,
      ceilingBytes: 5_000_000_000,
    },
  });
  const proposePaced = async (
    policy: SpacePolicy,
    samples: { t: number; freeBytes: number }[] | 'throw' | 'none',
    disk: 'over' | 'under',
  ) => {
    await setPolicy(policy);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    return evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: disk === 'over' ? overBundle() : underBundle(),
      actorId,
      now: paceNow,
      ...(samples === 'none'
        ? {}
        : {
            readFreeSpace: async () => {
              if (samples === 'throw') throw new Error('pace read while off');
              return samples;
            },
          }),
    });
  };

  it('an absent dynamic pace reads off, with the measured bounds', async () => {
    await setPolicy(ENABLED);
    const policy = await getSpacePolicy(t.db);
    expect(policy.dynamicPace?.enabled).toBe(false);
    expect(policy.dynamicPace?.horizonDays).toBe(DYNAMIC_PACE_HORIZON_DAYS);
    expect(policy.dynamicPace?.floorBytes).toBe(DYNAMIC_PACE_FLOOR_BYTES);
    expect(policy.dynamicPace?.ceilingBytes).toBe(DYNAMIC_PACE_CEILING_BYTES);
  });

  it('the switch off equals today: maxItems 1, and the free-space reader is not called', async () => {
    const report = await proposePaced(pacePolicy(false, 1), 'throw', 'over');
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(1);
    expect(report.arrays.find((a) => a.key === 'haynestower')!.pace).toBeNull();
  });

  it("the switch on with no series keeps today's cap", async () => {
    const report = await proposePaced(pacePolicy(true, 1), 'none', 'over');
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(1);
  });

  it("the switch on with a too-short series keeps today's cap", async () => {
    const report = await proposePaced(pacePolicy(true, 1), paceSeries(0).slice(0, 3), 'over');
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(1);
    expect(report.arrays.find((a) => a.key === 'haynestower')!.pace?.applicable).toBe(false);
  });

  it('the switch on retains the title cap beside the hard byte ask', async () => {
    const report = await proposePaced(pacePolicy(true, 1), paceSeries(0), 'over');
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    const movie = tower.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(tower.pace?.applicable).toBe(true);
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(1);
    expect(await batchIds(movie.batchId!)).toEqual(['ms-9001']);
  });

  it('under target with the switch off proposes nothing', async () => {
    const report = await proposePaced(pacePolicy(false, 1), 'throw', 'under');
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_under_target');
    expect(report.proposedCount).toBe(0);
  });

  it('under target with the switch on and a filling library proposes a steady batch', async () => {
    const report = await proposePaced(pacePolicy(true, 1), paceSeries(-2_000_000_000_000), 'under');
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(1);
    expect(report.arrays.find((a) => a.key === 'haynestower')!.pace?.pace).toBe('steady');
  });

  it('a drain that reaches the floor inside the horizon proposes nothing', async () => {
    const report = await proposePaced(pacePolicy(true, 50), paceSeries(2_000_000_000_000), 'over');
    const movie = report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_pace');
    expect(report.proposedCount).toBe(0);
    const [batch] = await t.db.select().from(trashBatches);
    expect(batch).toBeUndefined();
  });

  it('under target, the final title-capped selection below the floor is not posted', async () => {
    const policy = pacePolicy(true, 1);
    policy.dynamicPace!.floorBytes = 5e9;
    policy.dynamicPace!.ceilingBytes = 9e9;
    const report = await proposePaced(policy, paceSeries(-2e12), 'under');
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals[0]!;
    expect(movie.outcome).toBe('skipped_empty');
    expect(report.proposedCount).toBe(0);
    expect((await getSpacePolicyStatus({ db: t.db })).pace!.arrays[0]!.decisions.find((d) => d.mediaKind === 'movie')!.selectedBytes).toBe(0);
  });

  it('an open batch still holds the slot when the pace is on', async () => {
    const first = await proposePaced(pacePolicy(false, 1), 'none', 'over');
    const created = first.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!.batchId;
    const second = await proposePaced(pacePolicy(true, 1), paceSeries(0), 'over');
    const movie = second.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    expect(movie.batchId).toBe(created);
    expect(second.proposedCount).toBe(0);
  });

  it('observe-only stores the hypothetical ask while today’s cap builds the batch', async () => {
    const policy = pacePolicy(false, 1);
    policy.dynamicPace!.observeOnly = true;
    policy.dynamicPace!.ceilingBytes = 1; // no title could fit a paced batch
    const report = await proposePaced(policy, paceSeries(0), 'over');
    expect(report.proposedCount).toBe(1);
    const status = await getSpacePolicyStatus({ db: t.db });
    const decision = status.pace!.arrays[0]!.decisions.find((d) => d.mediaKind === 'movie')!;
    expect(decision).toMatchObject({
      mode: 'observe-only',
      applied: false,
      fallbackReason: null,
      outcome: 'proposed',
      selectedBytes: 4e9,
      evaluatedAt: paceNow.toISOString(),
    });
    expect(decision.explanation!.chosenBytes).toBe(1);
    const [event] = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_space_policy'));
    expect(event!.payload.pace).toMatchObject({ mode: 'observe-only', applied: false });
  });

  it('a zero ask is recorded; status returns that stored decision without recomputing', async () => {
    await proposePaced(pacePolicy(true, 50), paceSeries(2e12), 'over');
    const status = await getSpacePolicyStatus({ db: t.db });
    expect(status.lastProposalAt).toBeNull();
    expect(status.recentProposals).toEqual([]);
    expect(status.pace!.applied).toBe(false);
    expect(status.pace!.arrays[0]!.decisions).toHaveLength(2);
    expect(status.pace!.arrays[0]!.decisions[0]).toMatchObject({
      outcome: 'skipped_pace',
      applied: false,
      fallbackReason: null,
    });
    await setPolicy(ENABLED); // the historical reasoning survives a later setting change
    expect((await getSpacePolicyStatus({ db: t.db })).pace).toEqual(status.pace);
  });

  it.each(['throw', 'none'] as const)(
    'a %s reader falls back with a stored reason and today’s caps',
    async (reader) => {
      await proposePaced(pacePolicy(true, 1), reader, 'over');
      const status = await getSpacePolicyStatus({ db: t.db });
      const movie = status.pace!.arrays[0]!.decisions.find((d) => d.mediaKind === 'movie')!;
      expect(movie).toMatchObject({
        outcome: 'proposed',
        applied: false,
        explanation: null,
        fallbackReason: reader === 'throw' ? 'series_read_failed' : 'missing_reader',
        selectedBytes: 4e9,
      });
    },
  );

  it('a partial preload failure falls back to today’s caps, discarding partial data', async () => {
    const original = trashFlow.listTrashPending;
    let reads = 0;
    const spy = vi.spyOn(trashFlow, 'listTrashPending').mockImplementation(async (input) => {
      reads++;
      if (reads === 2) throw new Error('preload unavailable');
      return original(input);
    });
    try {
      const report = await proposePaced(pacePolicy(true, 1), paceSeries(0), 'over');
      expect(report.proposedCount).toBe(1);
      const decision = (await getSpacePolicyStatus({ db: t.db })).pace!.arrays[0]!.decisions.find(
        (d) => d.mediaKind === 'movie',
      )!;
      expect(decision).toMatchObject({
        applied: false,
        fallbackReason: 'preload_failed',
        selectedBytes: 4e9,
      });
      expect(reads).toBeGreaterThan(2); // fallback really read again, rather than trusting partial preload
    } finally {
      spy.mockRestore();
    }
  });

  it('a stale series falls back and records staleness', async () => {
    await proposePaced(pacePolicy(true, 1), paceSeries(0).slice(0, -2), 'over');
    const decision = (await getSpacePolicyStatus({ db: t.db })).pace!.arrays[0]!.decisions.find(
      (d) => d.mediaKind === 'movie',
    )!;
    expect(decision).toMatchObject({
      applied: false,
      fallbackReason: 'stale_series',
      selectedBytes: 4e9,
    });
  });

  it('TV retains its five-title cap beside movies under a shared hard byte ceiling', async () => {
    const policy = pacePolicy(true, 50);
    policy.perKind.tv.maxItems = { enabled: true, value: 5 };
    await setPolicy(policy);
    const tv = tvCollection({
      items: Array.from({ length: 10 }, (_, i) => ({
        mediaServerId: `tv-${i}`,
        tvdbId: 8000 + i,
        sizeBytes: 100_000_000,
        addDate: '2026-01-01T00:00:00Z',
      })),
    });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection(), tv] }));
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr: overBundle(),
      now: paceNow,
      readFreeSpace: async () => paceSeries(0),
    });
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.proposals.find((p) => p.mediaKind === 'tv')!.candidateCount).toBe(5);
    const items = await t.db.select().from(trashBatchItems);
    expect(items.reduce((sum, i) => sum + i.sizeBytes, 0)).toBeLessThanOrEqual(
      policy.dynamicPace!.ceilingBytes,
    );
    expect(tower.pace!.chosenBytes).toBe(items.reduce((sum, i) => sum + i.sizeBytes, 0));
    expect(tower.pace!.shortfallBytes).toBe(
      tower.pace!.requiredDeletedBytes - tower.pace!.expectedDeletedBytes,
    );
  });

  it('a separate audited movie title cap can only reduce the current cap', async () => {
    const policy = pacePolicy(true, 50);
    policy.dynamicPace!.movieMaxItems = 1;
    const report = await proposePaced(policy, paceSeries(0), 'over');
    expect(report.arrays.find((a) => a.key === 'haynestower')!.proposals[0]!.candidateCount).toBe(
      1,
    );
    expect((await getSpacePolicy(t.db)).dynamicPace!.movieMaxItems).toBe(1);
  });

  it.each(['over-target', 'continuous'] as const)(
    'off preserves the original payload bytes and caps in %s mode',
    async (mode) => {
      const captures: string[] = [];
      for (const explicitOff of [false, true]) {
        await t.db.delete(trashBatches);
        await t.db.delete(notifications);
        await t.db.delete(ledgerEvents).where(eq(ledgerEvents.eventType, 'trash_space_policy'));
        const p = { ...withMovieCaps({ maxItems: { enabled: true, value: 1 } }), mode };
        if (explicitOff)
          p.dynamicPace = { ...pacePolicy(false, 1).dynamicPace!, observeOnly: false };
        await setPolicy(p);
        const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
        const reader = vi.fn(async () => {
          throw new Error('off read');
        });
        const report = await evaluateSpacePolicy({
          db: t.db,
          maintainerr: bundle,
          arr: mode === 'continuous' ? underBundle() : overBundle(),
          now: paceNow,
          readFreeSpace: reader,
        });
        expect(reader).not.toHaveBeenCalled();
        expect(report.proposedCount).toBe(1);
        const [event] = await t.db
          .select()
          .from(ledgerEvents)
          .where(eq(ledgerEvents.eventType, 'trash_space_policy'));
        const pld = event!.payload;
        // The legacy payload has exactly these fields. Only the newly generated batch UUID varies.
        expect(pld).toEqual({
          batchId: report.arrays[0]!.proposals[0]!.batchId,
          mediaKind: 'movie',
          mode,
          array: 'haynestower',
          arrayLabel: 'HaynesTower',
          usedPct: mode === 'continuous' ? 70 : 90,
          target: 80,
          candidateCount: 1,
          candidateBytes: 9e9,
          gateSkipped: true,
        });
        captures.push(JSON.stringify({ ...pld, batchId: '<generated>' }));
        const [notice] = await t.db
          .select()
          .from(notifications)
          .where(eq(notifications.type, 'space_policy'));
        expect(notice!.payload).toEqual(pld);
      }
      expect(captures[1]).toBe(captures[0]);
    },
  );

  it('continuous mode still respects minCandidates while pace is on', async () => {
    const policy = { ...pacePolicy(true, 50), mode: 'continuous' as const, minCandidates: 4 };
    const report = await proposePaced(policy, paceSeries(-2e12), 'under');
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals[0]!;
    expect(movie.outcome).toBe('skipped_min_candidates');
    expect(report.proposedCount).toBe(0);
    expect(
      (await getSpacePolicyStatus({ db: t.db })).pace!.arrays[0]!.decisions.find(
        (d) => d.mediaKind === 'movie',
      )!.applied,
    ).toBe(false);
  });

  it('continuous mode under a far-under target and target 100 posts no paced batch', async () => {
    const policy = { ...pacePolicy(true, 50), mode: 'continuous' as const };
    const report = await proposePaced(policy, paceSeries(-1e9), 'under');
    expect(report.proposedCount).toBe(0);
    await setAppSetting({ db: t.db, key: 'space_targets', value: { haynestower: 100 }, actorId });
    expect((await proposePaced(policy, paceSeries(-1e12), 'over')).proposedCount).toBe(0);
  });

  it('the snapshot and live pace pools exclude titles already posted in any open batch', async () => {
    await proposePaced(pacePolicy(false, 1), 'none', 'over');
    await t.db.insert((await import('@hnet/db')).trashCandidates).values([
      {
        mediaKind: 'movie',
        collectionId: 7,
        maintainerrMediaId: 'ms-9001',
        tmdbId: 9001,
        sizeBytes: 4e9,
      },
      {
        mediaKind: 'movie',
        collectionId: 7,
        maintainerrMediaId: 'ms-9002',
        tmdbId: 9002,
        sizeBytes: 3e9,
      },
    ]);
    try {
      expect(
        (await measureDeletableSnapshotPools(t.db, paceNow)).find((p) => p.mediaKind === 'movie')!
          .poolBytes,
      ).toBe(3e9);
      const report = await proposePaced(pacePolicy(true, 50), paceSeries(0), 'over');
      expect(report.arrays.find((a) => a.key === 'haynestower')!.pace!.poolBytes).toBe(5e9);
      expect(report.proposedCount).toBe(0);
    } finally {
      await t.db.delete((await import('@hnet/db')).trashCandidates);
    }
  });

  it('reads sweep deletions from the series start, including before now minus 90 days', async () => {
    const start = forecastQueryRange(paceNowSec).start;
    expect(start).toBeLessThan(paceNowSec - 90 * DAY);
    const sliverAt = new Date((start + 1) * 1000);
    const [batch] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'deleted', deletedAt: sliverAt })
      .returning();
    await t.db
      .insert(trashBatchItems)
      .values({
        batchId: batch!.id,
        maintainerrMediaId: 'sliver',
        title: 'fixture',
        state: 'deleted',
        sizeBytes: 800,
        deletedSizeBytes: 800,
        deletedAt: sliverAt,
      });
    expect(await recordedSweepDeletions(t.db, paceNow, 'haynestower', start)).toEqual([
      { t: start + 1, bytes: 800 },
    ]);
    expect(await recordedSweepDeletions(t.db, paceNow, 'cephfs', start)).toEqual([]);
    expect(await recordedSweepDeletions(t.db, paceNow, 'unknown', start)).toEqual([]);
    expect(await measureTrashYield(t.db, paceNow, 'cephfs')).toBeNull();
    expect(await measureTrashYield(t.db, paceNow, 'unknown')).toBeNull();
    expect(await measureTrashYield(t.db, paceNow, 'haynestower')).toBeNull(); // outside the yield window
  });

  it('the save rate is saved bytes over saved plus deleted, and a sweep is one deletion', async () => {
    const [batch] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'deleted', deletedAt: paceNow })
      .returning();
    await t.db.insert(trashBatchItems).values([
      {
        batchId: batch!.id,
        maintainerrMediaId: 'saved-1',
        title: 'saved',
        state: 'saved',
        sizeBytes: 200,
      },
      {
        batchId: batch!.id,
        maintainerrMediaId: 'deleted-1',
        title: 'deleted',
        state: 'deleted',
        sizeBytes: 800,
        deletedSizeBytes: 800,
        deletedAt: paceNow,
      },
    ]);
    expect(await measureTrashYield(t.db, paceNow)).toBeCloseTo(0.2, 6);
    const deletions = await recordedSweepDeletions(t.db, paceNow);
    expect(deletions).toEqual([{ t: paceNowSec, bytes: 800 }]);
  });
});
