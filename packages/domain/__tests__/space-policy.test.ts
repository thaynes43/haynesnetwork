// ADR-031 / DESIGN-014 (PLAN-014) — the SPACE-DRIVEN POLICY orchestrator (embedded PG16 + fetch-
// stubbed *arr /diskspace + fetch-stubbed Maintainerr). Proves the propose-only evaluation MATRIX
// (over/under target · disabled · per-array off · open-batch skip · cooldown · min-candidates · empty),
// the trash_space_policy ledger event + space_policy notification writes, the skip-gate pass-through
// (not special-cased), the settings audit, and the ledger-derived status read.
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { ledgerEvents, notifications, permissionAudit, trashBatches } from '@hnet/db/schema';
import {
  buildArrClientBundle,
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
  cooldownDays: 7,
  minCandidates: 1,
  perArray: { haynestower: { enabled: true } },
};

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

  it('over target + enabled + candidates → PROPOSES a movie batch (admin_review) + event + notification', async () => {
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
    expect(movie.gateSkipped).toBe(false);
    expect(movie.candidateCount).toBe(3);
    // No TV rule collection ⇒ the TV kind proposes nothing (empty), NOT an error.
    expect(tower.proposals.find((p) => p.mediaKind === 'tv')!.outcome).toBe('skipped_empty');
    // CephFS (music) has no target and no batchable kinds — no proposals.
    expect(report.arrays.find((a) => a.key === 'cephfs')!.proposals).toEqual([]);

    // The batch landed in admin_review (the human gate) — never leaving_soon.
    const [batch] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, movie.batchId!));
    expect(batch!.state).toBe('admin_review');
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

  it('UNDER target → no proposals (arrays reported, overTarget false)', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: underBundle(), actorId });
    expect(report.proposedCount).toBe(0);
    const tower = report.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.overTarget).toBe(false);
    expect(tower.usedPct).toBe(70);
    expect(tower.proposals).toEqual([]);
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

  it('cooldown → a closed prior proposal within N days blocks a re-propose', async () => {
    await setPolicy(ENABLED);
    // A proposal 2 days ago whose batch has since been cancelled (closed, but within the 7d cooldown).
    const [b] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'cancelled', createdBy: actorId })
      .returning();
    await t.db.insert(ledgerEvents).values({
      mediaItemId: null,
      eventType: 'trash_space_policy',
      source: 'maintainerr',
      occurredAt: new Date(Date.now() - 2 * 86_400_000),
      payload: { batchId: b!.id, mediaKind: 'movie', array: 'haynestower', usedPct: 90, target: 80 },
    });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    expect(movie.outcome).toBe('skipped_cooldown');
    expect(movie.cooldownUntil).not.toBeNull();
    // No NEW movie batch (only the seeded cancelled one remains).
    const open = await t.db.select().from(trashBatches).where(inArray(trashBatches.state, ['draft', 'admin_review', 'leaving_soon']));
    expect(open).toHaveLength(0);
  });

  it('per-array override of the WRONG TYPE (string cooldownDays) fails SAFE to the default (cooldown still enforced)', async () => {
    // A hand-edited jsonb row where the per-array cooldownDays is a string, not a number. Without the
    // typeof guard in effectiveArrayPolicy the `??` pass-through would feed the string into the cooldown
    // math → new Date(lastAt + NaN) → `now < NaN` is always false → the cooldown SILENTLY DISABLES and
    // the policy re-proposes. The guard must instead fall back to the policy default (7d) → still blocked.
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        enabled: true,
        cooldownDays: 7,
        minCandidates: 1,
        perArray: { haynestower: { enabled: true, cooldownDays: 'soon' } },
      } as unknown as SpacePolicy,
      actorId,
    });
    // A prior proposal 2 days ago (well within the 7d default) whose batch has since closed.
    const [b] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'cancelled', createdBy: actorId })
      .returning();
    await t.db.insert(ledgerEvents).values({
      mediaItemId: null,
      eventType: 'trash_space_policy',
      source: 'maintainerr',
      occurredAt: new Date(Date.now() - 2 * 86_400_000),
      payload: { batchId: b!.id, mediaKind: 'movie', array: 'haynestower', usedPct: 90, target: 80 },
    });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const report = await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const movie = report.arrays.find((a) => a.key === 'haynestower')!.proposals.find((p) => p.mediaKind === 'movie')!;
    // The default 7d was applied (a real date, not NaN) → still in cooldown → NO new batch proposed.
    expect(movie.outcome).toBe('skipped_cooldown');
    expect(movie.cooldownUntil).not.toBeNull();
    expect(Number.isNaN(Date.parse(movie.cooldownUntil!))).toBe(false);
    expect(report.proposedCount).toBe(0);
    const open = await t.db
      .select()
      .from(trashBatches)
      .where(inArray(trashBatches.state, ['draft', 'admin_review', 'leaving_soon']));
    expect(open).toHaveLength(0);
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

  it('getSpacePolicy merges defaults over a partial/absent row (fail-safe OFF)', async () => {
    await t.db.delete(trashBatches);
    // Never set ⇒ the documented default.
    await setAppSetting({ db: t.db, key: 'space_policy', value: { enabled: true, cooldownDays: 3, minCandidates: 2, perArray: {} }, actorId });
    const p = await getSpacePolicy(t.db);
    expect(p).toMatchObject({ enabled: true, cooldownDays: 3, minCandidates: 2 });
  });

  it('getSpacePolicyStatus reflects a fresh proposal (last proposal + cooldown next-eligible)', async () => {
    await setPolicy(ENABLED);
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    await evaluateSpacePolicy({ db: t.db, maintainerr: bundle, arr: overBundle(), actorId });
    const status = await getSpacePolicyStatus({ db: t.db });
    expect(status.policy.enabled).toBe(true);
    expect(status.lastProposalAt).not.toBeNull();
    const movieKind = status.kinds.find((k) => k.mediaKind === 'movie')!;
    expect(movieKind.lastProposal).not.toBeNull();
    // A movie batch is now open (admin_review) — the status reflects the slot being held.
    expect(movieKind.hasOpenBatch).toBe(true);
    expect(movieKind.cooldownDays).toBe(7);
    expect(movieKind.nextEligibleAt).not.toBeNull(); // within the 7d cooldown
  });
});
