// ADR-031 / DESIGN-014 (PLAN-014); ADR-073 (2026-07-18) — the SPACE-DRIVEN POLICY orchestrator (embedded
// PG16 + fetch-stubbed *arr /diskspace + fetch-stubbed Maintainerr). Proves the AUTONOMOUS evaluation
// MATRIX (over/under target · disabled · per-array off · open-batch skip · min-candidates · empty), the
// auto-promote to leaving_soon (no admin-review gate, no cooldown), the SELF-HEAL of a stuck batch
// (the prod stall), the trash_space_policy ledger event + space_policy notification writes, the settings
// audit, and the ledger-derived status read.
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { ledgerEvents, notifications, permissionAudit, trashBatchItems, trashBatches } from '@hnet/db/schema';
import {
  buildArrClientBundle,
  createBatchFromPending,
  defaultPerKind,
  evaluateSpacePolicy,
  getSpacePolicy,
  getSpacePolicyStatus,
  setAppSetting,
  type ArrClientBundle,
  type SpacePolicy,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection, tvCollection } from './maintainerr-stub';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const TB = 1_000_000_000_000;

// --- *arr /diskspace stub (from the storage-metrics test) --------------------------------------------
type DiskSpec = { path: string; freeSpace: number; totalSpace: number }[] | 'fail';
function makeArrBundle(cfg: { radarr?: DiskSpec; sonarr?: DiskSpec; lidarr?: DiskSpec }): ArrClientBundle {
  const byHost: Record<string, DiskSpec | undefined> = {
    'radarr.test': cfg.radarr,
    'sonarr.test': cfg.sonarr,
    'lidarr.test': cfg.lidarr,
  };
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/diskspace')) {
      const spec = byHost[url.hostname];
      if (spec === 'fail' || spec === undefined) return new Response('{"m":"down"}', { status: 500 });
      return new Response(JSON.stringify(spec), { status: 200, headers: { 'content-type': 'application/json' } });
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
const TOWER_OVER: DiskSpec = [{ path: '/data/haynestower', freeSpace: 100 * TB, totalSpace: 1000 * TB }];
const TOWER_UNDER: DiskSpec = [{ path: '/data/haynestower', freeSpace: 300 * TB, totalSpace: 1000 * TB }];
const MUSIC: DiskSpec = [{ path: '/data/cephfs-hdd', freeSpace: 130 * TB, totalSpace: 175 * TB }];

const overBundle = () => makeArrBundle({ radarr: TOWER_OVER, sonarr: TOWER_OVER, lidarr: MUSIC });
const underBundle = () => makeArrBundle({ radarr: TOWER_UNDER, sonarr: TOWER_UNDER, lidarr: MUSIC });

const ENABLED: SpacePolicy = {
  enabled: true,
  mode: 'over-target',
  minCandidates: 1,
  perArray: { haynestower: { enabled: true } },
  perKind: defaultPerKind(),
};

/** ENABLED with the movie kind's caps overridden (DESIGN-014 amendment 2026-07-09, build A). */
const withMovieCaps = (
  movie: Partial<SpacePolicy['perKind']['movie']>,
): SpacePolicy => ({
  ...ENABLED,
  perKind: { ...defaultPerKind(), movie: { ...defaultPerKind().movie, ...movie } },
});

describe('evaluateSpacePolicy (ADR-031 — propose-only, never deletes)', () => {
  let t: TestDb;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'policy-admin@example.com', displayName: 'Policy Admin' })).id;
    await setAppSetting({ db: t.db, key: 'space_targets', value: { haynestower: 80 }, actorId });
  });
  afterAll(async () => t?.stop());

  // Clean slate between tests (in packages/domain — the no-direct-writes guard does not apply here).
  beforeEach(async () => {
    await t.db.delete(trashBatches); // cascades items + saves
    await t.db
      .delete(ledgerEvents)
      .where(inArray(ledgerEvents.eventType, ['trash_space_policy', 'trash_batch_transition', 'trash_restored']));
    await t.db.delete(notifications);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: false, actorId });
  });
  afterEach(async () => {
    await t.db.delete(trashBatches);
  });

  const setPolicy = (p: SpacePolicy) => setAppSetting({ db: t.db, key: 'space_policy', value: p, actorId });

  it('over target + enabled + candidates → PROPOSES AND PROMOTES a movie batch (leaving_soon) + event + notification', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });

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
    const [batch] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, movie.batchId!));
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
    const [note] = await t.db.select().from(notifications).where(eq(notifications.type, 'space_policy'));
    expect(note!.source).toBe('trash');
    expect(note!.title).toContain('Movies');
  });

  // ── per-kind composition caps (DESIGN-014 amendment 2026-07-09, build A) ─────────────────────
  // movieCollection: 9001(4e9), 9002(3e9), 9003(2e9), all UNRATED — so worst-rated (the policy default)
  // ranks by size desc (unrated tie-break), i.e. 9001 → 9002 → 9003.
  const proposeMovie = async (policy: SpacePolicy) => {
    await setPolicy(policy);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    return report.arrays
      .find((a) => a.key === 'haynestower')!
      .proposals.find((p) => p.mediaKind === 'movie')!;
  };
  const batchIds = async (batchId: string) =>
    (
      await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId))
    )
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
      withMovieCaps({ maxItems: { enabled: false, value: 1 }, targetBytes: { enabled: false, value: 1 } }),
    );
    expect(movie.outcome).toBe('proposed');
    expect(movie.candidateCount).toBe(3); // both caps off ⇒ all three
  });

  it('proposes BOTH movie and tv when both rule collections have candidates', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection(), tvCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
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
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: underBundle(), actorId });
    expect(report.proposedCount).toBe(0);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.overTarget).toBe(false);
    expect(tower.usedPct).toBe(70);
    // Opted in but under target ⇒ each kind reports skipped_under_target (no NEW batch), never []).
    expect(tower.proposals.find((p) => p.mediaKind === 'movie')!.outcome).toBe('skipped_under_target');
    expect(tower.proposals.find((p) => p.mediaKind === 'tv')!.outcome).toBe('skipped_under_target');
    expect(await t.db.select().from(trashBatches)).toHaveLength(0);
  });

  it('DISABLED policy → a no-op run (no utilization read, no proposals, no writes)', async () => {
    await setPolicy({ ...ENABLED, enabled: false });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    expect(report.enabled).toBe(false);
    expect(report.proposedCount).toBe(0);
    expect(report.arrays).toEqual([]);
    expect(await t.db.select().from(trashBatches)).toHaveLength(0);
  });

  it('per-array OFF (global on) → array reported but never proposes', async () => {
    await setPolicy({ ...ENABLED, perArray: { haynestower: { enabled: false } } });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    expect(report.proposedCount).toBe(0);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.enabled).toBe(false);
    expect(tower.overTarget).toBe(true); // still over — it just isn't opted in
    expect(tower.proposals).toEqual([]);
  });

  it('open batch for the kind → skipped_open_batch (idempotence, no error, no duplicate)', async () => {
    await setPolicy(ENABLED);
    // Seed an OPEN movie batch directly (the one-open-per-kind slot is taken).
    await t.db.insert(trashBatches).values({ mediaKind: 'movie', state: 'admin_review', createdBy: actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
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
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('promoted');
    expect(movie.batchId).toBe(stuck.batchId);
    expect(report.proposedCount).toBe(1);

    const [batch] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, stuck.batchId));
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
    await t.db.insert(trashBatches).values({ mediaKind: 'movie', state: 'admin_review', createdBy: actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    const [batch] = await t.db.select().from(trashBatches).where(eq(trashBatches.mediaKind, 'movie'));
    expect(batch!.state).toBe('admin_review'); // untouched
  });

  it('a healthy open leaving_soon batch is left alone (skipped_open_batch, no duplicate)', async () => {
    await setPolicy(ENABLED);
    await t.db.insert(trashBatches).values({ mediaKind: 'movie', state: 'leaving_soon', createdBy: null });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    expect(report.proposedCount).toBe(0);
    expect(await t.db.select().from(trashBatches)).toHaveLength(1);
  });

  it('min-candidates → too few pending is skipped', async () => {
    await setPolicy({ ...ENABLED, minCandidates: 10 }); // the movie collection has only 3
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_min_candidates');
    expect(movie.candidateCount).toBe(3);
    expect(report.proposedCount).toBe(0);
  });

  it('skip-gate ON → the proposed batch flows straight to leaving_soon (not special-cased)', async () => {
    await setPolicy(ENABLED);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('proposed');
    expect(movie.gateSkipped).toBe(true);
    const [batch] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, movie.batchId!));
    expect(batch!.state).toBe('leaving_soon');
    expect(batch!.gateSkipped).toBe(true);
  });

  // ── continuous mode (DESIGN-014 amendment 2026-07-09, build A) ───────────────────────────────
  const CONTINUOUS: SpacePolicy = { ...ENABLED, mode: 'continuous' };

  it('continuous mode PROPOSES under target (the disk target is not required)', async () => {
    await setPolicy(CONTINUOUS);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    // underBundle ⇒ 70% used, UNDER the 80% target — over-target mode would skip; continuous proposes.
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: underBundle(), actorId });
    expect(report.proposedCount).toBe(1);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.overTarget).toBe(false); // utilization is still read for reporting
    expect(tower.usedPct).toBe(70);
    expect(tower.proposals.find((p) => p.mediaKind === 'movie')!.outcome).toBe('proposed');
  });

  it('continuous mode STILL requires the array to be opted in (per-array off ⇒ no proposal)', async () => {
    await setPolicy({ ...CONTINUOUS, perArray: { haynestower: { enabled: false } } });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: underBundle(), actorId });
    expect(report.proposedCount).toBe(0);
    expect(report.arrays.find((a) => a.key === 'haynestower')!.proposals).toEqual([]);
  });

  it('continuous mode skips when a batch is already open (idempotence)', async () => {
    await setPolicy(CONTINUOUS);
    await t.db.insert(trashBatches).values({ mediaKind: 'movie', state: 'admin_review', createdBy: actorId });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: underBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_open_batch');
    expect(report.proposedCount).toBe(0);
  });

  it('continuous mode still respects min-candidates', async () => {
    await setPolicy({ ...CONTINUOUS, minCandidates: 10 }); // only 3 pending
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: underBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
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
        perKind: { ...defaultPerKind(), movie: { ...defaultPerKind().movie, maxItems: { enabled: true, value: 4 } } },
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
});
