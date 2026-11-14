// ADR-030 / DESIGN-013 (PLAN-013) — the Storage tRPC surface. Proves the v1 admin gate (a member is
// FORBIDDEN on every procedure before any logic), the utilization read merges the *arr /diskspace + the
// space_targets, reclaim returns a well-formed (empty) report, and targets.set is zod-validated + audited.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionAudit, type users } from '@hnet/db';
import { ingestLedgerEvents, setAppSetting } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';
import { SpacePolicyInput } from '../src/routers/storage';
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
    {
      path: '/api/v3/diskspace',
      body: [{ path: '/data/haynestower', freeSpace: 112.4304 * TB, totalSpace: 529.96 * TB }],
    },
    {
      path: '/api/v1/diskspace',
      body: [{ path: '/data/cephfs-hdd', freeSpace: 130.45 * TB, totalSpace: 174.84 * TB }],
    },
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
    await expect(memberCaller.storage.reclaim({ window: '90d' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
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
        mode: 'over-target',
        minCandidates: 1,
        perArray: {},
        perKind: {
          movie: {
            maxItems: { enabled: false, value: 25 },
            targetBytes: { enabled: false, value: 1 },
          },
          tv: {
            maxItems: { enabled: false, value: 25 },
            targetBytes: { enabled: false, value: 1 },
          },
        },
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

// The Trash-settings save regression: a `space_policy` row written before ADR-073 still carried the
// retired `cooldownDays` inside its perArray entry. getSpacePolicy used to pass perArray through
// verbatim, so the settings card round-tripped the retired key back into this strict input and EVERY
// save failed with `unrecognized_keys`. The read now normalizes, so get → set is a valid round-trip.
describe('storage.policy — a legacy row round-trips through get → set (ADR-073)', () => {
  it('accepts the object policy.get emits for a row carrying a retired per-array cooldownDays', async () => {
    await setAppSetting({
      db: testDb.db,
      key: 'space_policy',
      value: {
        enabled: true,
        mode: 'over-target',
        minCandidates: 10,
        perArray: { haynestower: { enabled: true, cooldownDays: 7 } },
        perKind: {
          movie: {
            maxItems: { enabled: true, value: 50 },
            targetBytes: { enabled: false, value: 100 * 1024 ** 3 },
            strategy: 'worst-rated',
          },
          tv: {
            maxItems: { enabled: true, value: 5 },
            targetBytes: { enabled: false, value: 100 * 1024 ** 3 },
          },
        },
      } as never,
      actorId: admin.id,
    });

    const loaded = await adminCaller.storage.policy.get();
    expect(loaded.perArray.haynestower).toEqual({ enabled: true });
    // The card sends back exactly what it was given (plus the admin's edits) — this must not throw.
    await adminCaller.storage.policy.set({ ...loaded, minCandidates: 12 });

    const after = await adminCaller.storage.policy.get();
    expect(after.minCandidates).toBe(12);
    expect(after.perArray.haynestower).toEqual({ enabled: true });
    // A configured per-kind ranking survives the round-trip (it used to be rejected by the strict cap).
    expect(after.perKind.movie.strategy).toBe('worst-rated');
    expect(after.perKind.movie.maxItems).toEqual({ enabled: true, value: 50 });
  });
});

describe('storage.policy — Dynamic Pace contract (ADR-124)', () => {
  it('schema and audited get/set preserve both new fields', async () => {
    const loaded = await adminCaller.storage.policy.get();
    const dynamicPace = {
      enabled: false,
      observeOnly: true,
      movieMaxItems: 50,
      horizonDays: 30,
      floorBytes: 130_604_353_957,
      ceilingBytes: 3_591_025_375_575,
    };
    const input = { ...loaded, dynamicPace };
    expect(SpacePolicyInput.parse(input).dynamicPace).toEqual(dynamicPace);
    await adminCaller.storage.policy.set(input);
    expect((await adminCaller.storage.policy.get()).dynamicPace).toEqual(dynamicPace);
    const audits = await testDb.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(audits.at(-1)!.actorId).toBe(admin.id);
  });

  it('refuses contradictory modes, inverted bounds and a ceiling above the measured hard cap', async () => {
    const loaded = await adminCaller.storage.policy.get();
    for (const patch of [
      { enabled: true, observeOnly: true },
      { floorBytes: 4e12 },
      { ceilingBytes: 3_591_025_375_576 },
    ]) {
      await expect(
        adminCaller.storage.policy.set({
          ...loaded,
          dynamicPace: { ...loaded.dynamicPace!, ...patch },
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('refuses a horizon shorter than the saved window at the settings edge', async () => {
    await setAppSetting({
      db: testDb.db,
      key: 'trash_default_window_days',
      value: 7,
      actorId: admin.id,
    });
    const loaded = await adminCaller.storage.policy.get();
    await expect(
      adminCaller.storage.policy.set({
        ...loaded,
        dynamicPace: { ...loaded.dynamicPace!, horizonDays: 6 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it.each([1, 7, 21, 30, 31, 45, 90, 180, 365])(
    'inactive legacy pace round-trips a %s-day window and disabling controls',
    async (windowDays) => {
      const current = await adminCaller.storage.policy.get();
      const legacy = { ...current };
      delete legacy.dynamicPace;
      await setAppSetting({
        db: testDb.db,
        key: 'space_policy',
        value: { ...legacy, enabled: true, perArray: { haynestower: { enabled: true } } },
        actorId: admin.id,
      });
      await setAppSetting({
        db: testDb.db,
        key: 'trash_default_window_days',
        value: windowDays,
        actorId: admin.id,
      });
      try {
        const loaded = await adminCaller.storage.policy.get();
        expect(loaded.dynamicPace).toMatchObject({
          enabled: false,
          observeOnly: false,
          horizonDays: 30,
        });
        await adminCaller.storage.policy.set({ ...loaded, minCandidates: 2 });
        await adminCaller.storage.policy.set({ ...loaded, enabled: false });
        await adminCaller.storage.policy.set({
          ...loaded,
          perArray: { haynestower: { enabled: false } },
        });
        expect((await adminCaller.storage.policy.get()).dynamicPace).toEqual(loaded.dynamicPace);
        expect((await adminCaller.storage.policy.get()).perArray.haynestower!.enabled).toBe(false);
        // Explicit sizing changes remain validated even while inactive.
        if (windowDays > 30)
          await expect(
            adminCaller.storage.policy.set({
              ...loaded,
              dynamicPace: { ...loaded.dynamicPace!, horizonDays: 29 },
            }),
          ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      } finally {
        await setAppSetting({
          db: testDb.db,
          key: 'trash_default_window_days',
          value: 7,
          actorId: admin.id,
        });
      }
    },
  );

  it.each(['enabled', 'observeOnly'] as const)(
    'a 45-day window refuses activation via %s with the shorter horizon',
    async (mode) => {
      await setAppSetting({
        db: testDb.db,
        key: 'trash_default_window_days',
        value: 45,
        actorId: admin.id,
      });
      try {
        const loaded = await adminCaller.storage.policy.get();
        await expect(
          adminCaller.storage.policy.set({
            ...loaded,
            dynamicPace: {
              ...loaded.dynamicPace!,
              enabled: false,
              observeOnly: false,
              [mode]: true,
              horizonDays: 30,
            },
          }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      } finally {
        await setAppSetting({
          db: testDb.db,
          key: 'trash_default_window_days',
          value: 7,
          actorId: admin.id,
        });
      }
    },
  );

  it.each([false, true])(
    'status reads only stored job data, including with enabled=%s',
    async (enabled) => {
      const loaded = await adminCaller.storage.policy.get();
      await adminCaller.storage.policy.set({
        ...loaded,
        dynamicPace: { ...loaded.dynamicPace!, enabled, observeOnly: false },
      });
      const queryRange = vi.fn(async () => {
        throw new Error('status must not query Prometheus');
      });
      const diskspace = vi.fn(async () => {
        throw new Error('status must not read diskspace');
      });
      const arr = stubArrBundle([]).bundle;
      arr.read.radarr.getDiskSpace = diskspace;
      arr.read.sonarr.getDiskSpace = diskspace;
      arr.read.lidarr.getDiskSpace = diskspace;
      const ctx = makeCtx(testDb.db, sessionUser(admin), arr, undefined, undefined, { queryRange });
      const evaluatedAt = new Date('2026-11-14T07:00:00Z');
      const pace = {
        mode: 'observe-only',
        applied: false,
        fallbackReason: 'stale_series',
        explanation: null,
        selectedBytes: 0,
      };
      await ingestLedgerEvents({
        db: testDb.db,
        source: 'radarr',
        events: [
          {
            eventType: 'trash_space_policy',
            source: 'maintainerr',
            occurredAt: evaluatedAt,
            payload: {
              array: 'haynestower',
              mediaKind: 'movie',
              batchId: null,
              outcome: 'skipped_under_target',
              pace,
            },
          },
        ],
      });
      const status = await caller(ctx).storage.policy.status();
      expect(queryRange).not.toHaveBeenCalled();
      expect(diskspace).not.toHaveBeenCalled();
      expect(status.pace!.arrays[0]!.decisions[0]).toMatchObject({
        ...pace,
        evaluatedAt: evaluatedAt.toISOString(),
        outcome: 'skipped_under_target',
      });
      expect(status.recentProposals).toEqual([]);
    },
  );
});
