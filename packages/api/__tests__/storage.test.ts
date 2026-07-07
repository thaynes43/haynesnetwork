// ADR-030 / DESIGN-013 (PLAN-013) — the Storage tRPC surface. Proves the v1 admin gate (a member is
// FORBIDDEN on every procedure before any logic), the utilization read merges the *arr /diskspace + the
// space_targets, reclaim returns a well-formed (empty) report, and targets.set is zod-validated + audited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionAudit, type users } from '@hnet/db';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';
import { stubArrBundle } from './arr-stubs';

const TB = 1_000_000_000_000;

let testDb: TestDb;
let admin: typeof users.$inferSelect;
let member: typeof users.$inferSelect;
let adminCaller: Caller; // carries a diskspace-stubbed *arr bundle for utilization
let memberCaller: Caller;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  admin = await createUser(testDb.db, { admin: true, displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { displayName: 'Member Mia' });
  const stub = stubArrBundle([
    // v3 → HaynesTower (radarr + sonarr share it); v1 → CephFS music (lidarr).
    { path: '/api/v3/diskspace', body: [{ path: '/data/haynestower', freeSpace: 112.4304 * TB, totalSpace: 529.96 * TB }] },
    { path: '/api/v1/diskspace', body: [{ path: '/data/cephfs-hdd', freeSpace: 130.45 * TB, totalSpace: 174.84 * TB }] },
  ]);
  adminCaller = caller(makeCtx(testDb.db, sessionUser(admin), stub.bundle));
  memberCaller = caller(makeCtx(testDb.db, sessionUser(member), stub.bundle));
});

afterAll(async () => {
  await testDb.stop();
});

describe('storage admin gate — every procedure is adminProcedure (v1)', () => {
  it('a member is FORBIDDEN on utilization / reclaim / targets.get / targets.set', async () => {
    await expect(memberCaller.storage.utilization()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberCaller.storage.reclaim({ window: '90d' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberCaller.storage.targets.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      memberCaller.storage.targets.set({ targets: { haynestower: 80 } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // ADR-031 / DESIGN-014 (PLAN-014) — the space-policy card's four procedures are all admin-gated too:
  // the propose-only config (policy.get/set), its ledger-derived status (policy.status), and the
  // rules-tuning/graduation read the card composes (trash.tuning). A member is FORBIDDEN on every one.
  it('a member is FORBIDDEN on policy.get / policy.status / policy.set / trash.tuning', async () => {
    await expect(memberCaller.storage.policy.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberCaller.storage.policy.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      memberCaller.storage.policy.set({
        enabled: false,
        cooldownDays: 7,
        minCandidates: 1,
        perArray: {},
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberCaller.trash.tuning()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('storage.utilization — merges /diskspace + targets (admin)', () => {
  it('returns per-array utilization with ~78.8% HaynesTower and the set target', async () => {
    await adminCaller.storage.targets.set({ targets: { haynestower: 80 } });
    const rows = await adminCaller.storage.utilization();
    const tower = rows.find((r) => r.key === 'haynestower')!;
    expect(tower.usedPct).toBe(78.8);
    expect(tower.target).toBe(80);
    expect(tower.unavailable).toBe(false);
    expect(rows.find((r) => r.key === 'cephfs')!.usedPct).toBe(25.4);
  });
});

describe('storage.reclaim — a well-formed report on an empty ledger', () => {
  it('returns zeroed totals + empty breakdowns for a fresh db', async () => {
    const r = await adminCaller.storage.reclaim({ window: '90d' });
    expect(r).toMatchObject({ window: '90d' });
    expect(r.totals).toEqual({ items: 0, reclaimedBytes: 0 });
    expect(r.byCategoryResolution).toEqual([]);
    expect(r.cumulative).toEqual([]);
    expect(r.expedited).toEqual({ items: 0, reclaimedBytes: 0 });
  });
});

describe('storage.targets — get/set (audited via app_settings single-writer)', () => {
  it('set persists the map and writes an update_app_setting audit row; get reads it back', async () => {
    await adminCaller.storage.targets.set({ targets: { haynestower: 75, hayneskube: 90 } });
    expect(await adminCaller.storage.targets.get()).toEqual({ haynestower: 75, hayneskube: 90 });

    const audits = await testDb.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.at(-1)!.actorId).toBe(admin.id);
  });

  it('rejects an out-of-range percent (>100) at the zod edge (BAD_REQUEST)', async () => {
    await expect(
      adminCaller.storage.targets.set({ targets: { haynestower: 150 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unknown server slug key', async () => {
    await expect(
      // @ts-expect-error — deliberately invalid slug to prove the enum key rejects it
      adminCaller.storage.targets.set({ targets: { nope: 80 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
